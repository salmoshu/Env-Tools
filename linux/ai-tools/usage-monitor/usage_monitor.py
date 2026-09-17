#!/usr/bin/env python3
"""Kimi Code / OpenAI Codex / DeepSeek / GLM 本地终端额度监控（不依赖 Sub2API）。"""

from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, nullcontext
import calendar
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
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
# 同一网页网关的订阅详情：会员名称（goods.title，如 Allegro）与当前周期终止时间；
# CLI 的 /coding/v1/usages 已不再返回会员等级字段，只能从这里取。
KIMI_WEB_SUBSCRIPTION_URL = (
    "https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscription"
)
CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
# Legacy CodeBuddy support is intentionally retained for possible reuse, but it is
# not exposed by the CLI and is never called by the default collection path.
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

# GLM Coding Plan 配额查询：官方订阅管理页（bigmodel.cn/coding-plan/personal/overview）
# 在用的接口，与开放平台 API 余额无关。返回 5 小时/每周 token 窗口的已用百分比与
# 重置时间，以及工具（联网搜索等）月额度的绝对次数。鉴权用同一把 BigModel API Key。
GLM_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
# 同一管理页的订阅列表接口：返回套餐名与续费（重置）日期，作为 GLM 会员到期时间。
GLM_SUBSCRIPTION_PATH = "/api/biz/subscription/list"
GLM_BILLING_CYCLE_MONTHS = {"monthly": 1, "quarterly": 3, "semi-annually": 6, "yearly": 12}

# 看板标题右侧的 CLI 版本标注：当前版本来自本机 `cmd --version`，最新版本按
# VERSION_CHECK_INTERVAL 周期探测并缓存；有更新时追加黄色的 "→ 新版本号"
KIMI_LATEST_VERSION_URL = "https://code.kimi.com/kimi-code/latest"
NPM_LATEST_VERSION_URL = "https://registry.npmjs.org/{package}/latest"
VERSION_CHECK_INTERVAL = 3600
VERSION_CACHE_PATH = Path.home() / ".cache" / "ai-usage-monitor" / "versions.json"
MONITOR_CONFIG_PATH = Path(__file__).resolve().with_name("config.json")
# 会员到期时间可配置的 provider（config.json 同名小节），由设置页统一管理
MEMBERSHIP_PROVIDERS = ("kimi", "openai", "glm", "deepseek")
VERSION_TOOLS = {
    "Kimi Code": {"command": "kimi", "source": "kimi"},
    "OpenAI Codex": {"command": "codex", "source": "npm", "package": "@openai/codex"},
}

GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
CYAN = "\033[36m"
DIM = "\033[2m"
RESET = "\033[0m"

# Electron 看板是无交互后台请求：使用更短的单次超时和有限重试，
# 避免某个 provider 断网时整个窗口长时间卡在 Loading。终端模式保持原值。
REQUEST_TIMEOUT_CAP: int | None = None
GET_ATTEMPTS_CAP: int | None = None
VERSION_REQUEST_TIMEOUT_CAP: int | None = None
# 看板模式下 Codex 的单次超时上限，为其他 provider 上限（10 秒）的两倍。
CODEX_DASHBOARD_TIMEOUT_CAP = 20

# 仓库统一版本号：所有内部应用与脚本共用根目录 VERSION 文件。
REPO_ROOT = Path(__file__).resolve().parents[3]
# 数据源环境：None 表示本机；WSL 中可选 "windows" 读取 Windows 侧的
# 凭据与 agent 版本（见 resolve_environment）。由 main() 在启动时设置。
ENVIRONMENT: str | None = None
SETTINGS_PATH = Path.home() / ".config" / "ai-usage-monitor" / "settings.json"
_WINDOWS_PROFILE: Path | None = None


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


def repo_version() -> str:
    """仓库统一版本号（根目录 VERSION 文件）；缺失时返回 unknown。

    打包版应用里 REPO_ROOT 下没有 VERSION，但 Electron 自带的 `version` 文件
    （内容为 Electron 版本，如 37.10.3）在 Windows 大小写不敏感文件系统上会
    被误读——所以内容必须长得像版本号才采纳。
    """
    try:
        value = (REPO_ROOT / "VERSION").read_text(encoding="utf-8").strip()
    except OSError:
        return "unknown"
    if re.fullmatch(r"\d+(\.\d+){0,3}", value):
        return value
    return "unknown"


def native_environment() -> str:
    if os.name == "nt":
        return "windows"
    return "wsl" if running_in_wsl() else "linux"


def windows_user_profile() -> Path:
    """WSL 中解析 Windows 用户目录（/mnt/c/Users/<u>），带进程内缓存。"""
    global _WINDOWS_PROFILE
    if _WINDOWS_PROFILE is not None:
        return _WINDOWS_PROFILE
    if not running_in_wsl():
        raise MonitorError("Windows environment is only reachable from WSL")
    result = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-Command",
            '[Environment]::GetFolderPath("UserProfile")',
        ],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=15,
    )
    windows_profile = result.stdout.strip()
    if result.returncode != 0 or not windows_profile:
        raise MonitorError("Cannot resolve the Windows user profile from WSL")
    profile = Path(
        subprocess.run(
            ["wslpath", "-u", windows_profile],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        ).stdout.strip()
    )
    if not profile.is_dir():
        raise MonitorError(f"Windows user profile is not accessible: {profile}")
    _WINDOWS_PROFILE = profile
    return profile


def env_home() -> Path:
    """当前数据源环境的用户目录：env=windows 时指向 Windows 用户目录。"""
    if ENVIRONMENT == "windows" and running_in_wsl():
        return windows_user_profile()
    return Path.home()


def settings_path() -> Path:
    if os.environ.get("AI_USAGE_SETTINGS_PATH"):
        return Path(os.environ["AI_USAGE_SETTINGS_PATH"]).expanduser()
    return SETTINGS_PATH


def load_settings() -> dict[str, Any]:
    path = settings_path()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def wsl_distro_name() -> str:
    return os.environ.get("WSL_DISTRO_NAME", "").strip()


def available_wsl_distros() -> list[str]:
    if not running_in_wsl():
        return []
    try:
        result = subprocess.run(
            ["wsl.exe", "--list", "--quiet"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError, UnicodeError):
        result = None
    names = []
    if result and result.returncode == 0:
        for line in (result.stdout or "").replace("\x00", "").splitlines():
            name = line.strip().lstrip("*").strip()
            if name and name not in names:
                names.append(name)
    current = wsl_distro_name()
    if current and current not in names:
        names.insert(0, current)
    return names


def available_environments() -> list[str]:
    """本机环境列表；WSL 且能访问 Windows 侧时追加 windows。"""
    environments = [native_environment()]
    if environments[0] == "wsl":
        try:
            windows_user_profile()
        except (MonitorError, OSError, subprocess.SubprocessError):
            pass
        else:
            environments.append("windows")
    return environments


def resolve_environment(explicit: str | None = None) -> str:
    """数据源环境：--environment 参数 > 设置文件 > 本机环境。"""
    global ENVIRONMENT
    settings = load_settings()
    environment = explicit or settings.get("environment") or native_environment()
    if environment == "windows" and native_environment() == "wsl":
        windows_user_profile()  # 提前失败，避免每个 provider 各自报错
    elif environment != native_environment():
        raise MonitorError(f"Environment '{environment}' is not available on this machine")
    ENVIRONMENT = environment
    return environment


def windows_setup_script_unc() -> str | None:
    """env=windows 时升级脚本的 UNC 路径（供 Windows 侧 Electron 起 powershell）。"""
    if not (running_in_wsl() and ENVIRONMENT == "windows"):
        return None
    script = REPO_ROOT / "windows" / "ai-tools" / "setup_ai_tools.ps1"
    if not script.is_file():
        return None
    try:
        return windows_path_from_wsl(script)
    except (OSError, subprocess.SubprocessError):
        return None


def kimi_credentials_path(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    if os.environ.get("KIMI_CREDENTIALS_PATH"):
        return Path(os.environ["KIMI_CREDENTIALS_PATH"]).expanduser()

    home = env_home()
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
    if os.environ.get("CODEX_HOME"):
        codex_home = Path(os.environ["CODEX_HOME"]).expanduser()
    else:
        codex_home = env_home() / ".codex"
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
    timeout_cap: int | None = None,
) -> dict[str, Any]:
    attempts = 3 if data is None else 1
    if GET_ATTEMPTS_CAP is not None and data is None:
        attempts = min(attempts, GET_ATTEMPTS_CAP)
    if REQUEST_TIMEOUT_CAP is not None:
        # 个别慢接口（如经代理访问 chatgpt.com）可通过 timeout_cap 放宽单次上限。
        cap = max(REQUEST_TIMEOUT_CAP, timeout_cap) if timeout_cap else REQUEST_TIMEOUT_CAP
        timeout = min(timeout, cap)
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
                attempt_note = "" if attempts == 1 else f" after {attempts} attempts"
                raise MonitorError(f"Network request failed{attempt_note}: {exc.reason}") from exc
            time.sleep(attempt + 1)
        except OSError as exc:
            if attempt + 1 == attempts:
                attempt_note = "" if attempts == 1 else f" after {attempts} attempts"
                raise MonitorError(f"Network request failed{attempt_note}: {exc}") from exc
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


def _fetch_kimi_web_api(url: str, access_token: str) -> dict[str, Any]:
    return request_json(
        url,
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


def fetch_kimi_web(path: Path, url: str | None = None) -> dict[str, Any]:
    """网页版会员网关接口（月总量统计、订阅详情），走 kimi.com 网关，需要网页登录态。"""
    url = url or os.environ.get("KIMI_WEB_STATS_URL", KIMI_WEB_STATS_URL)
    credentials = read_json(path)
    access_token = str(credentials.get("access_token") or "")
    if _jwt_expires_at(access_token) - time.time() < TOKEN_REFRESH_THRESHOLD:
        credentials = refresh_kimi_web_credentials(path, credentials)
        access_token = str(credentials.get("access_token") or "")
    if not access_token:
        raise MonitorError("access_token missing in Kimi web credentials; configure kimi-web.json (see docs/usage-monitor.md)")
    try:
        return _fetch_kimi_web_api(url, access_token)
    except MonitorError as exc:
        if "HTTP 401" in str(exc):
            credentials = refresh_kimi_web_credentials(path, credentials)
            return _fetch_kimi_web_api(url, str(credentials["access_token"]))
        raise


def fetch_kimi_web_subscription(path: Path) -> dict[str, Any]:
    """GetSubscription：会员名称与当前周期终止/续费时间。"""
    return fetch_kimi_web(
        path, os.environ.get("KIMI_WEB_SUBSCRIPTION_URL", KIMI_WEB_SUBSCRIPTION_URL)
    )


def fetch_codex(path: Path) -> dict[str, Any]:
    return _fetch_codex(path)


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
            # 看板快速失败策略对其他 provider 限 10 秒；chatgpt.com 必须经代理
            # 访问，延迟高且抖动大，给双倍单次容忍（20 秒）。终端模式无上限。
            timeout_cap=CODEX_DASHBOARD_TIMEOUT_CAP,
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


LOGIN_AGENTS = {
    "kimi": ("Kimi Code", "kimi"),
    "codex": ("OpenAI Codex", "codex"),
}


def run_agent_login(agent: str) -> bool:
    info = LOGIN_AGENTS.get(agent)
    if not info:
        print(f"Unknown login agent: {agent}", file=sys.stderr)
        return False
    label, command_name = info
    if ENVIRONMENT == "windows" and running_in_wsl():
        command = [
            "powershell.exe",
            "-NoProfile",
            "-Command",
            f"{command_name} login",
        ]
    else:
        command = [command_name, "login"]
    print(f"Starting {label} web authorization…", flush=True)
    try:
        result = subprocess.run(command, check=False)
    except FileNotFoundError:
        print(f"{command_name} command not found; install it first", file=sys.stderr)
        return False
    if result.returncode != 0:
        print(f"{label} login exited with code {result.returncode}", file=sys.stderr)
        return False
    print(f"{label} login finished; refreshing usage data…", flush=True)
    return True


def prompt_agent_login(stream=None) -> bool:
    stream = stream or sys.stdin
    print("\nLogin agent: [K]imi Code  [C]odex  [Q]ancel", flush=True)
    if os.name == "nt":
        choice = msvcrt.getwch()
    else:
        if not reclaim_terminal_foreground(stream):
            return False
        readable, _, _ = select.select([stream], [], [], None)
        if not readable:
            return False
        choice = stream.read(1)
    agent = {"k": "kimi", "c": "codex"}.get(choice.lower())
    if not agent:
        print("Login cancelled.", flush=True)
        return False
    return run_agent_login(agent)


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
    return env_home() / ".deepseek" / "credentials.json"


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


def glm_credentials_path(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    env = os.environ.get("GLM_CREDENTIALS_PATH")
    if env:
        return Path(env).expanduser()
    return env_home() / ".glm" / "credentials.json"


def glm_api_key(explicit: str | None = None, credentials_path: str | None = None) -> str:
    if explicit:
        return explicit
    for name in ("GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY"):
        key = os.environ.get(name)
        if key:
            return key
    path = Path(credentials_path).expanduser() if credentials_path else glm_credentials_path()
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise MonitorError(f"Cannot read GLM credentials file {path}: {exc}")
        key = (
            data.get("api_key")
            or data.get("GLM_API_KEY")
            or data.get("ZHIPU_API_KEY")
            or data.get("ZHIPUAI_API_KEY")
        )
        if not key:
            raise MonitorError(f"GLM credentials file {path} is missing api_key")
        return key
    raise MonitorError(
        "GLM_API_KEY not set; export it, write it to ~/.glm/credentials.json, or pass --glm-key"
    )


def fetch_glm(key: str | None = None, credentials_path: str | None = None) -> dict[str, Any]:
    api_key = glm_api_key(key, credentials_path)
    result = request_json(
        os.environ.get("GLM_QUOTA_URL", GLM_QUOTA_URL),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
        },
        use_proxy=env_enabled("GLM_USE_PROXY", default=True),
        timeout=int(os.environ.get("GLM_TIMEOUT", "30")),
    )
    data = result.get("data")
    if not (result.get("success") and isinstance(data, dict) and isinstance(data.get("limits"), list)):
        error = result.get("msg") or result.get("message") or "unexpected response"
        raise MonitorError(f"GLM quota query failed: {error}")
    return result


def glm_subscription_url() -> str:
    """订阅列表接口地址：从配额接口同源推导（GLM_QUOTA_URL 切到 z.ai 时自动跟随）。"""
    quota_url = os.environ.get("GLM_QUOTA_URL", GLM_QUOTA_URL)
    base = quota_url.split("/api/", 1)[0].rstrip("/")
    return base + GLM_SUBSCRIPTION_PATH


def fetch_glm_subscription(key: str | None = None, credentials_path: str | None = None) -> dict[str, Any]:
    api_key = glm_api_key(key, credentials_path)
    result = request_json(
        os.environ.get("GLM_SUBSCRIPTION_URL") or glm_subscription_url(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
        },
        use_proxy=env_enabled("GLM_USE_PROXY", default=True),
        timeout=int(os.environ.get("GLM_TIMEOUT", "30")),
    )
    data = result.get("data")
    if not (result.get("success") and isinstance(data, list)):
        error = result.get("msg") or result.get("message") or "unexpected response"
        raise MonitorError(f"GLM subscription query failed: {error}")
    return result


def _glm_subscription_end(item: dict[str, Any]) -> datetime | None:
    """订阅的下次续费（重置）时刻；valid 下周期起点比 date 型的 nextRenewTime 更精确。"""
    # valid 形如 "2026-12-03 10:00:00-2027-03-03 10:00:00"，起点即下次续费时刻
    match = re.match(r"(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})", str(item.get("valid") or ""))
    if match:
        parsed = _parse_local_datetime(f"{match.group(1)} {match.group(2)}")
        if parsed is not None:
            return parsed
    renew = str(item.get("nextRenewTime") or "").strip()
    if renew:
        # nextRenewTime 可能只有日期（"2026-12-03"），按本机时区零点计
        return _parse_local_datetime(renew if ":" in renew else f"{renew} 00:00:00")
    return None


def normalize_glm_subscription(
    result: dict[str, Any],
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """GLM 订阅列表 → 通用 membership 结构；无有效订阅时返回 None。"""
    data = result.get("data") if isinstance(result, dict) else None
    if not isinstance(data, list):
        return None
    candidates = []
    for item in data:
        if not isinstance(item, dict):
            continue
        end = _glm_subscription_end(item)
        if end is not None:
            candidates.append((item, end))
    if not candidates:
        return None
    current = [
        candidate
        for candidate in candidates
        if candidate[0].get("inCurrentPeriod")
        and str(candidate[0].get("status") or "").upper() == "VALID"
    ]
    item, ends_at = (current or candidates)[0]
    current_moment = (now or datetime.now().astimezone()).astimezone()
    purchased_at = _parse_local_datetime(item.get("purchaseTime")) or _parse_local_datetime(
        item.get("currentRenewTime")
    )
    return {
        "purchased_at": (purchased_at or ends_at).isoformat(timespec="seconds"),
        "ends_at": ends_at.isoformat(timespec="seconds"),
        "end_after_seconds": int((ends_at - current_moment).total_seconds()),
        "duration_months": GLM_BILLING_CYCLE_MONTHS.get(
            str(item.get("billingCycle") or "").lower()
        ),
        # 自动续费的套餐显示 renews 而非 ends，避免误读为到期停用
        "auto_renew": bool(item.get("autoRenew")),
    }


def normalize_balance_provider(
    data: dict[str, Any],
    provider: str,
    monthly_limit: float,
) -> dict[str, Any]:
    infos = data.get("balance_infos") or []
    report = data.get("data") if isinstance(data.get("data"), dict) else {}
    if infos:
        balance = next(
            (b for b in infos if str(b.get("currency") or "").upper() == "CNY"),
            None,
        )
        if balance is None:
            balance = infos[0]
        total = _num(balance.get("total_balance"))
        granted = _num(balance.get("granted_balance"))
        topped_up = _num(balance.get("topped_up_balance"))
    else:
        # 财务中心 query-customer-account-report 的字段命名。
        total = _num(report.get("balance"))
        granted = _num(report.get("giveAmount"))
        topped_up = _num(report.get("rechargeAmount"))
    # 进度条口径与其它模型保持一致:余额转为使用量(50 - 余额),低于 0 时截断为 0
    usage = max(0.0, monthly_limit - total)
    capped = min(usage, monthly_limit)
    fill_percent = percent(used=capped * 100 / monthly_limit)
    extra_lines = [
        f"Balance: ¥{total:.2f} / ¥{monthly_limit:.2f}",
        f"Usage: ¥{usage:.2f} / ¥{monthly_limit:.2f}",
        f"Granted: ¥{granted:.2f}   Topped-up: ¥{topped_up:.2f}",
    ]
    if report:
        available = _num(report.get("availableBalance", total))
        frozen = _num(report.get("frozenBalance"))
        spent = _num(report.get("totalSpendAmount"))
        extra_lines.append(
            f"Available: ¥{available:.2f}   Frozen: ¥{frozen:.2f}   Total spent: ¥{spent:.2f}"
        )
    if not data.get("is_available", True):
        extra_lines.append("Account unavailable")
    return {
        "provider": provider,
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


def normalize_deepseek(data: dict[str, Any]) -> dict[str, Any]:
    return normalize_balance_provider(data, "DeepSeek", DEEPSEEK_MONTHLY_LIMIT)


def normalize_glm(data: dict[str, Any]) -> dict[str, Any]:
    """GLM Coding Plan 配额：5 小时/每周积分窗口 + 工具月额度。

    响应结构（bigmodel.cn 订阅管理页同款接口）：
      data.limits[] 中 CREDIT_LIMIT/TOKENS_LIMIT（unit=3,number=5 → 5 小时；
      unit=6,number=1 → 每周）：percentage 为已用百分比，nextResetTime 为重置
      时间（epoch 毫秒，滑动窗口未使用时可能缺省），CREDIT_LIMIT 另给绝对积分
      usage/currentValue/remaining。TIME_LIMIT 为工具/联网搜索月额度。
      data.level 为套餐档位（lite/pro/max）。
    """
    payload = data.get("data") if isinstance(data.get("data"), dict) else {}
    limits = payload.get("limits") or []
    level = str(payload.get("level") or "").strip()
    windows: list[dict[str, Any]] = []
    extra_lines: list[str] = []

    def limit_percent(limit: dict[str, Any]) -> float | None:
        try:
            return max(0.0, min(100.0, float(limit.get("percentage"))))
        except (TypeError, ValueError):
            return None

    token_limits = [
        l
        for l in limits
        if isinstance(l, dict) and l.get("type") in ("CREDIT_LIMIT", "TOKENS_LIMIT")
    ]

    def pick_token_limit(unit: int, number: int) -> dict[str, Any] | None:
        for l in token_limits:
            if l.get("unit") == unit and l.get("number") == number:
                return l
        return None

    five_hour = pick_token_limit(3, 5)
    weekly = pick_token_limit(6, 1)
    if five_hour is None or weekly is None:
        # 兜底：unit/number 缺失时按重置时间排序，最近的视为 5 小时窗口
        ordered = sorted(
            (l for l in token_limits if l is not five_hour and l is not weekly),
            key=lambda l: _num(l.get("nextResetTime")),
        )
        if five_hour is None and ordered:
            five_hour = ordered.pop(0)
        if weekly is None and ordered:
            weekly = ordered.pop(0)

    for limit, label, span in (
        (five_hour, "5h Window", 5 * 3600),
        (weekly, "7d Window", 7 * 86400),
    ):
        if limit is None:
            continue
        pct = limit_percent(limit)
        if pct is None:
            continue
        window = {
            "label": label,
            "used_percent": pct,
            "reset_after_seconds": seconds_until(limit.get("nextResetTime")),
            "window_seconds": span,
        }
        total = _num(limit.get("usage"))
        if total > 0:
            # 积分窗口带绝对值：进度条上显示已用/总量，附行显示剩余
            window["usage"] = f"{int(_num(limit.get('currentValue')))}/{int(total)}"
            extra_lines.append(
                f"{label} remaining: {int(_num(limit.get('remaining')))}/{int(total)}"
            )
        windows.append(window)

    for l in limits:
        if not isinstance(l, dict) or l.get("type") != "TIME_LIMIT":
            continue
        total = _num(l.get("usage"))
        used = _num(l.get("currentValue"))
        pct = limit_percent(l)
        if pct is None and total > 0:
            pct = max(0.0, min(100.0, used * 100 / total))
        if pct is None:
            continue
        reset_at = parse_timestamp(l.get("nextResetTime"))
        window: dict[str, Any] = {
            "label": "Tools Quota",
            "used_percent": pct,
            "reset_after_seconds": seconds_until(l.get("nextResetTime")),
            # 月窗口：有重置时间时按一个自然月估算窗口起点（供 | 时间标记定位）
            "window_seconds": monthly_window_seconds(reset_at) if reset_at else None,
        }
        if total > 0:
            window["usage"] = f"{int(used)}/{int(total)}"
        windows.append(window)
        extra_lines.append(f"Tools remaining: {int(_num(l.get('remaining')))}/{int(total)}")

    return {
        "provider": "GLM",
        "plan": f"Coding {level.capitalize()}" if level else "Coding",
        "windows": windows,
        "extra_lines": extra_lines,
        "fetched_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }


API_KEY_SETTINGS = {
    "deepseek": {
        "env": ("DEEPSEEK_API_KEY",),
        "path": deepseek_credentials_path,
        "fields": ("api_key", "DEEPSEEK_API_KEY"),
    },
    "glm": {
        "env": ("GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY"),
        "path": glm_credentials_path,
        "fields": ("api_key", "GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY"),
    },
}


def api_key_status() -> dict[str, dict[str, Any]]:
    """返回看板可配置 provider 的凭据状态，绝不返回密钥内容。"""
    status: dict[str, dict[str, Any]] = {}
    for provider, settings in API_KEY_SETTINGS.items():
        if any(os.environ.get(name) for name in settings["env"]):
            status[provider] = {"configured": True, "source": "environment"}
            continue
        path = settings["path"]()
        if not path.is_file():
            status[provider] = {"configured": False, "source": "missing"}
            continue
        try:
            data = read_json(path)
            configured = any(data.get(field) for field in settings["fields"])
            status[provider] = {
                "configured": configured,
                "source": "file" if configured else "missing",
            }
        except MonitorError as exc:
            status[provider] = {
                "configured": False,
                "source": "invalid",
                "error": str(exc),
            }
    return status


def configure_api_keys(payload: Any) -> dict[str, Any]:
    """把 Electron 通过 stdin 传入的 API Key 写入私有凭据文件。"""
    if not isinstance(payload, dict):
        raise MonitorError("API key settings must be a JSON object")
    unknown = sorted(set(payload) - set(API_KEY_SETTINGS))
    if unknown:
        raise MonitorError(f"Unsupported API key provider: {', '.join(unknown)}")
    saved = []
    for provider, value in payload.items():
        if not isinstance(value, str) or not value.strip():
            raise MonitorError(f"{provider} API key cannot be empty")
        settings = API_KEY_SETTINGS[provider]
        path = settings["path"]()
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(str(path.parent), 0o700)
        except OSError:
            pass
        data = read_json(path) if path.is_file() else {}
        data["api_key"] = value.strip()
        write_private_json(path, data)
        saved.append(provider)
    return {"ok": True, "saved": saved, "status": api_key_status()}


def get_settings_payload() -> dict[str, Any]:
    """Electron 设置页初始数据：版本、当前数据源环境与可选环境列表。"""
    settings = load_settings()
    available = available_environments()
    configured = settings.get("environment")
    environment = configured if configured in available else available[0]
    wsl_distros = available_wsl_distros() if "wsl" in available else []
    configured_distro = settings.get("wsl_distro")
    if configured_distro in wsl_distros:
        wsl_distro = configured_distro
    elif wsl_distro_name() in wsl_distros:
        wsl_distro = wsl_distro_name()
    else:
        wsl_distro = wsl_distros[0] if wsl_distros else None
    return {
        "ok": True,
        "version": repo_version(),
        "environment": environment,
        "available_environments": available,
        "wsl_distros": wsl_distros,
        "wsl_distro": wsl_distro,
        "membership": membership_settings(),
        "script": str(Path(__file__).resolve()),
    }


def update_settings(payload: Any) -> dict[str, Any]:
    """保存 Electron 设置页改动（数据源环境、各 provider 会员时间）。"""
    if not isinstance(payload, dict):
        raise MonitorError("Settings must be a JSON object")
    unknown = sorted(set(payload) - {"environment", "wsl_distro", "membership"})
    if unknown:
        raise MonitorError(f"Unsupported setting: {', '.join(unknown)}")
    membership = None
    if "membership" in payload:
        # 先写 config.json：会员时间校验失败时 settings.json 保持不动
        membership = update_membership_config(payload["membership"])
    available = available_environments()
    settings = load_settings()
    wsl_distros = available_wsl_distros() if "wsl" in available else []
    if "wsl_distro" in payload:
        value = payload["wsl_distro"]
        if not isinstance(value, str) or not value.strip() or value not in wsl_distros:
            raise MonitorError(
                f"WSL distro '{value}' is not available (choose from: {', '.join(wsl_distros)})"
            )
        settings["wsl_distro"] = value
    if "environment" in payload:
        value = payload["environment"]
        if value not in available:
            raise MonitorError(
                f"Environment '{value}' is not available (choose from: {', '.join(available)})"
            )
        settings["environment"] = value
    if settings.get("environment") == "wsl":
        value = settings.get("wsl_distro") or wsl_distro_name()
        if not value or value not in wsl_distros:
            raise MonitorError("Select an available WSL distro before using the WSL environment")
        settings["wsl_distro"] = value
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    write_private_json(path, settings)
    result: dict[str, Any] = {"ok": True, "settings": settings}
    if membership is not None:
        result["membership"] = membership
    return result


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


def normalize_kimi_subscription(
    data: dict[str, Any],
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """GetSubscription 响应 → {"plan": 会员名称, "membership": {...}}；无订阅返回 None。

    会员名称取 subscription.goods.title（如 Allegro）；会员终止时间取
    currentEndTime；存在 nextBillingTime 且订阅活跃视为自动续费（展示 renews）。
    """
    subscription = data.get("subscription") or data.get("purchaseSubscription") or {}
    if not isinstance(subscription, dict) or not subscription:
        return None
    goods = subscription.get("goods") or {}
    result: dict[str, Any] = {}
    plan = str(goods.get("title") or "").strip()
    if plan:
        result["plan"] = plan
    ends_at = parse_timestamp(subscription.get("currentEndTime"))
    if ends_at is not None:
        current = (now or datetime.now().astimezone()).astimezone()
        purchased_at = parse_timestamp(
            subscription.get("currentStartTime") or subscription.get("subscriptionTime")
        )
        membership: dict[str, Any] = {
            "purchased_at": (purchased_at or ends_at).isoformat(timespec="seconds"),
            "ends_at": ends_at.isoformat(timespec="seconds"),
            "end_after_seconds": int((ends_at - current).total_seconds()),
        }
        cycle = goods.get("billingCycle") or {}
        try:
            cycle_count = int(cycle.get("duration") or 0)
        except (TypeError, ValueError):
            cycle_count = 0
        cycle_unit = str(cycle.get("timeUnit") or "").upper()
        cycle_months = cycle_count * 12 if "YEAR" in cycle_unit else cycle_count
        if "MONTH" in cycle_unit or "YEAR" in cycle_unit:
            if cycle_months > 0:
                membership["duration_months"] = cycle_months
        if subscription.get("nextBillingTime") and subscription.get("active", True):
            membership["auto_renew"] = True
        result["membership"] = membership
    return result or None


def normalize_membership(
    config: Any,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """config.json 中某个 provider 小节的会员购买与终止时间（各 provider 通用）。"""
    if not isinstance(config, dict):
        return None
    purchased_value = config.get("membership_purchased_at")
    if not purchased_value:
        return None
    purchased_at = parse_timestamp(purchased_value)
    if purchased_at is None:
        return {"error": f"Invalid membership_purchased_at in config.json: {purchased_value}"}
    # 无时区的时间按本机时区解释
    purchased_at = purchased_at.astimezone()
    try:
        duration_months = max(1, int(config.get("membership_duration_months", 1)))
    except (TypeError, ValueError):
        return {"error": "Invalid membership_duration_months in config.json"}
    ends_at = add_calendar_months(purchased_at, duration_months)
    current = (now or datetime.now().astimezone()).astimezone()
    return {
        "purchased_at": purchased_at.isoformat(timespec="seconds"),
        "ends_at": ends_at.isoformat(timespec="seconds"),
        "end_after_seconds": int((ends_at - current).total_seconds()),
        "duration_months": duration_months,
    }


def attach_membership(result: dict[str, Any], config: Any) -> bool:
    """把 config.json 中某 provider 小节的会员时间挂到 normalized 结果上。"""
    membership = normalize_membership(config)
    if membership:
        result["membership"] = membership
        return True
    return False


def _parse_membership_input(value: Any) -> datetime | None:
    """解析设置页/config.json 的会员购买时间；无时区按本机时区，失败返回 None。"""
    text = str(value or "").strip()
    if not text:
        return None
    # datetime-local 输入为 "YYYY-MM-DDTHH:MM"（无秒），config.json 惯例为本地时刻
    for fmt in (
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
    ):
        try:
            return datetime.strptime(text, fmt).astimezone()
        except ValueError:
            continue
    parsed = parse_timestamp(text)
    if parsed is not None and parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed


def membership_settings() -> dict[str, Any]:
    """各 provider 的会员时间配置（含计算出的终止时间），供设置页展示与保存回显。"""
    try:
        config = read_monitor_config()
    except MonitorError:
        config = {}
    result: dict[str, Any] = {}
    for provider in MEMBERSHIP_PROVIDERS:
        section = config.get(provider)
        if not isinstance(section, dict) or not section.get("membership_purchased_at"):
            result[provider] = None
            continue
        entry: dict[str, Any] = {
            "purchased_at": str(section.get("membership_purchased_at")),
            "duration_months": section.get("membership_duration_months", 1),
        }
        membership = normalize_membership(section)
        if membership and "error" in membership:
            entry["error"] = membership["error"]
        elif membership:
            entry.update(
                purchased_at=membership["purchased_at"],
                duration_months=membership["duration_months"],
                ends_at=membership["ends_at"],
                end_after_seconds=membership["end_after_seconds"],
            )
        result[provider] = entry
    return result


def update_membership_config(payload: Any) -> dict[str, Any]:
    """把设置页的会员时间写入 monitor config.json，返回规范化后的会员设置。"""
    if not isinstance(payload, dict):
        raise MonitorError("Membership settings must be a JSON object")
    unknown = sorted(set(payload) - set(MEMBERSHIP_PROVIDERS))
    if unknown:
        raise MonitorError(f"Unsupported membership provider: {', '.join(unknown)}")
    path = monitor_config_path()
    config = read_monitor_config() if path.is_file() else {}
    for provider, value in payload.items():
        section = config.get(provider)
        section = dict(section) if isinstance(section, dict) else {}
        if value is None:
            # 清空该 provider 的会员时间
            section.pop("membership_purchased_at", None)
            section.pop("membership_duration_months", None)
        else:
            if not isinstance(value, dict):
                raise MonitorError(f"{provider} membership must be an object or null")
            purchased = _parse_membership_input(value.get("purchased_at"))
            if purchased is None:
                raise MonitorError(
                    f"Invalid membership purchased_at for {provider}: {value.get('purchased_at')!r}"
                )
            raw_months = value.get("duration_months")
            if raw_months in (None, ""):
                raw_months = 1
            try:
                months = int(raw_months)
            except (TypeError, ValueError):
                months = 0
            if months < 1:
                raise MonitorError(f"Invalid membership duration_months for {provider}")
            section["membership_purchased_at"] = purchased.strftime("%Y-%m-%d %H:%M:%S")
            section["membership_duration_months"] = months
        if section:
            config[provider] = section
        else:
            config.pop(provider, None)
    write_private_json(path, config)
    return membership_settings()


def normalize_codex(data: dict[str, Any]) -> dict[str, Any]:
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


def membership_end_text(seconds: int, auto_renew: bool = False) -> str:
    if seconds >= 0:
        verb = "renews" if auto_renew else "ends"
        return f"{verb} in {compact_duration(seconds)}"
    return f"ended {compact_duration(-seconds)} ago"


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


def _detect_windows_cli_version(command: str) -> str | None:
    """WSL 中探测 Windows 侧 CLI 版本（powershell.exe 转发）。

    不要加 start_new_session：WSL interop relay 可能把伪终端前台进程组切给
    短命的 PowerShell 会话，导致 monitor 读键盘时收到 SIGTTIN（Stopped）。
    """
    try:
        completed = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", f"{command} --version"],
            capture_output=True,
            text=True,
            timeout=15,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return _semver_match(completed.stdout) or _semver_match(completed.stderr)


def detect_cli_version(command: str) -> str | None:
    """本机已安装 CLI 的版本（取 --version 输出中的首个 x.y.z）；未安装返回 None。"""
    if ENVIRONMENT == "windows" and running_in_wsl():
        return _detect_windows_cli_version(command)
    command_args: list[str] = [command, "--version"]
    in_wsl = running_in_wsl()
    if in_wsl:
        # Windows 原生 Electron 通过 `wsl.exe --exec python3` 启动后端时，
        # PATH 不包含 .bashrc 中初始化的 NVM 全局 bin。用交互式 bash
        # 探测，确保版本来自与用户终端/升级脚本相同的 CLI。交互式 bash
        # 必须脱离控制终端，否则连续探测 Codex/Kimi 时会篡改前台进程组，
        # 第二个 shell 随即向 monitor 发送 SIGTTIN，Bash 显示 Stopped。
        command_args = ["bash", "-ic", f"{shlex.quote(command)} --version"]
    try:
        completed = subprocess.run(
            command_args,
            capture_output=True,
            text=True,
            timeout=15,
            stdin=subprocess.DEVNULL if in_wsl else None,
            start_new_session=in_wsl,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return _semver_match(completed.stdout) or _semver_match(completed.stderr)


def _request_text(url: str, use_proxy: bool = True, timeout: int = 10) -> str | None:
    if VERSION_REQUEST_TIMEOUT_CAP is not None:
        timeout = min(timeout, VERSION_REQUEST_TIMEOUT_CAP)
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
    environment_note = "" if ENVIRONMENT in (None, native_environment()) else f" · {ENVIRONMENT}"
    lines = [f"AI Usage Monitor v{repo_version()}{environment_note}", "═" * 62]
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
                auto_renew = bool(membership.get("auto_renew"))
                status = membership_end_text(end_after, auto_renew=auto_renew)
                tone = RED if color and end_after < 0 else (YELLOW if color else "")
                lines.append(f"  Membership purchased: {purchased}")
                lines.append(
                    f"  {tone}Membership {'renews' if auto_renew else 'ends'}: "
                    f"{ends} ({status}){RESET if tone else ''}"
                )
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


def _collect_provider(
    provider: str,
    args: argparse.Namespace,
    monitor_config: dict[str, Any],
) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
    provider_errors: list[dict[str, str]] = []
    if provider == "kimi":
        try:
            kimi_result = normalize_kimi(fetch_kimi(kimi_credentials_path(args.kimi_credentials)))
            web_path = kimi_web_credentials_path(args.kimi_web_credentials)
            subscription = None
            if web_path.is_file():
                try:
                    monthly = normalize_kimi_monthly(fetch_kimi_web(web_path))
                    if monthly:
                        kimi_result["windows"].append(monthly["window"])
                        kimi_result.setdefault("extra_lines", []).extend(monthly["extra_lines"])
                except Exception as exc:
                    provider_errors.append({"provider": "Kimi Monthly Total", "error": str(exc)})
                # 会员名称/到期：同一网页网关的 GetSubscription；属增强项，
                # 失败时保持 plan=unknown，不额外报错（月总量的错误已提示网页凭证问题）
                try:
                    subscription = normalize_kimi_subscription(
                        fetch_kimi_web_subscription(web_path)
                    )
                except Exception:
                    subscription = None
            if subscription and subscription.get("plan"):
                kimi_result["plan"] = subscription["plan"]
            # 会员到期：设置页手动配置优先，未配置时用订阅的当前周期终止时间
            if not attach_membership(kimi_result, monitor_config.get("kimi")):
                if subscription and subscription.get("membership"):
                    kimi_result["membership"] = subscription["membership"]
            return kimi_result, provider_errors
        except Exception as exc:
            return None, [{"provider": "Kimi Code", "error": str(exc)}]
    if provider == "codex":
        try:
            codex_result = normalize_codex(
                fetch_codex(codex_credentials_path(args.codex_credentials))
            )
            attach_membership(codex_result, monitor_config.get("openai"))
            return codex_result, []
        except Exception as exc:
            return None, [{"provider": "OpenAI Codex", "error": str(exc)}]
    if provider == "deepseek":
        try:
            deepseek_result = normalize_deepseek(
                fetch_deepseek(args.deepseek_key, args.deepseek_credentials)
            )
            attach_membership(deepseek_result, monitor_config.get("deepseek"))
            return deepseek_result, []
        except Exception as exc:
            return None, [{"provider": "DeepSeek", "error": str(exc)}]
    if provider == "glm":
        try:
            glm_result = normalize_glm(fetch_glm(args.glm_key, args.glm_credentials))
            # 会员到期：设置页手动配置优先；未配置时用订阅接口的续费（重置）日期
            if not attach_membership(glm_result, monitor_config.get("glm")):
                try:
                    membership = normalize_glm_subscription(
                        fetch_glm_subscription(args.glm_key, args.glm_credentials)
                    )
                except Exception:
                    membership = None
                if membership:
                    glm_result["membership"] = membership
            return glm_result, []
        except Exception as exc:
            return None, [{"provider": "GLM", "error": str(exc)}]
    return None, [{"provider": provider, "error": "Unsupported provider"}]


def collect(args: argparse.Namespace) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    results: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    try:
        monitor_config = read_monitor_config(getattr(args, "config", None))
    except MonitorError as exc:
        monitor_config = {}
        errors.append({"provider": "Config", "error": str(exc)})
    order = ["kimi", "codex", "deepseek", "glm"]
    providers = order if args.provider == "all" else [args.provider]
    if (getattr(args, "dashboard", False) or getattr(args, "watch", False)) and len(providers) > 1:
        # Electron 与终端持续看板中 provider 互不依赖，并行查询：单个
        # 网络失败不再阻塞其他卡片；合并时仍按固定顺序输出，避免界面跳动。
        with ThreadPoolExecutor(max_workers=len(providers)) as executor:
            futures = {
                provider: executor.submit(_collect_provider, provider, args, monitor_config)
                for provider in providers
            }
            collected = {provider: futures[provider].result() for provider in providers}
    else:
        collected = {
            provider: _collect_provider(provider, args, monitor_config)
            for provider in providers
        }
    for provider in providers:
        result, provider_errors = collected[provider]
        if result:
            results.append(result)
        errors.extend(provider_errors)
    return results, errors


# --- 会话用量分析（全量模式数据源：Kimi + Codex，GLM/DeepSeek 按模型归因） ----
# 参考 kimi-usage-dashboard（github.com/coconilu/kimi-usage-dashboard）的聚合
# 口径：扫描各 agent CLI 的本地会话日志——Kimi Code 的
# ~/.kimi-code/sessions/**/wire.jsonl（turn 级 usage.record）与 Codex CLI 的
# ~/.codex/sessions/**/rollout-*.jsonl（token_count 事件，取 last_token_usage
# 作为单轮用量）——聚合出每日/每小时 token 趋势、模型细分、缓存命中率、项目
# 排行、年度活动日历与会话明细。GLM / DeepSeek 通常没有独立 CLI 日志，其用量
# 出现在其它 agent 的会话中（通过自定义模型接入），按模型名归因到对应 API。
# 全程只读本地文件，不发起任何网络请求；数据源跟随 --environment 设置（WSL 或
# Windows 侧各自的用户目录）。解析位置按文件增量缓存，重复请求只读取新增字节。

ANALYTICS_CACHE_VERSION = 2
# 记录保留窗口：覆盖年度日历的 365 天并留余量
ANALYTICS_RECORD_RETENTION_DAYS = 400
# 返回给前端的会话明细条数上限（前端仍可自行排序，展示时再截断）
ANALYTICS_SESSION_CAP = 500
# 归因到的 agent（--agent 筛选的可选值）
ANALYTICS_AGENTS = ("all", "kimi", "codex", "glm", "deepseek")


def kimi_sessions_home() -> Path:
    """Kimi Code 数据根目录：KIMI_CODE_HOME 优先，否则当前数据源环境的用户目录。"""
    override = os.environ.get("KIMI_CODE_HOME")
    if override:
        return Path(override).expanduser()
    return env_home() / ".kimi-code"


def codex_sessions_home() -> Path:
    """Codex CLI 数据根目录：CODEX_HOME 优先，否则当前数据源环境的用户目录。"""
    override = os.environ.get("CODEX_HOME")
    if override:
        return Path(override).expanduser()
    return env_home() / ".codex"


def analytics_cache_path() -> Path:
    override = os.environ.get("AI_USAGE_ANALYTICS_CACHE")
    if override:
        return Path(override).expanduser()
    return env_home() / ".cache" / "ai-usage-monitor" / "kimi-usage-cache.json"


def _analytics_agent_of(source: str, model: str) -> str:
    """把一条 turn 记录归因到 agent/API：GLM、DeepSeek 以自定义模型接入
    其它 CLI（模型名可识别），Codex 用量来自 codex 会话，其余归 kimi。"""
    lowered = (model or "").lower()
    if "glm" in lowered or "zhipu" in lowered or lowered.startswith("zai/"):
        return "glm"
    if "deepseek" in lowered:
        return "deepseek"
    if source == "codex":
        return "codex"
    return source


def _analytics_normalize_ts(value: int) -> int | None:
    """规整时间戳：毫秒值按秒解释（Kimi 日志两种单位都出现过），
    超出 2000~2200 年合理范围的记录视为脏数据丢弃。"""
    if value > 1e11:
        value //= 1000
    if not (946684800 <= value <= 7258118400):
        return None
    return value


def _analytics_parse_line(line: str) -> tuple[int, str, int, int, int, int] | None:
    """解析一行 wire.jsonl，返回 (时间, 模型, 输入, 输出, 缓存读, 缓存写) 或 None。"""
    if '"usage.record"' not in line:
        return None
    try:
        rec = json.loads(line)
    except ValueError:
        return None
    if not isinstance(rec, dict) or rec.get("type") != "usage.record":
        return None
    if rec.get("usageScope") != "turn" or not isinstance(rec.get("time"), (int, float)):
        return None
    ts = _analytics_normalize_ts(int(rec["time"]))
    if ts is None:
        return None
    usage = rec.get("usage")
    if not isinstance(usage, dict):
        usage = {}

    def count(key: str) -> int:
        value = usage.get(key)
        return int(value) if isinstance(value, (int, float)) and value > 0 else 0

    return (
        ts,
        str(rec.get("model") or "(unknown)"),
        count("inputOther"),
        count("output"),
        count("inputCacheRead"),
        count("inputCacheCreation"),
    )


_CODEX_MODEL_RE = re.compile(r'"model":\s*"([^"]+)"')
_CODEX_TIMESTAMP_RE = re.compile(r'"timestamp":\s*"([^"]+)"')


def _codex_parse_timestamp(text: str) -> int | None:
    """Codex 日志的 ISO8601 时间（如 2026-07-30T14:44:44.726Z）转 epoch 秒。"""
    match = _CODEX_TIMESTAMP_RE.search(text)
    if not match:
        return None
    raw = match.group(1).strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return int(moment.timestamp())


def _codex_parse_token_line(
    line: str, model: str | None, session_id: str
) -> list | None:
    """解析 Codex rollout 的 token_count 事件行，返回 turn 记录或 None。

    info.last_token_usage 是该事件的增量用量；total_token_usage 是会话累计值，
    不能按轮累加。输入里含缓存部分（OpenAI 口径），需要拆成非缓存输入与缓存读。
    """
    if '"token_count"' not in line:
        return None
    try:
        rec = json.loads(line)
    except ValueError:
        return None
    payload = rec.get("payload")
    if not isinstance(payload, dict) or payload.get("type") != "token_count":
        return None
    info = payload.get("info")
    if not isinstance(info, dict):
        return None
    usage = info.get("last_token_usage")
    if not isinstance(usage, dict):
        return None

    def count(key: str) -> int:
        value = usage.get(key)
        return int(value) if isinstance(value, (int, float)) and value > 0 else 0

    cached = count("cached_input_tokens")
    input_total = count("input_tokens")
    ts = _codex_parse_timestamp(line)
    if ts is None:
        return None
    return [
        ts,
        model or "(unknown)",
        max(0, input_total - cached),
        count("output_tokens"),
        cached,
        count("cache_write_input_tokens"),
        session_id,
    ]


def _codex_parse_meta_cwd(line: str) -> tuple[str, str] | None:
    """从 session_meta 行取 (session_id, cwd)，用作项目目录映射。"""
    if '"session_meta"' not in line:
        return None
    try:
        rec = json.loads(line)
    except ValueError:
        return None
    payload = rec.get("payload")
    if not isinstance(payload, dict) or payload.get("type") != "session_meta":
        return None
    cwd = payload.get("cwd")
    session_id = payload.get("session_id") or payload.get("id")
    if isinstance(cwd, str) and cwd and isinstance(session_id, str) and session_id:
        return session_id, cwd
    return None


def _analytics_read_new_lines(path: Path, offset: int) -> tuple[list[str], int, bool]:
    """从 offset 起读取完整行，返回 (行列表, 新 offset, 是否从头重读)。

    只处理到最后一个换行符为止，不完整的行尾留给下一次；文件被截断
    （size < offset，例如日志轮转）时从头读取，调用方需先丢弃该文件
    的旧记录以免重复统计。
    """
    try:
        size = path.stat().st_size
    except OSError:
        return [], offset, False
    restarted = size < offset
    start = 0 if restarted else offset
    if size == start:
        return [], start, False
    try:
        with path.open("rb") as handle:
            handle.seek(start)
            data = handle.read(size - start)
    except OSError:
        return [], start, False
    last_newline = data.rfind(b"\n")
    if last_newline < 0:
        return [], start, False
    lines = data[:last_newline].decode("utf-8", errors="replace").split("\n")
    return lines, start + last_newline + 1, restarted


def _analytics_session_id(path: Path) -> str:
    for part in path.parts:
        if part.startswith("session_"):
            return part
    return "(unknown)"


def _codex_default_session_id(path: Path) -> str:
    """Codex rollout 文件名形如 rollout-<ts>-<uuid>.jsonl，取 uuid 当会话标识。"""
    stem = path.stem
    return "codex-" + (stem.rsplit("-", 1)[-1] or stem)


def _analytics_wire_files(sessions_root: Path, selector) -> list[Path]:
    if not sessions_root.is_dir():
        return []
    files: list[Path] = []
    stack = [sessions_root]
    while stack:
        current = stack.pop()
        try:
            entries = sorted(current.iterdir())
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_dir():
                    stack.append(entry)
                elif selector(entry.name):
                    files.append(entry)
            except OSError:
                continue
    return files


def _analytics_load_cache(cache_path: Path) -> dict[str, dict[str, Any]]:
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict) or data.get("version") != ANALYTICS_CACHE_VERSION:
        return {}
    files = data.get("files")
    if not isinstance(files, dict):
        return {}
    state: dict[str, dict[str, Any]] = {}
    for raw_path, entry in files.items():
        if not (isinstance(entry, dict) and isinstance(entry.get("offset"), int)):
            continue
        records = entry.get("records")
        if not isinstance(records, list):
            continue
        source = entry.get("source")
        cwds = entry.get("cwds")
        state[str(raw_path)] = {
            "offset": entry["offset"],
            "records": records,
            "source": source if source in ("kimi", "codex") else "kimi",
            "cwds": cwds if isinstance(cwds, dict) else {},
        }
    return state


def _analytics_scan_home(
    sessions_root: Path,
    source: str,
    selector,
    default_session_id,
    files_state: dict[str, dict[str, Any]],
    cutoff: int,
) -> bool:
    """增量扫描一个 agent 的会话目录，把状态合并进 files_state。

    返回是否有变化（需要写缓存）。文件消失（日志被清理）时保留其已解析的
    历史记录，只把 offset 置为 -1；同路径文件再次出现时当作重新读取，替换
    旧记录避免重复统计。
    """
    dirty = False
    wire_files = _analytics_wire_files(sessions_root, selector)
    live = {str(wire) for wire in wire_files}
    for key in files_state:
        if files_state[key].get("source") == source and key not in live \
                and files_state[key]["offset"] != -1:
            files_state[key]["offset"] = -1
            dirty = True
    for wire in wire_files:
        key = str(wire)
        state = files_state.get(key)
        if state is None:
            state = {"offset": 0, "records": [], "source": source, "cwds": {}}
            files_state[key] = state
            dirty = True
        if state["offset"] == -1:
            state["offset"] = 0
            state["records"] = []
            state["cwds"] = {}
            dirty = True
        lines, new_offset, restarted = _analytics_read_new_lines(wire, state["offset"])
        state["offset"] = new_offset
        if restarted:
            # 文件被截断（轮转/重写）：旧记录作废，从头统计该文件
            state["records"] = []
            state["cwds"] = {}
            dirty = True
        cwds: dict[str, str] = state.setdefault("cwds", {})
        if source == "codex":
            # 模型名出现在 thread_settings 等事件行里，逐行跟踪最近一次取值
            session_model: str | None = None
            session_id = default_session_id(wire)
        else:
            session_id = default_session_id(wire)
        for line in lines:
            if source == "kimi":
                parsed = _analytics_parse_line(line)
                if parsed:
                    state["records"].append([*parsed, session_id])
                    dirty = True
                continue
            if '"model":"' in line:
                match = _CODEX_MODEL_RE.search(line)
                if match:
                    session_model = match.group(1)
            meta = _codex_parse_meta_cwd(line)
            if meta:
                # rollout 文件与会话一一对应，统一用文件级会话 ID 存项目目录
                cwds[session_id] = meta[1]
                dirty = True
            parsed = _codex_parse_token_line(line, session_model, session_id)
            if parsed:
                state["records"].append(parsed)
                dirty = True
        before = len(state["records"])
        cleaned = []
        for record in state["records"]:
            ts = _analytics_normalize_ts(record[0])
            if ts is None or ts < cutoff:
                continue
            record[0] = ts
            cleaned.append(record)
        if len(cleaned) != before:
            state["records"] = cleaned
            dirty = True
    return dirty


def _analytics_scan(
    kimi_home: Path | None,
    codex_home: Path | None,
    cache_path: Path,
    cutoff: int,
) -> dict[str, dict[str, Any]]:
    """增量扫描全部 agent 的会话日志，返回 {文件路径: 文件状态}（含缓存旧记录）。"""
    files_state = _analytics_load_cache(cache_path)
    dirty = False
    if kimi_home is not None:
        if _analytics_scan_home(
            kimi_home / "sessions",
            "kimi",
            lambda name: name == "wire.jsonl",
            _analytics_session_id,
            files_state,
            cutoff,
        ):
            dirty = True
    if codex_home is not None:
        if _analytics_scan_home(
            codex_home / "sessions",
            "codex",
            lambda name: name.startswith("rollout-") and name.endswith(".jsonl"),
            _codex_default_session_id,
            files_state,
            cutoff,
        ):
            dirty = True
    if not dirty:
        return files_state
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        write_private_json(
            cache_path,
            {"version": ANALYTICS_CACHE_VERSION, "files": files_state},
        )
    except OSError:
        pass  # 缓存写失败只影响下次扫描速度，不影响本次结果
    return files_state


def _analytics_session_index(home: Path) -> dict[str, str]:
    index: dict[str, str] = {}
    try:
        text = (home / "session_index.jsonl").read_text(encoding="utf-8")
    except OSError:
        return index
    for line in text.split("\n"):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict) and rec.get("sessionId") and rec.get("workDir"):
            index[str(rec["sessionId"])] = str(rec["workDir"])
    return index


def _analytics_date(moment: datetime) -> str:
    return f"{moment.year:04d}-{moment.month:02d}-{moment.day:02d}"


def _analytics_project_name(work_dir: str) -> str:
    if not work_dir or work_dir == "(unknown)":
        return "(unknown)"
    base = re.split(r"[\\/]+", work_dir.rstrip("/\\"))[-1]
    return base or work_dir


def build_session_analytics(
    kimi_home: Path | None,
    codex_home: Path | None = None,
    days: int = 30,
    cache_path: Path | None = None,
    now: datetime | None = None,
    agent: str = "all",
) -> dict[str, Any]:
    """把增量扫描到的 turn 级记录聚合成全量模式看板所需的一份数据。

    agent="all" 聚合全部来源；指定单个 agent（kimi/codex/glm/deepseek）时，
    仅统计按模型归因后属于该 agent 的记录。
    """
    days = max(1, min(365, int(days)))
    agent = agent if agent in ANALYTICS_AGENTS else "all"
    moment = now or datetime.now().astimezone()
    cutoff = int(moment.timestamp()) - ANALYTICS_RECORD_RETENTION_DAYS * 86400
    files_state = _analytics_scan(
        kimi_home, codex_home, cache_path or analytics_cache_path(), cutoff
    )
    session_index = (
        _analytics_session_index(kimi_home) if kimi_home is not None else {}
    )

    today = moment.replace(hour=0, minute=0, second=0, microsecond=0)
    day_list = [_analytics_date(today - timedelta(offset)) for offset in range(days - 1, -1, -1)]
    day_set = set(day_list)
    today_str = day_list[-1]

    daily = {
        day: {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "requests": 0}
        for day in day_list
    }
    hourly = [
        {"hour": hour, "input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "requests": 0}
        for hour in range(24)
    ]
    daily_model: dict[str, dict[str, int]] = {}
    daily_agent: dict[str, dict[str, int]] = {}
    model_total: dict[str, int] = {}
    model_agent: dict[str, str] = {}
    project_total: dict[tuple[str, str], int] = {}
    sessions: dict[str, dict[str, Any]] = {}
    calendar_days: dict[str, list[Any]] = {}
    agents_seen: set[str] = set()
    agent_requests: dict[str, int] = {}

    for state in files_state.values():
        source = state.get("source", "kimi")
        cwds = state.get("cwds") or {}
        for ts, model, inp, out, cache_read, cache_creation, session_id in state["records"]:
            record_agent = _analytics_agent_of(source, model)
            if agent != "all" and record_agent != agent:
                continue
            if source == "codex":
                work_dir = cwds.get(session_id, "(unknown)")
            else:
                work_dir = session_index.get(session_id, "(unknown)")
            local = datetime.fromtimestamp(ts)
            date = _analytics_date(local)
            total = inp + out + cache_read + cache_creation
            agents_seen.add(record_agent)
            cell = calendar_days.setdefault(date, [date, 0, 0])
            cell[1] += total
            cell[2] += 1
            if date not in day_set:
                continue
            bucket = daily[date]
            bucket["input"] += inp
            bucket["output"] += out
            bucket["cache_read"] += cache_read
            bucket["cache_creation"] += cache_creation
            bucket["requests"] += 1
            agent_requests[record_agent] = agent_requests.get(record_agent, 0) + 1
            agents_of_day = daily_agent.setdefault(date, {})
            agents_of_day[record_agent] = agents_of_day.get(record_agent, 0) + total
            if date == today_str:
                hour_bucket = hourly[local.hour]
                hour_bucket["input"] += inp
                hour_bucket["output"] += out
                hour_bucket["cache_read"] += cache_read
                hour_bucket["cache_creation"] += cache_creation
                hour_bucket["requests"] += 1
            models_of_day = daily_model.setdefault(date, {})
            models_of_day[model] = models_of_day.get(model, 0) + total
            model_total[model] = model_total.get(model, 0) + total
            model_agent.setdefault(model, record_agent)
            project_key = (_analytics_project_name(work_dir), work_dir)
            project_total[project_key] = project_total.get(project_key, 0) + total

            session = sessions.get(session_id)
            if session is None:
                session = {
                    "session_id": session_id,
                    "project": project_key[0],
                    "work_dir": work_dir,
                    "agent": record_agent,
                    "_agent_totals": {record_agent: total},
                    "models": set(),
                    "input": 0,
                    "output": 0,
                    "cache_read": 0,
                    "cache_creation": 0,
                    "requests": 0,
                    "first": ts,
                    "last": ts,
                    "total": 0,
                }
                sessions[session_id] = session
            session["models"].add(model)
            session["_agent_totals"][record_agent] = (
                session["_agent_totals"].get(record_agent, 0) + total
            )
            session["input"] += inp
            session["output"] += out
            session["cache_read"] += cache_read
            session["cache_creation"] += cache_creation
            session["requests"] += 1
            session["first"] = min(session["first"], ts)
            session["last"] = max(session["last"], ts)
            session["total"] += total

    daily_out = []
    for day in day_list:
        bucket = daily[day]
        input_total = bucket["input"] + bucket["cache_read"] + bucket["cache_creation"]
        daily_out.append({
            "date": day,
            "input": bucket["input"],
            "output": bucket["output"],
            "cache_read": bucket["cache_read"],
            "cache_creation": bucket["cache_creation"],
            "total": bucket["input"] + bucket["output"] + bucket["cache_read"] + bucket["cache_creation"],
            "requests": bucket["requests"],
            "cache_hit_rate": round(bucket["cache_read"] / input_total, 4) if input_total else 0,
        })
    models = sorted(model_total, key=lambda name: model_total[name], reverse=True)
    agent_totals: dict[str, int] = {}
    for day, agents_of_day in daily_agent.items():
        for name, total in agents_of_day.items():
            agent_totals[name] = agent_totals.get(name, 0) + total
    week_total = sum(entry["total"] for entry in daily_out[-7:])
    prev_week_total = (
        sum(entry["total"] for entry in daily_out[-14:-7]) if days >= 14 else 0
    )
    denominator = sum(
        entry["input"] + entry["cache_read"] + entry["cache_creation"] for entry in daily_out
    )
    session_rows = sorted(
        sessions.values(), key=lambda item: item["total"], reverse=True
    )[:ANALYTICS_SESSION_CAP]
    for session in session_rows:
        session["models"] = sorted(session["models"])
        # 会话归属：按该会话内累计 token 最多的 agent 标注
        session["agent"] = max(
            session["_agent_totals"].items(), key=lambda item: item[1]
        )[0]
        del session["_agent_totals"]
    agent_rank = [
        {"agent": name, "total": total, "requests": agent_requests.get(name, 0)}
        for name, total in sorted(agent_totals.items(), key=lambda item: item[1], reverse=True)
    ]
    return {
        "generated_at": moment.strftime("%Y-%m-%d %H:%M:%S"),
        "days": days,
        "agent": agent,
        "agents": sorted(agents_seen),
        "date_range": [day_list[0], day_list[-1]],
        "day_list": day_list,
        "daily": daily_out,
        "daily_agent": {day: daily_agent.get(day, {}) for day in day_list},
        "today_hourly": hourly,
        "models": models,
        "daily_model": {
            day: [daily_model.get(day, {}).get(model, 0) for model in models]
            for day in day_list
        },
        "model_rank": [
            {"model": model, "total": model_total[model], "agent": model_agent.get(model, "")}
            for model in models
        ],
        "agent_rank": agent_rank,
        "project_rank": [
            {"name": name, "path": path, "total": total}
            for (name, path), total in sorted(
                project_total.items(), key=lambda item: item[1], reverse=True
            )
        ],
        "calendar": {
            "range": [_analytics_date(today - timedelta(days=364)), today_str],
            "days": sorted(calendar_days.values(), key=lambda cell: cell[0]),
        },
        "sessions": session_rows,
        "kpi": {
            "week_total": week_total,
            "prev_week_total": prev_week_total,
            "week_over_week": (
                round((week_total - prev_week_total) / prev_week_total, 4)
                if prev_week_total
                else None
            ),
            "today_total": daily_out[-1]["total"],
            "cache_hit_rate": (
                round(
                    sum(entry["cache_read"] for entry in daily_out) / denominator, 4
                )
                if denominator
                else 0
            ),
            "active_sessions": len(sessions),
        },
    }


def analytics_payload(days: int, agent: str = "all") -> dict[str, Any]:
    kimi_home = kimi_sessions_home()
    codex_home = codex_sessions_home()
    if not kimi_home.is_dir() and not codex_home.is_dir():
        return {
            "ok": False,
            "error": f"No agent data directory found (kimi: {kimi_home}, codex: {codex_home})",
        }
    try:
        analytics = build_session_analytics(
            kimi_home if kimi_home.is_dir() else None,
            codex_home if codex_home.is_dir() else None,
            days=days,
            agent=agent,
        )
    except MonitorError as exc:
        return {"ok": False, "error": str(exc)}
    except (OSError, ValueError, TypeError) as exc:
        return {"ok": False, "error": f"Analytics failed: {exc}"}
    sources = []
    if kimi_home.is_dir():
        sources.append(str(kimi_home))
    if codex_home.is_dir():
        sources.append(str(codex_home))
    analytics["source"] = " · ".join(sources)
    return {"ok": True, "analytics": analytics}


@contextmanager
def keyboard_refresh_mode(stream):
    """Temporarily make Ctrl+R / Ctrl+E / Ctrl+L available without Enter."""
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
            try:
                termios.tcsetattr(fd, termios.TCSADRAIN, original_settings)
            except (OSError, ValueError):
                # 终端已关闭或其前台进程组被外部程序破坏时，恢复可能返回 EIO；
                # 此处不能用第二个异常掩盖真正的退出原因。
                pass


def reclaim_terminal_foreground(stream) -> bool:
    """Reclaim the controlling terminal after a WSL interop GUI launch.

    Some terminal hosts let the short-lived Windows interop relay replace the
    foreground process group.  Ignore SIGTTOU while restoring our own group so
    the next keyboard read cannot suspend the monitor as a background job.
    """
    if os.name == "nt":
        return True
    try:
        if not stream.isatty():
            return False
        fd = stream.fileno()
        own_group = os.getpgrp()
        if os.tcgetpgrp(fd) == own_group:
            return True
        previous_handler = signal.getsignal(signal.SIGTTOU)
        signal.signal(signal.SIGTTOU, signal.SIG_IGN)
        try:
            os.tcsetpgrp(fd, own_group)
        finally:
            signal.signal(signal.SIGTTOU, previous_handler)
        return os.tcgetpgrp(fd) == own_group
    except (AttributeError, OSError, ValueError):
        return False


def stop_previous_watch_instances(
    proc_root: Path = Path("/proc"),
    script_path: Path | None = None,
    wait_for_exit: bool = True,
) -> list[int]:
    """Terminate older watch processes for this exact monitor script.

    Electron dashboard fetch workers do not carry --watch/-w and are never
    selected.  Restricting the scan to the current uid and resolved script path
    avoids touching unrelated Python processes.
    """
    if os.name == "nt" or not proc_root.is_dir():
        return []
    current_pid = os.getpid()
    current_uid = os.getuid()
    expected_script = (script_path or Path(__file__)).resolve()
    stopped: list[int] = []
    for process_dir in proc_root.iterdir():
        if not process_dir.name.isdigit():
            continue
        pid = int(process_dir.name)
        if pid == current_pid:
            continue
        try:
            if process_dir.stat().st_uid != current_uid:
                continue
            argv = [
                os.fsdecode(part)
                for part in (process_dir / "cmdline").read_bytes().split(b"\0")
                if part
            ]
            if not ({"--watch", "-w"} & set(argv)):
                continue
            process_cwd = Path(os.readlink(process_dir / "cwd"))
            matches_script = any(
                (Path(arg) if Path(arg).is_absolute() else process_cwd / arg).resolve()
                == expected_script
                for arg in argv[1:]
                if not arg.startswith("-")
            )
            if not matches_script:
                continue
            os.kill(pid, signal.SIGTERM)
            # A stopped process must be continued before it can consume SIGTERM.
            os.kill(pid, signal.SIGCONT)
            stopped.append(pid)
        except (OSError, ValueError):
            continue
    if stopped and wait_for_exit:
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            if not any((proc_root / str(pid)).exists() for pid in stopped):
                break
            time.sleep(0.02)
    return stopped


# 最近一次拉起的 Electron 主进程,用于退出时一并关闭
launched_window_proc = None


def running_in_wsl() -> bool:
    """Return whether this Python process is running inside WSL."""
    return os.name != "nt" and bool(
        os.environ.get("WSL_DISTRO_NAME") or os.environ.get("WSL_INTEROP")
    )


def windows_path_from_wsl(path: Path) -> str:
    """Translate an existing WSL path for consumption by a Windows process."""
    result = subprocess.run(
        ["wslpath", "-w", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def disable_core_dumps() -> None:
    """子进程预回调：关闭 core dump（WSL 的 wsl-crashes 目录会被撑爆）。"""
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except Exception:
        pass


def prepare_windows_launcher(app_dir: Path) -> tuple[str, str]:
    """Copy the PowerShell launcher locally so Windows does not execute it over UNC."""
    windows_dir = Path("/mnt/c/Windows")
    command_cwd = windows_dir if windows_dir.is_dir() else None
    result = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-Command",
            '[Environment]::GetFolderPath("LocalApplicationData")',
        ],
        cwd=command_cwd,
        check=True,
        capture_output=True,
        text=True,
    )
    windows_local_app_data = result.stdout.strip()
    if not windows_local_app_data:
        raise OSError("Windows LocalApplicationData path is unavailable")
    local_app_data = subprocess.run(
        ["wslpath", "-u", windows_local_app_data],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    runtime_dir = Path(local_app_data) / "AIUsageMonitor"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    local_launcher = runtime_dir / "launch-windows.ps1"
    shutil.copy2(app_dir / "launch-windows.ps1", local_launcher)
    return windows_path_from_wsl(local_launcher), windows_path_from_wsl(app_dir)


def launch_usage_window() -> None:
    """启动原生 Electron 悬浮看板(detached,不阻塞终端监控)。

    WSL 中通过 powershell.exe 拉起 Windows 原生 Electron，避开 WSLg 图形链路；
    其它平台保留本地 Electron 启动方式。窗口独立于终端运行，关闭后可再次
    按 Ctrl+E 重新打开。
    """
    global launched_window_proc
    # v0.3.0 起桌面应用统一在仓库 app/ 目录（React + Rust 后端）；旧的纯 JS
    # 看板已归档到 archive/electron-app-plain。
    app_dir = REPO_ROOT / "app"

    if running_in_wsl():
        try:
            windows_launcher, windows_source_dir = prepare_windows_launcher(app_dir)
            distro = os.environ.get("WSL_DISTRO_NAME", "")
            kwargs: dict[str, Any] = {
                "stdin": subprocess.DEVNULL,
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
            }
            # 不要在 WSL 中对 Windows 可执行文件使用 start_new_session：
            # WSL interop relay 可能把伪终端的前台进程组切给短命的 PowerShell
            # 会话，PowerShell 退出后 monitor 一读键盘就收到 SIGTTIN/SIGTTOU，
            # Bash 随即显示 `Stopped`。Windows Electron 由 launcher 自行脱离，
            # PowerShell 的标准流也已重定向，不需要 Unix 侧再创建会话。
            # Windows 可执行文件无法把 UNC WSL 路径设为当前目录；使用 Windows
            # 目录可避免启动时出现路径转换警告，脚本位置仍通过 -File 显式传入。
            windows_dir = Path("/mnt/c/Windows")
            if windows_dir.is_dir():
                kwargs["cwd"] = windows_dir
            subprocess.Popen(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-WindowStyle",
                    "Hidden",
                    "-File",
                    windows_launcher,
                    "-SourceDir",
                    windows_source_dir,
                    "-Distro",
                    distro,
                    "-MonitorScript",
                    str(Path(__file__).resolve()),
                ],
                **kwargs,
            )
            # PowerShell 安装/同步后即退出，真正的 Windows Electron 是独立进程；
            # 不记录为终端子进程，以免退出 watch 时误关从 Windows 启动的看板。
            launched_window_proc = None
            return
        except (OSError, subprocess.SubprocessError) as exc:
            print(f"\nFailed to launch native Windows usage window: {exc}", flush=True)
            time.sleep(3)
            return

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
            # WSLg 下 Electron 崩溃时 WSL 会把完整内存转储写进 Windows Temp
            # （可达数百 GB），这里关闭 core dump
            if running_in_wsl():
                kwargs["preexec_fn"] = disable_core_dumps
        launched_window_proc = subprocess.Popen([str(electron_bin), "."], **kwargs)
    except OSError as exc:
        print(f"\nFailed to launch usage window: {exc}", flush=True)
        time.sleep(3)


def kill_usage_window() -> None:
    """退出(含 Ctrl+C)时关闭已拉起的 Electron 窗口。

    仅管理直接启动的本地 Electron 进程。WSL 中的 Windows 原生窗口具有独立生命
    周期，用户可从开始菜单或其它终端复用，因此不会随当前 watch 进程退出而关闭。
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
) -> bool | str:
    """Wait for the interval or a shortcut; return its action.

    Ctrl+E 在等待期间随时拉起/唤出 Electron 悬浮看板窗口,不中断等待。
    Ctrl+L 打开手动登录选择。
    """
    if not keyboard_enabled:
        time.sleep(interval)
        return False

    stream = stream or sys.stdin
    if not reclaim_terminal_foreground(stream):
        # 无法安全读取控制终端时退化为定时刷新；直接 read 会触发 SIGTTIN，
        # Bash 会把进程标记为 Stopped。
        time.sleep(interval)
        return False
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
                if ch == "\x0c":  # Ctrl+L
                    return "login"
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
        if ch == "\x0c":  # Ctrl+L
            return "login"


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


def enable_dashboard_request_policy() -> None:
    """Electron 后台的快速失败策略；不影响终端命令的容错时间。"""
    global REQUEST_TIMEOUT_CAP, GET_ATTEMPTS_CAP, VERSION_REQUEST_TIMEOUT_CAP
    # 看板 60 秒一刷、整轮 45 秒上限（Electron 侧强杀），provider 并行查询。
    # 其他 provider 单次 10 秒 + 一次同轮重试；Codex 经代理访问 chatgpt.com
    # 延迟高，单次上限放宽到 20 秒（见 CODEX_DASHBOARD_TIMEOUT_CAP）。
    REQUEST_TIMEOUT_CAP = 10
    GET_ATTEMPTS_CAP = 2
    VERSION_REQUEST_TIMEOUT_CAP = 3


def main() -> int:
    parser = argparse.ArgumentParser(description="Standalone Kimi Code / Codex / DeepSeek / GLM usage monitor for the terminal")
    parser.add_argument("--watch", "-w", action="store_true", help="Keep refreshing")
    parser.add_argument("--interval", "-i", type=int, default=180, help="Refresh interval in seconds (default: 180)")
    parser.add_argument("--provider", choices=("all", "kimi", "codex", "deepseek", "glm"), default="all")
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
    parser.add_argument("--deepseek-key", help="DeepSeek API key (or set DEEPSEEK_API_KEY)")
    parser.add_argument("--deepseek-credentials", help="Path to DeepSeek credentials JSON file")
    parser.add_argument("--glm-key", help="GLM API key (or set GLM_API_KEY / ZHIPU_API_KEY)")
    parser.add_argument("--glm-credentials", help="Path to GLM credentials JSON file")
    parser.add_argument("--json", action="store_true", help="Output JSON")
    parser.add_argument("--no-color", action="store_true", help="Disable ANSI colors")
    parser.add_argument("--days", type=int, default=30, help="Analytics window in days (default: 30)")
    parser.add_argument(
        "--agent",
        choices=ANALYTICS_AGENTS,
        default="all",
        help="Analytics agent filter: all/kimi/codex/glm/deepseek (default: all)",
    )
    parser.add_argument("--dashboard", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument(
        "--environment",
        choices=("wsl", "windows"),
        help="Data source environment (default: settings file, then the native environment)",
    )
    maintenance = parser.add_mutually_exclusive_group()
    maintenance.add_argument("--api-key-status", action="store_true", help=argparse.SUPPRESS)
    maintenance.add_argument("--configure-api-keys", action="store_true", help=argparse.SUPPRESS)
    maintenance.add_argument("--get-settings", action="store_true", help=argparse.SUPPRESS)
    maintenance.add_argument("--set-settings", action="store_true", help=argparse.SUPPRESS)
    maintenance.add_argument("--analytics", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.dashboard:
        # 快速失败策略只适用于 Electron 后台；终端 watch 保留完整超时与重试，
        # 否则代理访问 chatgpt.com 偶发抖动就会被放大成频繁的报错。
        enable_dashboard_request_policy()
    if args.interval < 5:
        parser.error("--interval must be at least 5 seconds")
    if args.json and args.watch:
        parser.error("--json cannot be used together with --watch")

    enable_windows_ansi()
    if args.get_settings:
        print(json.dumps(get_settings_payload(), ensure_ascii=False))
        return 0
    if args.set_settings:
        try:
            payload = json.loads(sys.stdin.read())
            result = update_settings(payload)
            print(json.dumps(result, ensure_ascii=False))
            return 0
        except (MonitorError, ValueError) as exc:
            print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
            return 1
    try:
        resolve_environment(args.environment)
    except MonitorError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    if args.api_key_status:
        print(json.dumps({"ok": True, "status": api_key_status()}, ensure_ascii=False))
        return 0
    if args.configure_api_keys:
        try:
            payload = json.loads(sys.stdin.read())
            result = configure_api_keys(payload)
            print(json.dumps(result, ensure_ascii=False))
            return 0
        except (MonitorError, ValueError) as exc:
            print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
            return 1
    if args.analytics:
        # 全量模式看板数据：只读本地会话日志，不联网；在 resolve_environment
        # 之后执行，保证 env=windows 时扫的是 Windows 侧的会话目录
        print(json.dumps(analytics_payload(args.days, args.agent), ensure_ascii=False))
        return 0
    if args.watch:
        stop_previous_watch_instances()
        if sys.stdout.isatty():
            print(f"\033[2J\033[HAI Usage Monitor v{repo_version()}\nLoading usage data…", flush=True)
    keyboard_context = keyboard_refresh_mode(sys.stdin) if args.watch else nullcontext(False)
    try:
        with keyboard_context as keyboard_enabled:
            if args.watch:
                launch_usage_window()  # 运行 usage 即自动打开悬浮窗口
            while True:
                results, errors = collect(args)
                versions = collect_versions({result["provider"] for result in results})
                if args.json:
                    print(json.dumps({
                        "accounts": results,
                        "errors": errors,
                        "versions": versions,
                        "monitor_version": repo_version(),
                        "environment": ENVIRONMENT or native_environment(),
                        "native_environment": native_environment(),
                        "windows_setup_script": windows_setup_script_unc(),
                    }, ensure_ascii=False, indent=2))
                else:
                    color = sys.stdout.isatty() and not args.no_color
                    if args.watch and sys.stdout.isatty():
                        print("\033[2J\033[H", end="")
                    print(render(results, errors, color, versions))
                    if args.watch:
                        shortcuts = (
                            "Ctrl+R refresh, Ctrl+E window, Ctrl+L login, Ctrl+C exit"
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
                action = wait_for_next_refresh(args.interval, keyboard_enabled)
                if action == "login":
                    prompt_agent_login()
    except KeyboardInterrupt:
        print("\nExited usage monitor.")
        return 0
    finally:
        if args.watch:
            kill_usage_window()


if __name__ == "__main__":
    raise SystemExit(main())
