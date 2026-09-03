from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import usage_monitor


class NormalizeTests(unittest.TestCase):
    def test_env_enabled(self):
        with mock.patch.dict(os.environ, {"TEST_FLAG": "yes"}):
            self.assertTrue(usage_monitor.env_enabled("TEST_FLAG"))
        with mock.patch.dict(os.environ, {"TEST_FLAG": "0"}):
            self.assertFalse(usage_monitor.env_enabled("TEST_FLAG", default=True))

    def test_dashboard_request_policy_caps_timeout_without_same_round_retry(self):
        with mock.patch.object(usage_monitor, "REQUEST_TIMEOUT_CAP", 6), \
                mock.patch.object(usage_monitor, "GET_ATTEMPTS_CAP", 1), \
                mock.patch.object(
                    usage_monitor.urllib.request,
                    "urlopen",
                    side_effect=usage_monitor.urllib.error.URLError("offline"),
                ) as urlopen:
            with self.assertRaisesRegex(
                usage_monitor.MonitorError,
                "Network request failed: offline",
            ):
                usage_monitor.request_json("https://example.invalid", timeout=30)

        self.assertEqual(urlopen.call_count, 1)
        self.assertTrue(all(call.kwargs["timeout"] == 6 for call in urlopen.call_args_list))

    def test_dashboard_timeout_cap_can_be_relaxed_per_request(self):
        with mock.patch.object(usage_monitor, "REQUEST_TIMEOUT_CAP", 10), \
                mock.patch.object(usage_monitor, "GET_ATTEMPTS_CAP", 1), \
                mock.patch.object(
                    usage_monitor.urllib.request,
                    "urlopen",
                    side_effect=usage_monitor.urllib.error.URLError("offline"),
                ) as urlopen:
            with self.assertRaises(usage_monitor.MonitorError):
                usage_monitor.request_json(
                    "https://example.invalid",
                    timeout=30,
                    timeout_cap=usage_monitor.CODEX_DASHBOARD_TIMEOUT_CAP,
                )
            with self.assertRaises(usage_monitor.MonitorError):
                usage_monitor.request_json("https://example.invalid", timeout=30)

        self.assertEqual(urlopen.call_args_list[0].kwargs["timeout"], 20)
        self.assertEqual(urlopen.call_args_list[1].kwargs["timeout"], 10)


class EnvironmentTests(unittest.TestCase):
    def test_repo_version_reads_root_version_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "VERSION").write_text("9.9.9\n", encoding="utf-8")
            with mock.patch.object(usage_monitor, "REPO_ROOT", root):
                self.assertEqual(usage_monitor.repo_version(), "9.9.9")

    def test_repo_version_missing_returns_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(usage_monitor, "REPO_ROOT", Path(tmp)):
                self.assertEqual(usage_monitor.repo_version(), "unknown")

    def test_settings_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings_file = Path(tmp) / "settings.json"
            with mock.patch.dict(os.environ, {"AI_USAGE_SETTINGS_PATH": str(settings_file)}), \
                    mock.patch.object(
                        usage_monitor, "available_environments", return_value=["wsl", "windows"]
                    ):
                payload = usage_monitor.get_settings_payload()
                self.assertEqual(payload["environment"], "wsl")
                result = usage_monitor.update_settings({"environment": "windows"})
                self.assertTrue(result["ok"])
                payload = usage_monitor.get_settings_payload()
                self.assertEqual(payload["environment"], "windows")

    def test_update_settings_rejects_unavailable_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings_file = Path(tmp) / "settings.json"
            with mock.patch.dict(os.environ, {"AI_USAGE_SETTINGS_PATH": str(settings_file)}), \
                    mock.patch.object(
                        usage_monitor, "available_environments", return_value=["linux"]
                    ):
                with self.assertRaises(usage_monitor.MonitorError):
                    usage_monitor.update_settings({"environment": "windows"})

    def test_windows_environment_maps_credential_paths(self):
        profile = Path("/mnt/c/Users/test")
        with mock.patch.object(usage_monitor, "ENVIRONMENT", "windows"), \
                mock.patch.object(usage_monitor, "running_in_wsl", return_value=True), \
                mock.patch.object(usage_monitor, "windows_user_profile", return_value=profile), \
                mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                usage_monitor.codex_credentials_path(), profile / ".codex" / "auth.json"
            )
            self.assertEqual(
                usage_monitor.deepseek_credentials_path(),
                profile / ".deepseek" / "credentials.json",
            )
            self.assertEqual(
                usage_monitor.glm_credentials_path(), profile / ".glm" / "credentials.json"
            )
            self.assertEqual(
                usage_monitor.kimi_credentials_path(),
                profile / ".kimi-code" / "credentials" / "kimi-code.json",
            )

    def test_windows_cli_version_probe_uses_powershell_without_new_session(self):
        completed = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="codex-cli 0.1.2\n", stderr=""
        )
        with mock.patch.object(usage_monitor, "ENVIRONMENT", "windows"), \
                mock.patch.object(usage_monitor, "running_in_wsl", return_value=True), \
                mock.patch.object(
                    usage_monitor.subprocess, "run", return_value=completed
                ) as run:
            self.assertEqual(usage_monitor.detect_cli_version("codex"), "0.1.2")
        command = run.call_args.args[0]
        self.assertEqual(command[0], "powershell.exe")
        self.assertNotIn("start_new_session", run.call_args.kwargs)

    def test_configure_api_keys_writes_private_files_without_returning_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            settings = {
                "deepseek": {
                    "env": ("TEST_DEEPSEEK_KEY",),
                    "path": lambda: root / "deepseek" / "credentials.json",
                    "fields": ("api_key",),
                },
                "glm": {
                    "env": ("TEST_GLM_KEY",),
                    "path": lambda: root / "glm" / "credentials.json",
                    "fields": ("api_key",),
                },
            }
            with mock.patch.object(usage_monitor, "API_KEY_SETTINGS", settings), \
                    mock.patch.dict(os.environ, {}, clear=True):
                result = usage_monitor.configure_api_keys(
                    {"deepseek": "deep-secret", "glm": "glm-secret"}
                )

            self.assertTrue(result["ok"])
            self.assertEqual(result["saved"], ["deepseek", "glm"])
            self.assertNotIn("deep-secret", json.dumps(result))
            self.assertNotIn("glm-secret", json.dumps(result))
            for provider, expected in (
                ("deepseek", "deep-secret"),
                ("glm", "glm-secret"),
            ):
                path = root / provider / "credentials.json"
                self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["api_key"], expected)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_api_key_status_never_returns_key_material(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "credentials.json"
            path.write_text('{"api_key":"do-not-return-me"}', encoding="utf-8")
            settings = {
                "deepseek": {
                    "env": ("TEST_DEEPSEEK_KEY",),
                    "path": lambda: path,
                    "fields": ("api_key",),
                }
            }
            with mock.patch.object(usage_monitor, "API_KEY_SETTINGS", settings), \
                    mock.patch.dict(os.environ, {}, clear=True):
                status = usage_monitor.api_key_status()

            self.assertEqual(
                status,
                {"deepseek": {"configured": True, "source": "file"}},
            )
            self.assertNotIn("do-not-return-me", json.dumps(status))

    def test_running_in_wsl_uses_wsl_environment(self):
        with mock.patch.object(usage_monitor.os, "name", "posix"), mock.patch.dict(
            os.environ,
            {"WSL_DISTRO_NAME": "Ubuntu-Test"},
            clear=True,
        ):
            self.assertTrue(usage_monitor.running_in_wsl())

    def test_available_wsl_distros_reads_distribution_names(self):
        completed = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="\x00Ubuntu-22.04\x00\n\x00Debian\x00\n", stderr=""
        )
        with mock.patch.object(usage_monitor, "running_in_wsl", return_value=True), \
                mock.patch.dict(
                    os.environ, {"WSL_DISTRO_NAME": "Ubuntu-22.04"}, clear=True
                ), \
                mock.patch.object(
                    usage_monitor.subprocess, "run", return_value=completed
                ) as run:
            distros = usage_monitor.available_wsl_distros()

        self.assertEqual(distros, ["Ubuntu-22.04", "Debian"])
        self.assertEqual(run.call_args.args[0], ["wsl.exe", "--list", "--quiet"])

    def test_wsl_settings_require_and_save_distribution(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings_file = Path(tmp) / "settings.json"
            with mock.patch.dict(
                os.environ,
                {"AI_USAGE_SETTINGS_PATH": str(settings_file)},
                clear=True,
            ), mock.patch.object(
                usage_monitor, "available_environments", return_value=["wsl"]
            ), mock.patch.object(
                usage_monitor,
                "available_wsl_distros",
                return_value=["Ubuntu-20.04", "Ubuntu-22.04"],
            ), mock.patch.object(
                usage_monitor, "wsl_distro_name", return_value="Ubuntu-20.04"
            ):
                with self.assertRaises(usage_monitor.MonitorError):
                    usage_monitor.update_settings({"environment": "wsl", "wsl_distro": "Arch"})
                result = usage_monitor.update_settings(
                    {"environment": "wsl", "wsl_distro": "Ubuntu-22.04"}
                )
                self.assertEqual(result["settings"]["wsl_distro"], "Ubuntu-22.04")
                payload = usage_monitor.get_settings_payload()

        self.assertEqual(payload["wsl_distro"], "Ubuntu-22.04")
        self.assertEqual(payload["wsl_distros"], ["Ubuntu-20.04", "Ubuntu-22.04"])

    def test_stop_previous_watch_instances_matches_exact_script(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "usage_monitor.py"
            script.touch()
            for pid, argv in (
                (123, ["python3", str(script), "--watch"]),
                (124, ["python3", str(script), "--json", "--dashboard"]),
                (125, ["python3", str(root / "other.py"), "--watch"]),
            ):
                process_dir = root / str(pid)
                process_dir.mkdir()
                (process_dir / "cmdline").write_bytes(
                    b"\0".join(os.fsencode(arg) for arg in argv) + b"\0"
                )
                (process_dir / "cwd").symlink_to(root)
            with mock.patch.object(usage_monitor.os, "getpid", return_value=999), \
                    mock.patch.object(usage_monitor.os, "kill") as kill:
                stopped = usage_monitor.stop_previous_watch_instances(
                    root,
                    script,
                    wait_for_exit=False,
                )

        self.assertEqual(stopped, [123])
        self.assertEqual(
            kill.call_args_list,
            [mock.call(123, usage_monitor.signal.SIGTERM),
             mock.call(123, usage_monitor.signal.SIGCONT)],
        )

    def test_launch_usage_window_uses_native_windows_launcher_in_wsl(self):
        process = mock.Mock()
        with mock.patch.object(usage_monitor, "running_in_wsl", return_value=True), \
                mock.patch.object(
                    usage_monitor,
                    "prepare_windows_launcher",
                    return_value=(
                        r"C:\Users\test\AppData\Local\AIUsageMonitor\launch-windows.ps1",
                        r"\\wsl.localhost\Ubuntu-Test\repo\electron-app",
                    ),
                ), \
                mock.patch.object(usage_monitor.subprocess, "Popen", return_value=process) as popen, \
                mock.patch.object(usage_monitor.Path, "is_dir", return_value=True), \
                mock.patch.dict(os.environ, {"WSL_DISTRO_NAME": "Ubuntu-Test"}, clear=True):
            usage_monitor.launch_usage_window()

        command = popen.call_args.args[0]
        kwargs = popen.call_args.kwargs
        self.assertEqual(command[0], "powershell.exe")
        self.assertIn("launch-windows.ps1", command[command.index("-File") + 1])
        self.assertIn("electron-app", command[command.index("-SourceDir") + 1])
        self.assertEqual(command[command.index("-Distro") + 1], "Ubuntu-Test")
        self.assertEqual(kwargs["stdin"], usage_monitor.subprocess.DEVNULL)
        self.assertNotIn("start_new_session", kwargs)
        self.assertIsNone(usage_monitor.launched_window_proc)

    def test_kimi(self):
        result = usage_monitor.normalize_kimi(
            {
                "user": {"membership": {"level": "Ultra"}},
                "usage": {"limit": 1000, "remaining": 250},
                "limits": [
                    {
                        "window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
                        "detail": {"limit": 100, "used": 20, "remaining": 80},
                    }
                ],
            }
        )
        self.assertEqual(result["plan"], "Ultra")
        self.assertEqual(result["windows"][0]["label"], "5h Window")
        self.assertEqual(result["windows"][0]["used_percent"], 20)
        self.assertEqual(result["windows"][1]["used_percent"], 75)

    def test_kimi_5h_without_remaining(self):
        # Kimi /coding/v1/usages 的 limits[].detail 只有 limit/used，没有 remaining
        result = usage_monitor.normalize_kimi(
            {
                "user": {"membership": {"level": "LEVEL_INTERMEDIATE"}},
                "usage": {"limit": "100", "used": "99", "remaining": "1"},
                "limits": [
                    {
                        "window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
                        "detail": {
                            "limit": "100",
                            "used": "100",
                            "resetTime": "2026-08-04T09:14:42.960866Z",
                        },
                    }
                ],
            }
        )
        self.assertEqual(result["windows"][0]["label"], "5h Window")
        self.assertEqual(result["windows"][0]["used_percent"], 100)
        self.assertEqual(result["windows"][1]["used_percent"], 99)

    def test_codex(self):
        result = usage_monitor.normalize_codex(
            {
                "plan_type": "plus",
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 12,
                        "limit_window_seconds": 18000,
                        "reset_after_seconds": 120,
                    },
                    "secondary_window": {
                        "used_percent": 34,
                        "limit_window_seconds": 604800,
                        "reset_after_seconds": 300,
                    },
                },
                "rate_limit_reset_credits": {
                    "available_count": 1,
                    "applicable_available_count": 0,
                },
            }
        )
        self.assertEqual(result["plan"], "plus")
        self.assertEqual(result["windows"][0]["label"], "5h Window")
        self.assertEqual(result["windows"][1]["label"], "7d Window")
        self.assertEqual(result["windows"][1]["used_percent"], 34)
        self.assertEqual(
            result["rate_limit_reset_credits"],
            {"available_count": 1, "applicable_available_count": 0},
        )

    def test_codex_reset_credits_accept_camel_case_and_numeric_strings(self):
        result = usage_monitor.normalize_codex(
            {
                "planType": "plus",
                "rateLimitResetCredits": {
                    "availableCount": "2",
                    "applicableAvailableCount": "1",
                },
            }
        )
        self.assertEqual(
            result["rate_limit_reset_credits"],
            {"available_count": 2, "applicable_available_count": 1},
        )

    def test_openai_membership_calculates_calendar_month_end(self):
        china = timezone(timedelta(hours=8))
        membership = usage_monitor.normalize_openai_membership(
            {
                "membership_purchased_at": "2026-07-23T22:45:56+08:00",
                "membership_duration_months": 1,
            },
            now=datetime(2026, 8, 23, 10, 45, 56, tzinfo=china),
        )

        self.assertEqual(membership["purchased_at"], "2026-07-23T22:45:56+08:00")
        self.assertEqual(membership["ends_at"], "2026-08-23T22:45:56+08:00")
        self.assertEqual(membership["end_after_seconds"], 12 * 3600)

    def test_openai_membership_clamps_shorter_month(self):
        membership = usage_monitor.normalize_openai_membership(
            {
                "membership_purchased_at": "2026-01-31T12:00:00+00:00",
                "membership_duration_months": 1,
            },
            now=datetime(2026, 1, 31, 12, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(membership["ends_at"], "2026-02-28T20:00:00+08:00")

    def test_codebuddy(self):
        result = usage_monitor.normalize_codebuddy(
            {
                "account": {"nickname": "winchell", "type": "personal"},
                "notify": {"dosageNotifyEn": "用量已超 80%", "skipUrl": "https://example.com"},
                "resource": {
                    "Accounts": [
                        {
                            "PackageName": "CodeBuddy个人体验版",
                            "SubProductCode": "sp_tcaca_codebuddy_ide",
                            "CapacityType": 4,
                            "CapacityUsedPrecise": "100",
                            "CapacitySizePrecise": "500",
                            "CycleCapacityUsedPrecise": "500",
                            "CycleCapacitySizePrecise": "500",
                            "CycleCapacityRemainPrecise": "0",
                            "CycleEndTime": "2026-07-31 23:59:59",
                        },
                        {
                            "PackageName": "CodeBuddy个人版国内运营裂变包",
                            "SubProductCode": "sp_tcaca_codebuddyide_bonus_pack",
                            "CapacityType": 1,
                            "CapacityUsedPrecise": "0",
                            "CapacitySizePrecise": "0",
                            "CycleCapacityUsedPrecise": "500",
                            "CycleCapacitySizePrecise": "1500",
                            "CycleCapacityRemainPrecise": "1000",
                            "CycleEndTime": "2099-08-13 14:52:06",
                        },
                    ]
                },
            }
        )
        self.assertEqual(result["provider"], "CodeBuddy")
        self.assertEqual(result["plan"], "personal")
        self.assertNotIn("Account: winchell", result["extra_lines"])
        self.assertNotIn("Main plan: CodeBuddy个人体验版", result["extra_lines"])
        self.assertIn("Usage notice: 用量已超 80%", result["extra_lines"])
        self.assertEqual(len(result["windows"]), 2)
        subscription, gifted = result["windows"]
        self.assertNotIn(
            "Daily Quota",
            [window["label"] for window in result["windows"]],
        )
        self.assertEqual(subscription["label"], "Subscription")
        self.assertAlmostEqual(subscription["used_percent"], 100.0)
        self.assertFalse(subscription["expire"])
        # 订阅按月续期：7/31 的周期往前推一个自然月为 6/30，共 31 天
        self.assertEqual(subscription["window_seconds"], 31 * 86400)
        self.assertEqual(gifted["label"], "Gifted")
        self.assertAlmostEqual(gifted["used_percent"], 100.0 * 500 / 1500)
        self.assertTrue(gifted["expire"])
        # 赠送包是一次性额度、周期未知，不推算窗口总长
        self.assertIsNone(gifted["window_seconds"])
        self.assertTrue(all("detail" not in w for w in result["windows"]))
        self.assertIn(
            "Total: 1000.0/2000.0 credits (sub 500.0/500.0, gift 500.0/1500.0)",
            result["extra_lines"],
        )

    def test_codebuddy_excludes_used_up_gift_packs(self):
        # 已用完的赠送包（剩余 ≤ 0）不计入能量统计，只统计仍有余量的赠送包
        result = usage_monitor.normalize_codebuddy(
            {
                "account": {"type": "personal"},
                "notify": {},
                "resource": {
                    "Accounts": [
                        {
                            "PackageName": "CodeBuddy个人体验版",
                            "SubProductCode": "sp_tcaca_codebuddy_ide",
                            "CycleCapacityUsedPrecise": "500",
                            "CycleCapacitySizePrecise": "500",
                            "CycleCapacityRemainPrecise": "0",
                            "CycleEndTime": "2026-07-31 23:59:59",
                        },
                        {
                            "PackageName": "已用完的赠送包",
                            "SubProductCode": "sp_tcaca_codebuddyide_bonus_pack",
                            "CycleCapacityUsedPrecise": "1500",
                            "CycleCapacitySizePrecise": "1500",
                            "CycleCapacityRemainPrecise": "0",
                            "CycleEndTime": "2026-06-01 00:00:00",
                        },
                        {
                            "PackageName": "还有余量的赠送包",
                            "SubProductCode": "sp_tcaca_codebuddyide_bonus_pack",
                            "CycleCapacityUsedPrecise": "200",
                            "CycleCapacitySizePrecise": "800",
                            "CycleCapacityRemainPrecise": "600",
                            "CycleEndTime": "2099-08-13 14:52:06",
                        },
                    ]
                },
            }
        )
        self.assertEqual(len(result["windows"]), 2)
        subscription, gifted = result["windows"]
        # 订阅按月续期：仍按原周期汇总，不受赠送包过滤影响
        self.assertEqual(subscription["label"], "Subscription")
        self.assertAlmostEqual(subscription["used_percent"], 100.0)
        # 已用完的赠送包被排除，仅剩 200/800 的赠送包计入
        self.assertEqual(gifted["label"], "Gifted")
        self.assertAlmostEqual(gifted["used_percent"], 100.0 * 200 / 800)
        self.assertIn(
            "Total: 700.0/1300.0 credits (sub 500.0/500.0, gift 200.0/800.0)",
            result["extra_lines"],
        )

    def test_codebuddy_omits_gifted_window_when_all_gifts_used_up(self):
        # 所有赠送包都用完了：不再展示 Gifted 窗口
        result = usage_monitor.normalize_codebuddy(
            {
                "account": {"type": "personal"},
                "notify": {},
                "resource": {
                    "Accounts": [
                        {
                            "PackageName": "CodeBuddy个人体验版",
                            "SubProductCode": "sp_tcaca_codebuddy_ide",
                            "CycleCapacityUsedPrecise": "500",
                            "CycleCapacitySizePrecise": "500",
                            "CycleCapacityRemainPrecise": "0",
                            "CycleEndTime": "2026-07-31 23:59:59",
                        },
                        {
                            "PackageName": "已用完的赠送包",
                            "SubProductCode": "sp_tcaca_codebuddyide_bonus_pack",
                            "CycleCapacityUsedPrecise": "1500",
                            "CycleCapacitySizePrecise": "1500",
                            "CycleCapacityRemainPrecise": "0",
                            "CycleEndTime": "2026-06-01 00:00:00",
                        },
                    ]
                },
            }
        )
        self.assertEqual(len(result["windows"]), 1)
        self.assertEqual(result["windows"][0]["label"], "Subscription")
        self.assertIn(
            "Total: 500.0/500.0 credits (sub 500.0/500.0)",
            result["extra_lines"],
        )

    def test_codebuddy_no_resource(self):
        result = usage_monitor.normalize_codebuddy(
            {
                "account": {"type": "personal"},
                "notify": {},
                "resource": None,
                "resource_error": "HTTP 500",
            }
        )
        self.assertEqual(result["windows"], [])
        self.assertTrue(any("Quota API unavailable" in line for line in result["extra_lines"]))

    def test_deepseek(self):
        result = usage_monitor.normalize_deepseek(
            {
                "is_available": True,
                "balance_infos": [
                    {
                        "currency": "CNY",
                        "total_balance": "110.00",
                        "granted_balance": "10.00",
                        "topped_up_balance": "100.00",
                    }
                ],
            }
        )
        self.assertEqual(result["provider"], "DeepSeek")
        self.assertEqual(result["plan"], "API")
        self.assertEqual(len(result["windows"]), 1)
        window = result["windows"][0]
        self.assertEqual(window["label"], "Monthly Usage")
        # 余额 110 已超过 50 上限 → 使用量 = 50 - 110 = 0 → 0%
        self.assertAlmostEqual(window["used_percent"], 0.0)
        self.assertIn("Balance: ¥110.00 / ¥50.00", result["extra_lines"])
        self.assertIn("Usage: ¥0.00 / ¥50.00", result["extra_lines"])
        self.assertIn("Granted: ¥10.00   Topped-up: ¥100.00", result["extra_lines"])
        # 使用量按 0 截断,不会出现 capped 标注
        self.assertNotIn("capped", result["extra_lines"][0])

    def test_deepseek_below_limit(self):
        result = usage_monitor.normalize_deepseek(
            {
                "is_available": True,
                "balance_infos": [
                    {
                        "currency": "CNY",
                        "total_balance": "20.00",
                        "granted_balance": "5.00",
                        "topped_up_balance": "15.00",
                    }
                ],
            }
        )
        window = result["windows"][0]
        # 余额 20 → 使用量 30 / 上限 50 = 60%
        self.assertAlmostEqual(window["used_percent"], 60.0)
        self.assertIn("Balance: ¥20.00 / ¥50.00", result["extra_lines"])
        self.assertIn("Usage: ¥30.00 / ¥50.00", result["extra_lines"])
        self.assertIn("Granted: ¥5.00   Topped-up: ¥15.00", result["extra_lines"])
        self.assertNotIn("capped", result["extra_lines"][0])

    def test_deepseek_unavailable(self):
        result = usage_monitor.normalize_deepseek(
            {
                "is_available": False,
                "balance_infos": [
                    {"currency": "CNY", "total_balance": "0.00", "granted_balance": "0.00", "topped_up_balance": "0.00"}
                ],
            }
        )
        # 余额 0 → 使用量 50 / 50 = 100%
        self.assertAlmostEqual(result["windows"][0]["used_percent"], 100.0)
        self.assertTrue(any("Account unavailable" in line for line in result["extra_lines"]))

    def test_glm_coding_plan_quota_display(self):
        now_ms = int(time.time() * 1000)
        result = usage_monitor.normalize_glm(
            {
                "code": 200,
                "success": True,
                "data": {
                    "level": "pro",
                    "limits": [
                        {
                            "type": "TIME_LIMIT",
                            "percentage": 7,
                            "usage": 1000,
                            "currentValue": 72,
                            "remaining": 928,
                        },
                        {
                            "type": "CREDIT_LIMIT",
                            "unit": 3,
                            "number": 5,
                            "percentage": 44,
                            "usage": 2000,
                            "currentValue": 880,
                            "remaining": 1120,
                            "nextResetTime": now_ms + 3600_000,
                        },
                        {
                            "type": "CREDIT_LIMIT",
                            "unit": 6,
                            "number": 1,
                            "percentage": 53,
                            "usage": 10000,
                            "currentValue": 5300,
                            "remaining": 4700,
                            "nextResetTime": now_ms + 3 * 86400_000,
                        },
                    ],
                },
            }
        )

        self.assertEqual(result["provider"], "GLM")
        self.assertEqual(result["plan"], "Coding Pro")
        labels = [w["label"] for w in result["windows"]]
        self.assertEqual(labels, ["5h Window", "7d Window", "Tools Quota"])
        five_hour, weekly, tools = result["windows"]
        self.assertAlmostEqual(five_hour["used_percent"], 44.0)
        self.assertEqual(five_hour["window_seconds"], 5 * 3600)
        self.assertAlmostEqual(five_hour["reset_after_seconds"], 3600, delta=5)
        self.assertEqual(five_hour["usage"], "880/2000")
        self.assertAlmostEqual(weekly["used_percent"], 53.0)
        self.assertEqual(weekly["window_seconds"], 7 * 86400)
        self.assertAlmostEqual(tools["used_percent"], 7.0)
        self.assertEqual(tools["usage"], "72/1000")
        self.assertIn("5h Window remaining: 1120/2000", result["extra_lines"])
        self.assertIn("7d Window remaining: 4700/10000", result["extra_lines"])
        self.assertIn("Tools remaining: 928/1000", result["extra_lines"])

    def test_glm_token_limits_fallback_sorted_by_reset_time(self):
        # unit/number 缺失时按重置时间排序：近的为 5 小时窗口
        now_ms = int(time.time() * 1000)
        result = usage_monitor.normalize_glm(
            {
                "data": {
                    "limits": [
                        {"type": "TOKENS_LIMIT", "percentage": 80, "nextResetTime": now_ms + 5 * 86400_000},
                        {"type": "TOKENS_LIMIT", "percentage": 20, "nextResetTime": now_ms + 1800_000},
                    ],
                },
            }
        )

        labels = [w["label"] for w in result["windows"]]
        self.assertEqual(labels, ["5h Window", "7d Window"])
        self.assertAlmostEqual(result["windows"][0]["used_percent"], 20.0)
        self.assertAlmostEqual(result["windows"][1]["used_percent"], 80.0)

    def test_glm_percentage_one_is_one_percent(self):
        result = usage_monitor.normalize_glm(
            {
                "data": {
                    "limits": [
                        {
                            "type": "CREDIT_LIMIT",
                            "unit": 6,
                            "number": 1,
                            "percentage": 1,
                            "usage": 10000,
                            "currentValue": 130,
                        }
                    ],
                },
            }
        )

        self.assertAlmostEqual(result["windows"][0]["used_percent"], 1.0)
        self.assertEqual(result["windows"][0]["usage"], "130/10000")

    def test_glm_api_key_supports_zhipu_environment_alias(self):
        with mock.patch.dict(
            os.environ,
            {"ZHIPU_API_KEY": "test-zhipu-key"},
            clear=True,
        ):
            self.assertEqual(usage_monitor.glm_api_key(), "test-zhipu-key")

    def test_fetch_glm_uses_bearer_authentication(self):
        quota_response = {"success": True, "data": {"limits": []}}
        with mock.patch.object(
            usage_monitor,
            "request_json",
            return_value=quota_response,
        ) as request_json:
            result = usage_monitor.fetch_glm("test-glm-key")

        self.assertEqual(result, quota_response)
        call = request_json.call_args
        self.assertEqual(call.args[0], usage_monitor.GLM_QUOTA_URL)
        self.assertEqual(call.kwargs["headers"]["Authorization"], "Bearer test-glm-key")
        self.assertTrue(call.kwargs["use_proxy"])

    def test_fetch_glm_rejects_unexpected_response(self):
        with mock.patch.object(
            usage_monitor,
            "request_json",
            return_value={"code": 401, "msg": "未授权"},
        ):
            with self.assertRaises(usage_monitor.MonitorError):
                usage_monitor.fetch_glm("test-glm-key")

    def test_render_aligns_progress_bars_by_terminal_width(self):
        results = [
            {
                "provider": "Test",
                "plan": "test",
                "windows": [
                    {
                        "label": "5h Window",
                        "used_percent": 20,
                        "reset_after_seconds": 60,
                    },
                    {
                        "label": "Daily Quota",
                        "used_percent": 20,
                        "reset_after_seconds": 60,
                    },
                ],
                "fetched_at": "2026-07-31T11:21:29+08:00",
            }
        ]

        output = usage_monitor.render(results, [], color=False)
        self.assertIn("Updated: 2026-07-31 11:21:29", output)
        self.assertNotIn("2026-07-31T11:21:29+08:00", output)
        usage_lines = [line for line in output.splitlines() if "[" in line]
        bar_columns = [
            usage_monitor.display_width(line[: line.index("[")])
            for line in usage_lines
        ]
        self.assertEqual(bar_columns, [19, 19])

    def test_render_shows_current_time_marker(self):
        results = [
            {
                "provider": "Test",
                "plan": "test",
                "windows": [
                    {
                        "label": "5h Window",
                        "used_percent": 0,
                        "reset_after_seconds": 9000,
                        "window_seconds": 18000,
                    },
                ],
                "fetched_at": "2026-07-31T11:21:29+08:00",
            }
        ]

        output = usage_monitor.render(results, [], color=False)
        bar_line = next(line for line in output.splitlines() if "[" in line)
        # 时间走过一半 → | 位于宽度 28 的第 14 格
        self.assertEqual(bar_line.index("|") - bar_line.index("[") - 1, 14)

    def test_render_shows_openai_usage_limit_reset_credits(self):
        results = [
            {
                "provider": "OpenAI Codex",
                "plan": "plus",
                "windows": [],
                "rate_limit_reset_credits": {
                    "available_count": 1,
                    "applicable_available_count": 0,
                },
                "fetched_at": "2026-08-23T10:29:31+08:00",
            }
        ]

        output = usage_monitor.render(results, [], color=False)
        self.assertIn(
            "Reset chance: 1 remaining · Not usable until limit reached",
            output,
        )

    def test_render_shows_usable_openai_reset_credit(self):
        text = usage_monitor.rate_limit_reset_text(
            {"available_count": 2, "applicable_available_count": 1}
        )
        self.assertEqual(text, "Reset chance: 2 remaining · 1 usable now")

    def test_render_shows_openai_membership_period(self):
        results = [
            {
                "provider": "OpenAI Codex",
                "plan": "plus",
                "windows": [],
                "membership": {
                    "purchased_at": "2026-07-23T22:45:56+08:00",
                    "ends_at": "2026-08-23T22:45:56+08:00",
                    "end_after_seconds": 12 * 3600,
                },
                "fetched_at": "2026-08-23T10:45:56+08:00",
            }
        ]

        output = usage_monitor.render(results, [], color=False)
        self.assertIn("Membership purchased: 2026-07-23 22:45:56", output)
        self.assertIn(
            "Membership ends: 2026-08-23 22:45:56 (ends in 12h 0m)",
            output,
        )

    def test_one_month_before_handles_month_end(self):
        from datetime import datetime

        moment = datetime(2026, 3, 31, 12, 0, 0)
        self.assertEqual(
            usage_monitor.one_month_before(moment),
            datetime(2026, 2, 28, 12, 0, 0),
        )
        moment = datetime(2026, 1, 15, 12, 0, 0)
        self.assertEqual(
            usage_monitor.one_month_before(moment),
            datetime(2025, 12, 15, 12, 0, 0),
        )

    def test_kimi_monthly_estimates_window_seconds(self):
        result = usage_monitor.normalize_kimi_monthly(
            {
                "subscriptionBalance": {
                    "amountUsedRatio": 0.5,
                    "expireTime": "2026-08-15T00:00:00+00:00",
                }
            }
        )
        # 7/15 → 8/15 共 31 天
        self.assertEqual(result["window"]["window_seconds"], 31 * 86400)

    def test_render_omits_marker_without_window_seconds(self):
        results = [
            {
                "provider": "Test",
                "plan": "test",
                "windows": [
                    {
                        "label": "Monthly Total",
                        "used_percent": 50,
                        "reset_after_seconds": 60,
                    },
                ],
                "fetched_at": "2026-07-31T11:21:29+08:00",
            }
        ]

        output = usage_monitor.render(results, [], color=False)
        self.assertNotIn("|", output)

    def test_ctrl_r_requests_immediate_refresh(self):
        stream = mock.Mock()
        stream.read.return_value = "\x12"
        with mock.patch.object(
            usage_monitor.select,
            "select",
            return_value=([stream], [], []),
        ), mock.patch.object(
            usage_monitor,
            "reclaim_terminal_foreground",
            return_value=True,
        ):
            refreshed = usage_monitor.wait_for_next_refresh(
                interval=180,
                keyboard_enabled=True,
                stream=stream,
            )

        self.assertTrue(refreshed)
        stream.read.assert_called_once_with(1)

    def test_ctrl_l_requests_manual_login(self):
        stream = mock.Mock()
        stream.read.return_value = "\x0c"
        with mock.patch.object(
            usage_monitor.select,
            "select",
            return_value=([stream], [], []),
        ), mock.patch.object(
            usage_monitor,
            "reclaim_terminal_foreground",
            return_value=True,
        ):
            action = usage_monitor.wait_for_next_refresh(
                interval=180,
                keyboard_enabled=True,
                stream=stream,
            )

        self.assertEqual(action, "login")
        stream.read.assert_called_once_with(1)

    def test_keyboard_refresh_mode_restores_terminal(self):
        stream = mock.Mock()
        stream.isatty.return_value = True
        stream.fileno.return_value = 7
        original_settings = ["terminal settings"]
        with mock.patch.object(
            usage_monitor.termios,
            "tcgetattr",
            return_value=original_settings,
        ), mock.patch.object(
            usage_monitor.tty, "setcbreak"
        ) as setcbreak, mock.patch.object(
            usage_monitor.termios, "tcsetattr"
        ) as tcsetattr:
            with usage_monitor.keyboard_refresh_mode(stream) as enabled:
                self.assertTrue(enabled)

        setcbreak.assert_called_once_with(7, usage_monitor.termios.TCSANOW)
        tcsetattr.assert_called_once_with(
            7,
            usage_monitor.termios.TCSADRAIN,
            original_settings,
        )

    def test_keyboard_refresh_mode_ignores_terminal_restore_eio(self):
        stream = mock.Mock()
        stream.isatty.return_value = True
        stream.fileno.return_value = 7
        with mock.patch.object(
            usage_monitor.termios,
            "tcgetattr",
            return_value=["terminal settings"],
        ), mock.patch.object(
            usage_monitor.tty,
            "setcbreak",
        ), mock.patch.object(
            usage_monitor.termios,
            "tcsetattr",
            side_effect=OSError(5, "Input/output error"),
        ):
            with usage_monitor.keyboard_refresh_mode(stream) as enabled:
                self.assertTrue(enabled)

    def test_reclaim_terminal_foreground_ignores_sigttou(self):
        stream = mock.Mock()
        stream.isatty.return_value = True
        stream.fileno.return_value = 7
        with mock.patch.object(usage_monitor.os, "getpgrp", return_value=42), \
                mock.patch.object(
                    usage_monitor.os,
                    "tcgetpgrp",
                    side_effect=[99, 42],
                ), \
                mock.patch.object(usage_monitor.os, "tcsetpgrp") as tcsetpgrp, \
                mock.patch.object(
                    usage_monitor.signal,
                    "getsignal",
                    return_value=usage_monitor.signal.SIG_DFL,
                ), \
                mock.patch.object(usage_monitor.signal, "signal") as set_signal:
            self.assertTrue(usage_monitor.reclaim_terminal_foreground(stream))

        tcsetpgrp.assert_called_once_with(7, 42)
        self.assertEqual(
            set_signal.call_args_list,
            [
                mock.call(usage_monitor.signal.SIGTTOU, usage_monitor.signal.SIG_IGN),
                mock.call(usage_monitor.signal.SIGTTOU, usage_monitor.signal.SIG_DFL),
            ],
        )

    def test_noninteractive_refresh_wait_uses_sleep(self):
        with mock.patch.object(usage_monitor.time, "sleep") as sleep:
            refreshed = usage_monitor.wait_for_next_refresh(
                interval=180,
                keyboard_enabled=False,
            )

        self.assertFalse(refreshed)
        sleep.assert_called_once_with(180)

    def test_kimi_monthly_error_is_transient_in_watch_mode(self):
        errors = [
            {"provider": "Kimi Monthly Total", "error": "HTTP 401"},
            {"provider": "DeepSeek", "error": "HTTP 500"},
        ]

        self.assertEqual(
            usage_monitor.persistent_watch_errors(errors),
            [{"provider": "DeepSeek", "error": "HTTP 500"}],
        )

    def test_collect_all_does_not_query_codebuddy(self):
        args = argparse.Namespace(
            provider="all",
            config=None,
            kimi_credentials=None,
            kimi_web_credentials=None,
            codex_credentials=None,
            deepseek_key=None,
            deepseek_credentials=None,
            glm_key=None,
            glm_credentials=None,
        )
        with mock.patch.object(usage_monitor, "fetch_kimi", side_effect=RuntimeError), \
                mock.patch.object(usage_monitor, "fetch_codex", side_effect=RuntimeError), \
                mock.patch.object(usage_monitor, "fetch_deepseek", side_effect=RuntimeError), \
                mock.patch.object(usage_monitor, "fetch_glm", side_effect=RuntimeError), \
                mock.patch.object(usage_monitor, "fetch_codebuddy") as fetch_codebuddy:
            usage_monitor.collect(args)

        fetch_codebuddy.assert_not_called()

    def test_dashboard_collects_providers_in_parallel_but_keeps_order(self):
        args = argparse.Namespace(
            provider="all",
            dashboard=True,
            config=None,
            kimi_credentials=None,
            kimi_web_credentials=None,
            codex_credentials=None,
            deepseek_key=None,
            deepseek_credentials=None,
            glm_key=None,
            glm_credentials=None,
        )
        barrier = threading.Barrier(4)

        def fake_collect(provider, _args, _config):
            barrier.wait(timeout=2)
            return {
                "provider": provider,
                "plan": "test",
                "windows": [],
                "fetched_at": "2026-08-28T00:00:00+08:00",
            }, []

        with mock.patch.object(usage_monitor, "_collect_provider", side_effect=fake_collect):
            results, errors = usage_monitor.collect(args)

        self.assertEqual(errors, [])
        self.assertEqual(
            [result["provider"] for result in results],
            ["kimi", "codex", "deepseek", "glm"],
        )

    def test_version_badge_marks_outdated_cli(self):
        versions = {"Kimi Code": {"current": "0.30.0", "latest": "0.33.0"}}

        badge = usage_monitor.version_badge("Kimi Code", versions, color=False)
        self.assertEqual(badge, " (0.30.0 → 0.33.0)")

    def test_version_badge_quiet_when_up_to_date_or_unknown(self):
        up_to_date = {"Kimi Code": {"current": "0.33.0", "latest": "0.33.0"}}
        unknown = {"Kimi Code": {"current": "0.33.0", "latest": None}}

        self.assertEqual(usage_monitor.version_badge("Kimi Code", up_to_date, color=False), " (0.33.0)")
        self.assertEqual(usage_monitor.version_badge("Kimi Code", unknown, color=False), " (0.33.0)")
        self.assertEqual(usage_monitor.version_badge("Kimi Code", {}, color=False), "")
        self.assertEqual(usage_monitor.version_badge("Kimi Code", None, color=False), "")

    def test_collect_versions_redetects_current_within_cache_window(self):
        # 缓存仍在一小时有效期内，但本机 CLI 刚升级过：current 应实时刷新，
        # 且不触发远程最新版本探测
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "versions.json"
            cache_path.write_text(
                json.dumps(
                    {"Kimi Code": {"current": "0.33.0", "latest": "0.34.0", "checked_at": time.time()}}
                ),
                encoding="utf-8",
            )
            with mock.patch.object(usage_monitor, "VERSION_CACHE_PATH", cache_path), \
                mock.patch.object(usage_monitor, "detect_cli_version", return_value="0.34.0"), \
                mock.patch.object(usage_monitor, "fetch_latest_version") as fetch:
                versions = usage_monitor.collect_versions({"Kimi Code"})

            fetch.assert_not_called()
            self.assertEqual(versions["Kimi Code"], {"current": "0.34.0", "latest": "0.34.0"})
            # 缓存里的 current 也同步刷新，供检测失败时回退
            saved = json.loads(cache_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["Kimi Code"]["current"], "0.34.0")

    def test_detect_cli_version_loads_interactive_wsl_environment(self):
        completed = mock.Mock(stdout="codex-cli 0.150.1\n", stderr="")
        with mock.patch.object(usage_monitor, "running_in_wsl", return_value=True), \
                mock.patch.object(
                    usage_monitor.subprocess,
                    "run",
                    return_value=completed,
                ) as run:
            version = usage_monitor.detect_cli_version("codex")

        self.assertEqual(version, "0.150.1")
        self.assertEqual(run.call_args.args[0], ["bash", "-ic", "codex --version"])
        self.assertNotIn("shell", run.call_args.kwargs)
        self.assertEqual(run.call_args.kwargs["stdin"], usage_monitor.subprocess.DEVNULL)
        self.assertTrue(run.call_args.kwargs["start_new_session"])

    def test_render_appends_version_badge_to_provider_heading(self):
        results = [
            {
                "provider": "Kimi Code",
                "plan": "test",
                "windows": [],
                "fetched_at": "2026-08-06T21:50:52+08:00",
            }
        ]
        versions = {"Kimi Code": {"current": "0.30.0", "latest": "0.33.0"}}

        output = usage_monitor.render(results, [], color=False, versions=versions)
        heading = next(line for line in output.splitlines() if line.startswith("Kimi Code"))
        self.assertTrue(heading.startswith("Kimi Code (0.30.0 → 0.33.0)  ·  "))

        # 未传 versions 时标题保持原样（向后兼容）
        output = usage_monitor.render(results, [], color=False)
        self.assertIn("Kimi Code  ·  ", output)

    def test_duration_text(self):
        # DeepSeek 余额类额度:没有重置时间,显示"用完为止"
        self.assertEqual(usage_monitor.duration_text(None, until_used_up=True), "until used up")
        # 其它模型未知重置时间保持原描述
        self.assertEqual(usage_monitor.duration_text(None), "resets at unknown time")
        self.assertEqual(usage_monitor.duration_text(None, expire=True), "expires at unknown time")
        self.assertEqual(usage_monitor.duration_text(3600), "resets in 1h 0m")


if __name__ == "__main__":
    unittest.main()
