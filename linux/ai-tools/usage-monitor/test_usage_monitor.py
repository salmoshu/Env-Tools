from __future__ import annotations

import os
import unittest
from unittest import mock

import usage_monitor


class NormalizeTests(unittest.TestCase):
    def test_env_enabled(self):
        with mock.patch.dict(os.environ, {"TEST_FLAG": "yes"}):
            self.assertTrue(usage_monitor.env_enabled("TEST_FLAG"))
        with mock.patch.dict(os.environ, {"TEST_FLAG": "0"}):
            self.assertFalse(usage_monitor.env_enabled("TEST_FLAG", default=True))

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
            }
        )
        self.assertEqual(result["plan"], "plus")
        self.assertEqual(result["windows"][0]["label"], "5h Window")
        self.assertEqual(result["windows"][1]["label"], "7d Window")
        self.assertEqual(result["windows"][1]["used_percent"], 34)

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
        ):
            refreshed = usage_monitor.wait_for_next_refresh(
                interval=180,
                keyboard_enabled=True,
                stream=stream,
            )

        self.assertTrue(refreshed)
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
            {"provider": "CodeBuddy", "error": "HTTP 500"},
        ]

        self.assertEqual(
            usage_monitor.persistent_watch_errors(errors),
            [{"provider": "CodeBuddy", "error": "HTTP 500"}],
        )


if __name__ == "__main__":
    unittest.main()
