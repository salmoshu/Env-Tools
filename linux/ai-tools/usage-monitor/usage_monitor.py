#!/usr/bin/env python3
"""Kimi Code / OpenAI Codex / CodeBuddy 本地终端额度监控（不依赖 Sub2API）。"""

from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager, nullcontext
import calendar
import json
import os
import re
import signal
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

if os.name == "nt":
    import msvcrt
else:
    import select
    import termios
    import tty


KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
KIMI_OAUTH_URL = "https://auth.kimi.com/api/oauth/token"
KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages"
KIMI_WEB_REFRESH_URL = "https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken"
KIMI_WEB_STATS_URL = (
    "https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats"
)
CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
CODEBUDDY_ENDPOINT = "https://www.codebuddy.ai"
CODEBUDDY_DOSAGE_NOTIFY_PATH = "/v2/billing/meter/get-dosage-notify"
CODEBUDDY_RESOURCE_PATH = "/billing/meter/get-user-resource"
CODEBUDDY_REFRESH_PATH = "/v2/auth/token/refresh"
TOKEN_REFRESH_THRESHOLD = 300

# DeepSeek 余额查询：用 API Key（platform.deepseek.com 的 API keys 页面生成），
# 与 /usage 网页看到的余额是同一套账户数据。
DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance"
# 假定每月额度上限为 50 元；余额超过时按 50 元截断后再算百分比。
DEEPSEEK_MONTHLY_LIMIT = 50.0

# 看板标题右侧的 CLI 版本标注：当前版本来自本机 `cmd --version`，最新版本按
# VERSION_CHECK_INTERVAL 周期探测并缓存；有更新时追加黄色的 "→ 新版本号"
KIMI_LATEST_VERSION_URL = "https://code.kimi.com/kimi-code/latest"
NPM_LATEST_VERSION_URL = "https://registry.npmjs.org/{package}/latest"
VERSION_CHECK_INTERVAL = 3600
VERSION_CACHE_PATH = Path.home() / ".cache" / "ai-usage-monitor" / "versions.json"
MONITOR_CONFIG_PATH = Path(__file__).resolve().with_name("config.json")
VERSION_TOOLS = {
    "Kimi Code": {"command": "kimi", "source": "kimi"},
    "OpenAI Codex": {"command": "codex", "source": "npm", "package": "@openai/codex"},
    "CodeBuddy": {"command": "codebuddy", "source": "npm", "package": "@tencent-ai/codebuddy-code"},
}

GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
CYAN = "\033[36m"
DIM = "\033[2m"
RESET = "\033[0m"


class MonitorError(RuntimeError):
    pass


def env_enabled(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise MonitorError(f"Credential file not found: {path}") from exc
    except (OSError, ValueError) as exc:
        raise MonitorError(f"Cannot read credential file {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise MonitorError(f"Invalid credential file format: {path}")
    return data


def write_private_json(path: Path, data: dict[str, Any]) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(str(temporary), 0o600)
    os.replace(str(temporary), str(path))


def kimi_credentials_path(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    if os.environ.get("KIMI_CREDENTIALS_PATH"):
        return Path(os.environ["KIMI_CREDENTIALS_PATH"]).expanduser()

    home = Path.home()
    candidates = []
    if os.environ.get("KIMI_CODE_HOME"):
        candidates.append(
            Path(os.environ["KIMI_CODE_HOME"]).expanduser()
            / "credentials"
            / "kimi-code.json"
        )
    candidates.extend(
        [
            home / ".kimi-code" / "credentials" / "kimi-code.json",
            home / ".kimi" / "credentials" / "kimi-code.json",
        ]
    )
    for path in candidates:
        if path.is_file():
            return path
    return candidates[0]


def codex_credentials_path(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    if os.environ.get("CODEX_AUTH_PATH"):
        return Path(os.environ["CODEX_AUTH_PATH"]).expanduser()
    codex_home = Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser()
    return codex_home / "auth.json"


def monitor_config_path(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    if os.environ.get("AI_USAGE_CONFIG_PATH"):
        return Path(os.environ["AI_USAGE_CONFIG_PATH"]).expanduser()
    return MONITOR_CONFIG_PATH


def read_monitor_config(explicit: str | None = None) -> dict[str, Any]:
    path = monitor_config_path(explicit)
    if not path.is_file():
        return {}
    return read_json(path)


def codebuddy_credentials_path(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    if os.environ.get("CODEBUDDY_AUTH_PATH"):
        return Path(os.environ["CODEBUDDY_AUTH_PATH"]).expanduser()
    return (
        Path.home()
        / ".local"
        / "share"
        / "CodeBuddyExtension"
        / "Data"
        / "Public"
        / "auth"
        / "Tencent-Cloud.coding-copilot.info"
    )


def request_json(
    url: str,
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    timeout: int = 30,
    use_proxy: bool = True,
) -> dict[str, Any]:
    attempts = 3 if data is None else 1
    result = None
    for attempt in range(attempts):
        request = urllib.request.Request(
            url,
            data=data,
            headers=headers or {},
            method="POST" if data is not None else "GET",
        )
        try:
            if use_proxy:
                response_context = urllib.request.urlopen(request, timeout=timeout)
            else:
                # Kimi 在部分本地代理上会发生 TLS EOF；仅为该请求禁用环境代理。
                direct_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                response_context = direct_opener.open(request, timeout=timeout)
            with response_context as response:
                result = json.loads(response.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as exc:
            raise MonitorError(f"HTTP {exc.code}: {exc.reason}") from exc
        except urllib.error.URLError as exc:
            if attempt + 1 == attempts:
                raise MonitorError(f"Network request failed (retried {attempts} times): {exc.reason}") from exc
            time.sleep(attempt + 1)
        except OSError as exc:
            if attempt + 1 == attempts:
                raise MonitorError(f"Network request failed (retried {attempts} times): {exc}") from exc
            time.sleep(attempt + 1)
        except ValueError as exc:
            raise MonitorError(f"Invalid API response: {exc}") from exc
    if not isinstance(result, dict):
        raise MonitorError("API response is not a JSON object")
    return result


def refresh_kimi_credentials(path: Path, credentials: dict[str, Any]) -> dict[str, Any]:
    refresh_token = credentials.get("refresh_token")
    if not refresh_token:
        raise MonitorError("Kimi credentials expired and refresh_token is missing; run kimi and log in again")

    payload = urllib.parse.urlencode(
        {
            "client_id": KIMI_CLIENT_ID,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        }
    ).encode("utf-8")
    result = request_json(
        KIMI_OAUTH_URL,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data=payload,
        use_proxy=env_enabled("KIMI_USE_PROXY"),
        timeout=int(os.environ.get("KIMI_TIMEOUT", "30")),
    )
    credentials.update(
        {
            "access_token": result["access_token"],
            "refresh_token": result.get("refresh_token", refresh_token),
            "expires_at": time.time() + float(result["expires_in"]),
            "expires_in": result["expires_in"],
            "scope": result.get("scope", credentials.get("scope", "kimi-code")),
            "token_type": result.get("token_type", "Bearer"),
        }
    )
    write_private_json(path, credentials)
    return credentials


def fetch_kimi(path: Path) -> dict[str, Any]:
    credentials = read_json(path)
    expires_at = float(credentials.get("expires_at") or 0)
    if expires_at - time.time() < TOKEN_REFRESH_THRESHOLD:
        credentials = refresh_kimi_credentials(path, credentials)
    access_token = credentials.get("access_token")
    if not access_token:
        raise MonitorError("access_token missing in Kimi credentials; run kimi and log in again")
    return request_json(
        os.environ.get("KIMI_USAGE_URL", KIMI_USAGE_URL),
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
        },
        use_proxy=env_enabled("KIMI_USE_PROXY"),
        timeout=int(os.environ.get("KIMI_TIMEOUT", "30")),
    )


def kimi_web_credentials_path(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    if os.environ.get("KIMI_WEB_CREDENTIALS_PATH"):
        return Path(os.environ["KIMI_WEB_CREDENTIALS_PATH"]).expanduser()
    # 默认与 kimi-code.json 同目录（~/.kimi-code/credentials/kimi-web.json）
    return kimi_credentials_path().with_name("kimi-web.json")


def _jwt_expires_at(token: str) -> float:
    """不验签地读取 JWT 的 exp（秒），解析失败返回 0。"""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        return float(data.get("exp") or 0)
    except (IndexError, TypeError, ValueError):
        return 0.0


def refresh_kimi_web_credentials(path: Path, credentials: dict[str, Any]) -> dict[str, Any]:
    refresh_token = credentials.get("refresh_token")
    if not refresh_token:
        raise MonitorError("refresh_token missing in Kimi web credentials; copy it again from the browser (see docs/usage-monitor.md)")
    result = request_json(
        KIMI_WEB_REFRESH_URL,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        data=json.dumps({"refresh_token": refresh_token}).encode("utf-8"),
        use_proxy=env_enabled("KIMI_USE_PROXY"),
        timeout=int(os.environ.get("KIMI_TIMEOUT", "30")),
    )
    access_token = result.get("access_token") or result.get("accessToken")
    if not access_token:
        raise MonitorError("Failed to refresh Kimi web credentials; copy refresh_token again from the browser (see docs/usage-monitor.md)")
    credentials.update(
        {
            "access_token": access_token,
            "refresh_token": result.get("refresh_token")
            or result.get("refreshToken")
            or refresh_token,
        }
    )
    write_private_json(path, credentials)
    return credentials


def _fetch_kimi_web_stats(access_token: str) -> dict[str, Any]:
    return request_json(
        os.environ.get("KIMI_WEB_STATS_URL", KIMI_WEB_STATS_URL),
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-msh-platform": "web",
        },
        data=b"{}",
        use_proxy=env_enabled("KIMI_USE_PROXY"),
        timeout=int(os.environ.get("KIMI_TIMEOUT", "30")),
    )


def fetch_kimi_web(path: Path) -> dict[str, Any]:
    """网页版会员统计（月总量），走 kimi.com 网关，需要网页登录态。"""
    credentials = read_json(path)
    access_token = str(credentials.get("access_token") or "")
    if _jwt_expires_at(access_token) - time.time() < TOKEN_REFRESH_THRESHOLD:
        credentials = refresh_kimi_web_credentials(path, credentials)
        access_token = str(credentials.get("access_token") or "")
    if not access_token:
        raise MonitorError("access_token missing in Kimi web credentials; configure kimi-web.json (see docs/usage-monitor.md)")
    try:
        return _fetch_kimi_web_stats(access_token)
    except MonitorError as exc:
        if "HTTP 401" in str(exc):
            credentials = refresh_kimi_web_credentials(path, credentials)
            return _fetch_kimi_web_stats(str(credentials["access_token"]))
        raise


def codex_auto_login() -> bool:
    """尝试自动执行 codex login，返回是否成功。"""
    commands = [
        ["codex", "login", "--device-auth"],  # 无浏览器/远程环境优先
        ["codex", "login"],                  # 本地浏览器回退
    ]
    for command in commands:
        try:
            print(f"Trying: {' '.join(command)}", file=sys.stderr)
            result = subprocess.run(command, check=False, timeout=600)
            if result.returncode == 0:
                return True
        except FileNotFoundError:
            print("codex command not found; install OpenAI Codex CLI first", file=sys.stderr)
            return False
        except subprocess.TimeoutExpired:
            print("codex login timed out (10 minutes)", file=sys.stderr)
            return False
    return False


def fetch_codex(path: Path, auto_login: bool = True) -> dict[str, Any]:
    try:
        return _fetch_codex(path)
    except MonitorError as exc:
        error_text = str(exc)
        need_login = any(
            keyword in error_text
            for keyword in ("Credential file not found", "access_token missing", "HTTP 401", "login expired")
        )
        if auto_login and need_login:
            print(f"Codex credential problem detected: {exc}", file=sys.stderr)
            print("Starting automatic login...", file=sys.stderr)
            if codex_auto_login():
                return _fetch_codex(path)
            raise MonitorError("Codex automatic login failed; run `codex login` manually") from exc
        raise


def _fetch_codex(path: Path) -> dict[str, Any]:
    credentials = read_json(path)
    tokens = credentials.get("tokens") or {}
    access_token = tokens.get("access_token")
    account_id = tokens.get("account_id")
    if not access_token:
        raise MonitorError("access_token missing in Codex credentials; run `codex login`")

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
        "User-Agent": "codex-usage-monitor/1.0",
    }
    if account_id:
        headers["ChatGPT-Account-Id"] = str(account_id)
    try:
        return request_json(
            os.environ.get("CODEX_USAGE_URL", CODEX_USAGE_URL),
            headers=headers,
            use_proxy=env_enabled("CODEX_USE_PROXY", default=True),
            timeout=int(os.environ.get("CODEX_TIMEOUT", "30")),
        )
    except MonitorError as exc:
        error_text = str(exc)
        if "HTTP 401" in error_text:
            raise MonitorError(
                "Codex login expired; run `codex login` and retry"
            ) from exc
        if any(
            keyword in error_text.lower()
            for keyword in ("timed out", "connection reset", "network is unreachable")
        ):
            raise MonitorError(
                "Cannot reach chatgpt.com; check proxy/DNS/network (a proxy is required in mainland China)"
            ) from exc
        raise


def _epoch_seconds(value: Any) -> float:
    """把秒/毫秒级时间戳统一为秒，非法值返回 0。"""
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return 0.0
    if numeric > 10_000_000_000:
        numeric /= 1000
    return numeric


def codebuddy_endpoint(credentials: dict[str, Any] | None = None) -> str:
    """API 地址：环境变量优先，其次取凭证里的 auth.domain（区分 .cn/.ai 站点）。"""
    if os.environ.get("CODEBUDDY_ENDPOINT"):
        return os.environ["CODEBUDDY_ENDPOINT"].rstrip("/")
    domain = ((credentials or {}).get("auth") or {}).get("domain")
    if domain:
        return f"https://{str(domain).strip()}"
    return CODEBUDDY_ENDPOINT


def refresh_codebuddy_credentials(path: Path, credentials: dict[str, Any]) -> dict[str, Any]:
    auth = credentials.get("auth") or {}
    refresh_token = auth.get("refreshToken")
    if not refresh_token:
        raise MonitorError("CodeBuddy credentials expired and refreshToken is missing; run codebuddy and execute /login")
    result = request_json(
        codebuddy_endpoint(credentials) + CODEBUDDY_REFRESH_PATH,
        headers={
            "X-Refresh-Token": str(refresh_token),
            "X-Auth-Refresh-Source": "plugin",
            "Accept": "application/json",
        },
        data=b"",
        timeout=int(os.environ.get("CODEBUDDY_TIMEOUT", "30")),
    )
    data = result.get("data") or {}
    new_token = data.get("accessToken") or data.get("access_token")
    if result.get("code") != 0 or not new_token:
        raise MonitorError("Failed to refresh CodeBuddy credentials; run codebuddy and execute /login")
    auth.update(data)
    auth["accessToken"] = new_token
    credentials["auth"] = auth
    write_private_json(path, credentials)
    return credentials


def fetch_codebuddy(path: Path) -> dict[str, Any]:
    try:
        credentials = read_json(path)
    except MonitorError as exc:
        raise MonitorError(f"CodeBuddy not logged in ({exc}); run codebuddy and execute /login") from exc
    auth = credentials.get("auth") or {}
    account = credentials.get("account") or {}
    if str(auth.get("tokenType", "")) == "ApiKey":
        raise MonitorError("CodeBuddy is in ApiKey mode, which does not support usage queries")
    expires_at = _epoch_seconds(auth.get("expiresAt"))
    if expires_at and expires_at - time.time() < TOKEN_REFRESH_THRESHOLD:
        credentials = refresh_codebuddy_credentials(path, credentials)
        auth = credentials.get("auth") or {}
    access_token = auth.get("accessToken")
    if not access_token:
        raise MonitorError("accessToken missing in CodeBuddy credentials; run codebuddy and execute /login")

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
        "X-Product": "SaaS",
    }
    uid = account.get("uid")
    if uid:
        headers["X-User-Id"] = str(uid)
    result = request_json(
        codebuddy_endpoint(credentials) + CODEBUDDY_DOSAGE_NOTIFY_PATH,
        headers=headers,
        data=b"",
        timeout=int(os.environ.get("CODEBUDDY_TIMEOUT", "30")),
    )
    if result.get("code") != 0:
        message = result.get("message") or result.get("msg") or f"code={result.get('code')}"
        raise MonitorError(f"CodeBuddy usage query failed: {message}")

    # 额度主接口（plans-usage 网页的数据源）：失败时降级为只显示用量提醒
    resource = None
    resource_error = None
    try:
        body = json.dumps(
            {
                "PageNumber": 1,
                "PageSize": 200,
                "ProductCode": os.environ.get("CODEBUDDY_PRODUCT_CODE", "p_tcaca"),
                "Status": [0, 3],  # 0=valid 3=usedUp
                "OnlyValidPeriod": True,
                "PackageCodes": [],
            }
        ).encode("utf-8")
        resource_resp = request_json(
            codebuddy_endpoint(credentials) + CODEBUDDY_RESOURCE_PATH,
            headers=headers,
            data=body,
            timeout=int(os.environ.get("CODEBUDDY_TIMEOUT", "30")),
        )
        if resource_resp.get("code") == 0:
            resource = ((resource_resp.get("data") or {}).get("Response") or {}).get("Data") or {}
        else:
            resource_error = f"code={resource_resp.get('code')}"
    except MonitorError as exc:
        resource_error = str(exc)
    return {
        "account": account,
        "notify": result.get("data") or {},
        "domain": auth.get("domain") or "www.codebuddy.ai",
        "resource": resource,
        "resource_error": resource_error,
    }


def deepseek_credentials_path(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    env = os.environ.get("DEEPSEEK_CREDENTIALS_PATH")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".deepseek" / "credentials.json"


def deepseek_api_key(explicit: str | None = None, credentials_path: str | None = None) -> str:
    if explicit:
        return explicit
    key = os.environ.get("DEEPSEEK_API_KEY")
    if key:
        return key
    path = Path(credentials_path).expanduser() if credentials_path else deepseek_credentials_path()
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise MonitorError(f"Cannot read DeepSeek credentials file {path}: {exc}")
        key = data.get("api_key") or data.get("DEEPSEEK_API_KEY")
        if not key:
            raise MonitorError(f"DeepSeek credentials file {path} is missing api_key")
        return key
    raise MonitorError(
        "DEEPSEEK_API_KEY not set; export it, write it to ~/.deepseek/credentials.json, or pass --deepseek-key"
    )


def fetch_deepseek(key: str | None = None, credentials_path: str | None = None) -> dict[str, Any]:
    api_key = deepseek_api_key(key, credentials_path)
    return request_json(
        os.environ.get("DEEPSEEK_BALANCE_URL", DEEPSEEK_BALANCE_URL),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
        },
        use_proxy=env_enabled("DEEPSEEK_USE_PROXY", default=True),
        timeout=int(os.environ.get("DEEPSEEK_TIMEOUT", "30")),
    )


def normalize_deepseek(data: dict[str, Any]) -> dict[str, Any]:
    infos = data.get("balance_infos") or []
    balance = next(
        (b for b in infos if str(b.get("currency") or "").upper() == "CNY"),
        None,
    )
    if balance is None:
        balance = infos[0] if infos else {}
    total = _num(balance.get("total_balance"))
    granted = _num(balance.get("granted_balance"))
    topped_up = _num(balance.get("topped_up_balance"))
    # 进度条口径与其它模型保持一致:余额转为使用量(50 - 余额),低于 0 时截断为 0
    usage = max(0.0, DEEPSEEK_MONTHLY_LIMIT - total)
    capped = min(usage, DEEPSEEK_MONTHLY_LIMIT)
    fill_percent = percent(used=capped * 100 / DEEPSEEK_MONTHLY_LIMIT)
    extra_lines = [
        f"Balance: ¥{total:.2f} / ¥{DEEPSEEK_MONTHLY_LIMIT:.2f}",
        f"Usage: ¥{usage:.2f} / ¥{DEEPSEEK_MONTHLY_LIMIT:.2f}",
        f"Granted: ¥{granted:.2f}   Topped-up: ¥{topped_up:.2f}",
    ]
    if not data.get("is_available", True):
        extra_lines.append("Account unavailable")
    return {
        "provider": "DeepSeek",
        "plan": "API",
        "windows": [
            {
                "label": "Monthly Usage",
                "used_percent": fill_percent,
                "reset_after_seconds": None,
                "window_seconds": None,
                "usage": f"¥{capped:.2f}",
                "until_used_up": True,
            }
        ],
        "extra_lines": extra_lines,
        "fetched_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }


def percent(
    used: Any = None,
    remaining: Any = None,
    limit: Any = None,
    used_amount: Any = None,
) -> float:
    if used is not None:
        try:
            return max(0.0, min(100.0, float(used)))
        except (TypeError, ValueError):
            pass
    try:
        limit_value = float(limit)
        if limit_value > 0:
            if used_amount is not None:
                try:
                    return max(
                        0.0,
                        min(100.0, float(used_amount) * 100 / limit_value),
                    )
                except (TypeError, ValueError):
                    pass
            remaining_value = float(remaining)
            return max(0.0, min(100.0, (limit_value - remaining_value) * 100 / limit_value))
    except (TypeError, ValueError):
        pass
    return 0.0


def seconds_until(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        if isinstance(value, (int, float)):
            numeric = float(value)
            if numeric > 10_000_000_000:
                numeric /= 1000
            return max(0, int(numeric - time.time()))
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return max(0, int((parsed - datetime.now(timezone.utc)).total_seconds()))
    except (TypeError, ValueError):
        return None


def parse_timestamp(value: Any) -> datetime | None:
    """解析时间戳（秒/毫秒 epoch 或 ISO 字符串）为 datetime，失败返回 None。"""
    if value in (None, ""):
        return None
    try:
        if isinstance(value, (int, float)):
            numeric = float(value)
            if numeric > 10_000_000_000:
                numeric /= 1000
            return datetime.fromtimestamp(numeric, tz=timezone.utc)
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def one_month_before(moment: datetime) -> datetime:
    """同一时刻往前推一个自然月（处理月末溢出，如 3/31 → 2/28）。"""
    year, month = (moment.year - 1, 12) if moment.month == 1 else (moment.year, moment.month - 1)
    day = min(moment.day, calendar.monthrange(year, month)[1])
    return moment.replace(year=year, month=month, day=day)


def add_calendar_months(moment: datetime, months: int) -> datetime:
    """Move forward by whole calendar months, clamping month-end dates."""
    month_index = moment.year * 12 + moment.month - 1 + months
    year, zero_based_month = divmod(month_index, 12)
    month = zero_based_month + 1
    day = min(moment.day, calendar.monthrange(year, month)[1])
    return moment.replace(year=year, month=month, day=day)


def monthly_window_seconds(reset_at: datetime) -> int:
    """按月周期的窗口总长：重置时间与前一个月同一时刻之差（28~31 天自适应）。"""
    return int((reset_at - one_month_before(reset_at)).total_seconds())


def normalize_window(
    label: str,
    data: dict[str, Any],
    default_seconds: int | None = None,
) -> dict[str, Any]:
    reset_after = data.get("reset_after_seconds")
    if reset_after is None:
        reset_after = seconds_until(data.get("reset_at") or data.get("resetTime"))
    try:
        reset_after = None if reset_after is None else max(0, int(float(reset_after)))
    except (TypeError, ValueError):
        reset_after = None
    window_seconds = data.get("limit_window_seconds", default_seconds)
    return {
        "label": label,
        "used_percent": percent(
            data.get("used_percent"),
            data.get("remaining"),
            data.get("limit"),
            data.get("used"),
        ),
        "reset_after_seconds": reset_after,
        "window_seconds": window_seconds,
    }


def normalize_kimi(data: dict[str, Any]) -> dict[str, Any]:
    windows = []
    limits = data.get("limits") or []
    for item in limits:
        meta = item.get("window") or {}
        detail = item.get("detail") or {}
        duration = int(meta.get("duration") or 0)
        unit = str(meta.get("timeUnit") or "").lower()
        seconds = duration * (3600 if "hour" in unit else 60)
        label = f"{duration}h Window" if "hour" in unit else f"{duration}m Window"
        if duration == 300 and "minute" in unit:
            label = "5h Window"
        windows.append(normalize_window(label, detail, seconds or None))

    weekly = data.get("usage") or {}
    windows.append(normalize_window("7d Window", weekly, 7 * 86400))
    user = data.get("user") or {}
    membership = user.get("membership") or {}
    return {
        "provider": "Kimi Code",
        "plan": membership.get("level") or data.get("subType") or "unknown",
        "windows": windows,
        "fetched_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }


def _ratio_percent(value: Any) -> float | None:
    """网页接口的用量比例：0~1 的小数转成百分比，非法值返回 None。"""
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not 0 <= numeric <= 100:
        return None
    if numeric <= 1:
        numeric *= 100
    return max(0.0, min(100.0, numeric))


def normalize_kimi_monthly(stats: dict[str, Any]) -> dict[str, Any] | None:
    """从网页版 GetSubscriptionStats 提取月总量（subscription_balance）。

    返回 {"window": ..., "extra_lines": [...]}；无订阅余额时返回 None。
    """
    balance = stats.get("subscription_balance") or stats.get("subscriptionBalance") or {}
    if not balance:
        return None
    used_percent = _ratio_percent(
        balance.get("amount_used_ratio", balance.get("amountUsedRatio"))
    )
    if used_percent is None:
        return None
    expire_at = parse_timestamp(balance.get("expire_time") or balance.get("expireTime"))
    window = {
        "label": "Monthly Total",
        "used_percent": used_percent,
        "reset_after_seconds": seconds_until(
            balance.get("expire_time") or balance.get("expireTime")
        ),
        # 月度重置：窗口起点按重置时间往前推一个自然月估算
        "window_seconds": monthly_window_seconds(expire_at) if expire_at else None,
    }
    extra_lines = []
    code_percent = _ratio_percent(
        balance.get("kimi_code_used_ratio", balance.get("kimiCodeUsedRatio"))
    )
    if code_percent is not None:
        extra_lines.append(f"Kimi Code share: {code_percent:.2f}%")
    return {"window": window, "extra_lines": extra_lines}


def normalize_openai_membership(
    config: Any,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    if not isinstance(config, dict):
        return None
    purchased_value = config.get("membership_purchased_at")
    if not purchased_value:
        return None
    purchased_at = parse_timestamp(purchased_value)
    if purchased_at is None:
        return {"error": "Invalid membership_purchased_at in config.json"}
    if purchased_at.tzinfo is None:
        purchased_at = purchased_at.astimezone()
    else:
        purchased_at = purchased_at.astimezone()
    try:
        duration_months = max(1, int(config.get("membership_duration_months", 1)))
    except (TypeError, ValueError):
        return {"error": "Invalid membership_duration_months in config.json"}
    ends_at = add_calendar_months(purchased_at, duration_months)
    current = now or datetime.now().astimezone()
    if current.tzinfo is None:
        current = current.astimezone()
    return {
        "purchased_at": purchased_at.isoformat(timespec="seconds"),
        "ends_at": ends_at.isoformat(timespec="seconds"),
        "end_after_seconds": int((ends_at - current).total_seconds()),
        "duration_months": duration_months,
    }


def normalize_codex(
    data: dict[str, Any],
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rate_limit = data.get("rate_limit") or data.get("rateLimit") or {}
    primary = rate_limit.get("primary_window") or rate_limit.get("primaryWindow") or {}
    secondary = rate_limit.get("secondary_window") or rate_limit.get("secondaryWindow") or {}
    reset_credits = (
        data.get("rate_limit_reset_credits")
        or data.get("rateLimitResetCredits")
        or {}
    )
    windows = []
    if primary:
        seconds = int(primary.get("limit_window_seconds") or 0)
        windows.append(normalize_window(window_label(seconds, "Primary Window"), primary, seconds))
    if secondary:
        seconds = int(secondary.get("limit_window_seconds") or 0)
        windows.append(normalize_window(window_label(seconds, "Secondary Window"), secondary, seconds))
    result = {
        "provider": "OpenAI Codex",
        "plan": data.get("plan_type") or data.get("planType") or "unknown",
        "windows": windows,
        "credits": data.get("credits"),
        "fetched_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    if isinstance(reset_credits, dict) and reset_credits:
        available = reset_credits.get(
            "available_count", reset_credits.get("availableCount")
        )
        applicable = reset_credits.get(
            "applicable_available_count",
            reset_credits.get("applicableAvailableCount"),
        )
        normalized_reset_credits = {}
        for key, value in (
            ("available_count", available),
            ("applicable_available_count", applicable),
        ):
            try:
                normalized_reset_credits[key] = max(0, int(value))
            except (TypeError, ValueError):
                pass
        if normalized_reset_credits:
            result["rate_limit_reset_credits"] = normalized_reset_credits
    membership = normalize_openai_membership(config)
    if membership:
        result["membership"] = membership
    return result


def _num(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _parse_local_datetime(text: Any) -> datetime | None:
    """把 'YYYY-MM-DD HH:MM:SS' 按本地时区解析，失败返回 None。"""
    try:
        return datetime.strptime(str(text), "%Y-%m-%d %H:%M:%S").astimezone()
    except (TypeError, ValueError):
        return None


def _is_gift_pack(account: dict[str, Any]) -> bool:
    """赠送包：SubProductCode 含 bonus（如 sp_tcaca_codebuddyide_bonus_pack）。"""
    return "bonus" in str(account.get("SubProductCode") or "").lower()


def _is_used_up(account: dict[str, Any]) -> bool:
    """赠送包用完后 CycleCapacityRemainPrecise ≤ 0，不再计入可用能量。"""
    return _num(account.get("CycleCapacityRemainPrecise")) <= 0


def normalize_codebuddy(data: dict[str, Any]) -> dict[str, Any]:
    account = data.get("account") or {}
    notify = data.get("notify") or {}
    resource = data.get("resource") or {}
    accounts = resource.get("Accounts") or []
    now = datetime.now().astimezone()

    extra_lines = []
    windows: list[dict[str, Any]] = []
    total_line = None
    if accounts:
        # 周期额度：订阅计划与赠送包分开汇总（赠送包 SubProductCode 含 bonus）；
        # 赠送包为一次性额度，已用完（剩余 ≤ 0）的包不再计入能量统计；
        # 到期/重置时间取各自组内仍有余量的最早周期结束点
        subscription = [a for a in accounts if not _is_gift_pack(a)]
        gifted = [a for a in accounts if _is_gift_pack(a) and not _is_used_up(a)]

        def _cycle_window(label, group, expire):
            size = sum(_num(a.get("CycleCapacitySizePrecise")) for a in group)
            if size <= 0:
                return None
            used = sum(_num(a.get("CycleCapacityUsedPrecise")) for a in group)
            with_remain = [a for a in group if _num(a.get("CycleCapacityRemainPrecise")) > 0]
            ends = [_parse_local_datetime(a.get("CycleEndTime")) for a in (with_remain or group)]
            ends = [e for e in ends if e is not None]
            reset_after = max(0, int((min(ends) - now).total_seconds())) if ends else None
            return {
                "label": label,
                "used_percent": percent(used=used * 100 / size),
                "reset_after_seconds": reset_after,
                # 订阅按月续期：窗口起点按周期结束时间往前推一个自然月估算；
                # 赠送包是一次性额度、周期未知，不推算
                "window_seconds": (
                    monthly_window_seconds(min(ends)) if not expire and ends else None
                ),
                "expire": expire,
            }

        # 订阅计划按月续期（resets）；赠送包为一次性额度，到期作废（expires）
        for label, group, expire in (
            ("Subscription", subscription, False),
            ("Gifted", gifted, True),
        ):
            window = _cycle_window(label, group, expire)
            if window:
                windows.append(window)

        # 总额度一行汇总（订阅 + 赠送），展示在 Updated 之前
        def _cycle_sum(group):
            used = sum(_num(a.get("CycleCapacityUsedPrecise")) for a in group)
            size = sum(_num(a.get("CycleCapacitySizePrecise")) for a in group)
            return used, size

        parts = []
        for name, group in (("sub", subscription), ("gift", gifted)):
            used, size = _cycle_sum(group)
            if size > 0:
                parts.append(f"{name} {used:.1f}/{size:.1f}")
        total_used, total_size = _cycle_sum(subscription + gifted)
        if total_size > 0:
            total_line = f"Total: {total_used:.1f}/{total_size:.1f} credits"
            if parts:
                total_line += f" ({', '.join(parts)})"
    elif data.get("resource_error"):
        extra_lines.append(f"Quota API unavailable: {data['resource_error']}")

    notice = notify.get("dosageNotifyEn")
    if notice:
        extra_lines.append(f"Usage notice: {notice}")
        if notify.get("skipUrl"):
            extra_lines.append(f"Details: {notify['skipUrl']}")
    if total_line:
        extra_lines.append(total_line)

    return {
        "provider": "CodeBuddy",
        "plan": account.get("type") or "unknown",
        "windows": windows,
        "extra_lines": extra_lines,
        "fetched_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }


def window_label(seconds: int, fallback: str) -> str:
    if 4 * 3600 <= seconds <= 6 * 3600:
        return "5h Window"
    if 6 * 86400 <= seconds <= 8 * 86400:
        return "7d Window"
    if seconds and seconds % 86400 == 0:
        return f"{seconds // 86400}d Window"
    if seconds and seconds % 3600 == 0:
        return f"{seconds // 3600}h Window"
    return fallback


def duration_text(seconds: int | None, expire: bool = False, until_used_up: bool = False) -> str:
    if until_used_up:
        return "until used up"
    verb = "expires" if expire else "resets"
    if seconds is None:
        return f"{verb} at unknown time"
    if seconds <= 0:
        return f"{verb} soon"
    days, remainder = divmod(seconds, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes = remainder // 60
    if days:
        return f"{verb} in {days}d {hours}h"
    if hours:
        return f"{verb} in {hours}h {minutes}m"
    return f"{verb} in {minutes}m"


def rate_limit_reset_text(reset_credits: Any) -> str | None:
    """Format OpenAI's manually usable usage-limit reset credits."""
    if not isinstance(reset_credits, dict):
        return None
    available = reset_credits.get("available_count")
    applicable = reset_credits.get("applicable_available_count")
    if available is None and applicable is None:
        return None
    parts = []
    if available is not None:
        parts.append(f"{available} remaining")
    if applicable is not None:
        if applicable > 0:
            parts.append(f"{applicable} usable now")
        else:
            parts.append("Not usable until limit reached")
    return "Reset chance: " + " · ".join(parts)


def compact_duration(seconds: int) -> str:
    seconds = max(0, int(seconds))
    days, remainder = divmod(seconds, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes = remainder // 60
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def membership_end_text(seconds: int) -> str:
    return (
        f"ends in {compact_duration(seconds)}"
        if seconds >= 0
        else f"ended {compact_duration(-seconds)} ago"
    )


def bar(value: float, width: int = 28, color: bool = True, time_fraction: float | None = None) -> str:
    value = max(0.0, min(100.0, value))
    filled = int(width * value / 100)
    chars = ["█"] * filled + ["░"] * (width - filled)
    if time_fraction is not None:
        # 用 | 标出当前时间在窗口内的位置，便于对比用量进度与时间进度
        marker = min(width - 1, max(0, int(width * time_fraction)))
        chars[marker] = "|"
    content = "".join(chars)
    tone = GREEN if value < 50 else (YELLOW if value < 80 else RED)
    if color:
        return f"{tone}[{content}] {value:5.1f}%{RESET}"
    return f"[{content}] {value:5.1f}%"


def window_time_fraction(window: dict[str, Any]) -> float | None:
    """当前时间在配额窗口内走过的比例（0~1），由窗口总长与剩余时间推算。"""
    window_seconds = window.get("window_seconds")
    reset_after = window.get("reset_after_seconds")
    if not window_seconds or window_seconds <= 0 or reset_after is None:
        return None
    return min(1.0, max(0.0, (window_seconds - reset_after) / window_seconds))


def display_width(text: str) -> int:
    """Return the number of terminal columns occupied by plain text."""
    return sum(
        0 if unicodedata.combining(char) else 2 if unicodedata.east_asian_width(char) in ("F", "W") else 1
        for char in text
    )


def display_ljust(text: str, width: int) -> str:
    return text + " " * max(0, width - display_width(text))


def display_timestamp(value: Any) -> str:
    """Format an ISO timestamp for compact terminal display."""
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return str(value)
    return parsed.strftime("%Y-%m-%d %H:%M:%S")


def _semver_match(text: Any) -> str | None:
    match = re.search(r"\d+\.\d+\.\d+", str(text or ""))
    return match.group(0) if match else None


def _semver_key(text: str) -> tuple[int, ...]:
    return tuple(int(part) for part in text.split("."))


def detect_cli_version(command: str) -> str | None:
    """本机已安装 CLI 的版本（取 --version 输出中的首个 x.y.z）；未安装返回 None。"""
    try:
        completed = subprocess.run(
            f"{command} --version",
            shell=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return _semver_match(completed.stdout) or _semver_match(completed.stderr)


def _request_text(url: str, use_proxy: bool = True, timeout: int = 10) -> str | None:
    try:
        request = urllib.request.Request(url)
        if use_proxy:
            response_context = urllib.request.urlopen(request, timeout=timeout)
        else:
            # 与额度接口同一约定：部分本地代理对 kimi 域名会 TLS EOF，默认直连
            direct_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            response_context = direct_opener.open(request, timeout=timeout)
        with response_context as response:
            return response.read().decode("utf-8").strip()
    except (OSError, ValueError):
        return None


def fetch_latest_version(tool: dict[str, str]) -> str | None:
    if tool["source"] == "kimi":
        return _semver_match(_request_text(KIMI_LATEST_VERSION_URL, use_proxy=env_enabled("KIMI_USE_PROXY")))
    text = _request_text(NPM_LATEST_VERSION_URL.format(package=tool["package"]))
    if not text:
        return None
    try:
        return _semver_match(json.loads(text).get("version"))
    except ValueError:
        return None


def _load_version_cache() -> dict[str, Any]:
    try:
        return json.loads(VERSION_CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_version_cache(cache: dict[str, Any]) -> None:
    try:
        VERSION_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        VERSION_CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass


def collect_versions(providers: set[str]) -> dict[str, dict[str, str | None]]:
    """各 CLI 的当前/最新版本；当前版本每次实时检测，仅最新版本按小时缓存。"""
    cache = _load_version_cache()
    now = time.time()
    versions: dict[str, dict[str, str | None]] = {}
    dirty = False
    for provider in providers:
        tool = VERSION_TOOLS.get(provider)
        if not tool:
            continue
        entry = cache.get(provider) or {}
        # 本地 `cmd --version` 开销极小，每次实时检测，升级 CLI 后标注立即刷新
        current = detect_cli_version(tool["command"]) or entry.get("current")
        if now - float(entry.get("checked_at") or 0) < VERSION_CHECK_INTERVAL:
            latest = entry.get("latest")
            checked_at = entry.get("checked_at")
        else:
            # 远程探测失败（离线等）时沿用旧值，仅刷新探测时间戳做小时级退避
            latest = fetch_latest_version(tool) or entry.get("latest")
            checked_at = now
        if current != entry.get("current") or checked_at != entry.get("checked_at"):
            dirty = True
        cache[provider] = {"current": current, "latest": latest, "checked_at": checked_at}
        versions[provider] = {"current": current, "latest": latest}
    if dirty:
        _save_version_cache(cache)
    return versions


def version_badge(provider: str, versions: dict[str, Any] | None, color: bool) -> str:
    """标题右侧的版本标注，如 `Kimi Code (0.30.0 → 0.33.0)`；有更新时新版本号黄色。"""
    info = (versions or {}).get(provider) or {}
    current = info.get("current")
    if not current:
        return ""
    latest = info.get("latest")
    outdated = bool(latest) and _semver_key(latest) > _semver_key(current)
    if not outdated:
        return f" ({current})"
    if color:
        # 外层标题整体是 CYAN，新版本号标黄后需切回 CYAN
        return f" ({current} {YELLOW}→ {latest}{CYAN})"
    return f" ({current} → {latest})"


def render(results: list[dict[str, Any]], errors: list[dict[str, str]], color: bool, versions: dict[str, Any] | None = None) -> str:
    lines = ["AI Usage Monitor", "═" * 62]
    for result in results:
        heading = f"{result['provider']}{version_badge(result['provider'], versions, color)}  ·  {result['plan']}"
        lines.append(f"{CYAN}{heading}{RESET}" if color else heading)
        windows = result.get("windows") or []
        extra_lines = result.get("extra_lines") or []
        if not windows and not extra_lines:
            lines.append("  No recognizable quota windows")
        for window in windows:
            time_fraction = window_time_fraction(window)
            line = (
                f"  {display_ljust(window['label'], 16)} "
                f"{bar(window['used_percent'], color=color, time_fraction=time_fraction)}  "
                f"{duration_text(window['reset_after_seconds'], expire=bool(window.get('expire')), until_used_up=bool(window.get('until_used_up')))}"
            )
            if window.get("detail"):
                line += f"  {DIM if color else ''}{window['detail']}{RESET if color else ''}"
            lines.append(line)
        for extra in extra_lines:
            lines.append(f"  {extra}")
        reset_text = rate_limit_reset_text(result.get("rate_limit_reset_credits"))
        if reset_text:
            reset_credits = result["rate_limit_reset_credits"]
            ready = (reset_credits.get("applicable_available_count") or 0) > 0
            tone = GREEN if color and ready else ""
            lines.append(f"  {tone}{reset_text}{RESET if tone else ''}")
        membership = result.get("membership")
        if isinstance(membership, dict):
            if membership.get("error"):
                lines.append(f"  {RED if color else ''}Membership: {membership['error']}{RESET if color else ''}")
            elif membership.get("purchased_at") and membership.get("ends_at"):
                purchased = display_timestamp(membership["purchased_at"])
                ends = display_timestamp(membership["ends_at"])
                end_after = int(membership.get("end_after_seconds") or 0)
                status = membership_end_text(end_after)
                tone = RED if color and end_after < 0 else (YELLOW if color else "")
                lines.append(f"  Membership purchased: {purchased}")
                lines.append(f"  {tone}Membership ends: {ends} ({status}){RESET if tone else ''}")
        credits = result.get("credits")
        if isinstance(credits, dict) and credits:
            balance = credits.get("balance")
            if balance is not None:
                lines.append(f"  Credits: {balance}")
        fetched_at = display_timestamp(result["fetched_at"])
        lines.append(f"  {DIM if color else ''}Updated: {fetched_at}{RESET if color else ''}")
        lines.append("")
    for error in errors:
        message = f"{error['provider']}: {error['error']}"
        lines.append(f"{RED}Error: {message}{RESET}" if color else f"Error: {message}")
    return "\n".join(lines).rstrip()


def persistent_watch_errors(errors: list[dict[str, str]]) -> list[dict[str, str]]:
    """Hide Kimi monthly failures after their brief watch-mode notification."""
    return [error for error in errors if error.get("provider") != "Kimi Monthly Total"]


def collect(args: argparse.Namespace) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    results = []
    errors = []
    try:
        monitor_config = read_monitor_config(getattr(args, "config", None))
    except MonitorError as exc:
        monitor_config = {}
        errors.append({"provider": "OpenAI Codex", "error": f"Config: {exc}"})
    if args.provider in ("all", "kimi"):
        try:
            kimi_result = normalize_kimi(fetch_kimi(kimi_credentials_path(args.kimi_credentials)))
            web_path = kimi_web_credentials_path(args.kimi_web_credentials)
            if web_path.is_file():
                try:
                    monthly = normalize_kimi_monthly(fetch_kimi_web(web_path))
                    if monthly:
                        kimi_result["windows"].append(monthly["window"])
                        kimi_result.setdefault("extra_lines", []).extend(monthly["extra_lines"])
                except Exception as exc:
                    errors.append({"provider": "Kimi Monthly Total", "error": str(exc)})
            results.append(kimi_result)
        except Exception as exc:
            errors.append({"provider": "Kimi Code", "error": str(exc)})
    if args.provider in ("all", "codex"):
        try:
            results.append(
                normalize_codex(
                    fetch_codex(
                        codex_credentials_path(args.codex_credentials),
                        auto_login=not args.no_codex_auto_login,
                    ),
                    monitor_config.get("openai") or {},
                )
            )
        except Exception as exc:
            errors.append({"provider": "OpenAI Codex", "error": str(exc)})
    if args.provider in ("all", "codebuddy"):
        try:
            results.append(
                normalize_codebuddy(
                    fetch_codebuddy(codebuddy_credentials_path(args.codebuddy_credentials))
                )
            )
        except Exception as exc:
            errors.append({"provider": "CodeBuddy", "error": str(exc)})
    if args.provider in ("all", "deepseek"):
        try:
            results.append(
                normalize_deepseek(
                    fetch_deepseek(args.deepseek_key, args.deepseek_credentials)
                )
            )
        except Exception as exc:
            errors.append({"provider": "DeepSeek", "error": str(exc)})
    return results, errors


@contextmanager
def keyboard_refresh_mode(stream):
    """Temporarily make Ctrl+R / Ctrl+E available without requiring Enter."""
    enabled = False
    fd = None
    original_settings = None
    try:
        if os.name == "nt":
            # msvcrt 按键读取不需要切换终端模式
            enabled = stream.isatty()
        elif stream.isatty():
            fd = stream.fileno()
            original_settings = termios.tcgetattr(fd)
            tty.setcbreak(fd, termios.TCSANOW)
            enabled = True
    except (AttributeError, OSError, ValueError):
        pass

    try:
        yield enabled
    finally:
        if enabled and fd is not None and original_settings is not None:
            termios.tcsetattr(fd, termios.TCSADRAIN, original_settings)


# 最近一次拉起的 Electron 主进程,用于退出时一并关闭
launched_window_proc = None


def launch_usage_window() -> None:
    """启动 Electron 悬浮用量看板窗口(detached,不阻塞终端监控)。

    窗口进程独立于终端运行;关闭窗口后可再次按 Ctrl+E 重新打开。
    """
    global launched_window_proc
    app_dir = Path(__file__).resolve().parent / "electron-app"
    electron_bin = app_dir / "node_modules" / ".bin" / (
        "electron.cmd" if os.name == "nt" else "electron"
    )
    if not electron_bin.exists():
        print(
            f"\nUsage window dependencies not installed; run: cd {app_dir} && npm install",
            flush=True,
        )
        time.sleep(3)
        return
    try:
        kwargs: dict[str, Any] = {
            "cwd": app_dir,
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
        }
        if os.name == "nt":
            kwargs["creationflags"] = (
                subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
            )
        else:
            kwargs["start_new_session"] = True
        launched_window_proc = subprocess.Popen([str(electron_bin), "."], **kwargs)
    except OSError as exc:
        print(f"\nFailed to launch usage window: {exc}", flush=True)
        time.sleep(3)


def kill_usage_window() -> None:
    """退出(含 Ctrl+C)时关闭已拉起的 Electron 窗口。

    单实例锁保证同时只有一个主进程;该进程以 start_new_session 启动,其 pid 即进程组
    leader,直接终止整个进程组即可连带关闭其 gpu/zygote 等子进程。
    """
    global launched_window_proc
    pids = set()
    if launched_window_proc is not None and launched_window_proc.poll() is None:
        pids.add(launched_window_proc.pid)
    launched_window_proc = None
    for pid in pids:
        try:
            if os.name == "nt":
                os.kill(pid, signal.SIGTERM)
            else:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
        except OSError:
            pass


def wait_for_next_refresh(
    interval: int,
    keyboard_enabled: bool,
    stream=None,
) -> bool:
    """Wait for the interval or Ctrl+R; return True for a manual refresh.

    Ctrl+E 在等待期间随时拉起/唤出 Electron 悬浮看板窗口,不中断等待。
    """
    if not keyboard_enabled:
        time.sleep(interval)
        return False

    stream = stream or sys.stdin
    deadline = time.monotonic() + interval
    if os.name == "nt":
        # Windows 上 select 不支持控制台句柄，改用 msvcrt 轮询
        while True:
            remaining = max(0.0, deadline - time.monotonic())
            if remaining <= 0:
                return False
            if msvcrt.kbhit():
                ch = msvcrt.getwch()
                if ch == "\x12":  # Ctrl+R
                    return True
                if ch == "\x05":  # Ctrl+E
                    launch_usage_window()
            time.sleep(min(0.05, remaining))
    while True:
        remaining = max(0.0, deadline - time.monotonic())
        readable, _, _ = select.select([stream], [], [], remaining)
        if not readable:
            return False
        ch = stream.read(1)
        if ch == "\x12":  # Ctrl+R
            return True
        if ch == "\x05":  # Ctrl+E
            launch_usage_window()


def enable_windows_ansi() -> None:
    """打开 Windows 控制台的 ANSI 转义支持（Windows 10+；失败则静默忽略）。"""
    if os.name != "nt":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        mode = ctypes.c_ulong()
        if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            kernel32.SetConsoleMode(handle, mode.value | 0x0004)  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
    except Exception:
        pass
    # 中文 Windows 控制台默认 GBK 编码，无法输出 ░/█/═ 等字符；
    # 无法编码的字符降级为 "?"，而不是 UnicodeEncodeError 直接崩溃
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Standalone Kimi Code / Codex usage monitor for the terminal")
    parser.add_argument("--watch", "-w", action="store_true", help="Keep refreshing")
    parser.add_argument("--interval", "-i", type=int, default=180, help="Refresh interval in seconds (default: 180)")
    parser.add_argument("--provider", choices=("all", "kimi", "codex", "codebuddy", "deepseek"), default="all")
    parser.add_argument("--kimi-credentials", help="Path to Kimi credentials file")
    parser.add_argument(
        "--kimi-web-credentials",
        help="Path to Kimi web credentials file (for Monthly Total; defaults to kimi-web.json next to the Kimi credentials)",
    )
    parser.add_argument("--codex-credentials", help="Path to Codex auth.json")
    parser.add_argument(
        "--config",
        help="Path to usage monitor config.json (defaults to the file next to this script)",
    )
    parser.add_argument("--codebuddy-credentials", help="Path to CodeBuddy credentials file")
    parser.add_argument("--deepseek-key", help="DeepSeek API key (or set DEEPSEEK_API_KEY)")
    parser.add_argument("--deepseek-credentials", help="Path to DeepSeek credentials JSON file")
    parser.add_argument("--json", action="store_true", help="Output JSON")
    parser.add_argument("--no-color", action="store_true", help="Disable ANSI colors")
    parser.add_argument(
        "--no-codex-auto-login",
        action="store_true",
        help="Disable automatic login when Codex credentials are missing",
    )
    args = parser.parse_args()
    if args.interval < 5:
        parser.error("--interval must be at least 5 seconds")
    if args.json and args.watch:
        parser.error("--json cannot be used together with --watch")

    enable_windows_ansi()
    keyboard_context = keyboard_refresh_mode(sys.stdin) if args.watch else nullcontext(False)
    try:
        with keyboard_context as keyboard_enabled:
            if args.watch:
                launch_usage_window()  # 运行 usage 即自动打开悬浮窗口
            while True:
                results, errors = collect(args)
                versions = collect_versions({result["provider"] for result in results})
                if args.json:
                    print(json.dumps({"accounts": results, "errors": errors, "versions": versions}, ensure_ascii=False, indent=2))
                else:
                    color = sys.stdout.isatty() and not args.no_color
                    if args.watch and sys.stdout.isatty():
                        print("\033[2J\033[H", end="")
                    print(render(results, errors, color, versions))
                    if args.watch:
                        shortcuts = (
                            "Ctrl+R to refresh, Ctrl+E for window, Ctrl+C to exit"
                            if keyboard_enabled
                            else "Ctrl+C to exit"
                        )
                        print(
                            f"\n{DIM if color else ''}Refreshing every {args.interval}s, "
                            f"{shortcuts}{RESET if color else ''}"
                        )
                        if (
                            sys.stdout.isatty()
                            and len(persistent_watch_errors(errors)) != len(errors)
                        ):
                            # 月总量依赖短效网页凭证；失败提示短暂出现后清除，
                            # 避免在下一次定时刷新前长期占据监控界面。
                            time.sleep(2)
                            print("\033[2J\033[H", end="")
                            print(render(results, persistent_watch_errors(errors), color, versions))
                            print(
                                f"\n{DIM if color else ''}Refreshing every {args.interval}s, "
                                f"{shortcuts}{RESET if color else ''}"
                            )
                if not args.watch:
                    return 1 if errors and not results else 0
                wait_for_next_refresh(args.interval, keyboard_enabled)
    except KeyboardInterrupt:
        print("\nExited usage monitor.")
        return 0
    finally:
        if args.watch:
            kill_usage_window()


if __name__ == "__main__":
    raise SystemExit(main())
