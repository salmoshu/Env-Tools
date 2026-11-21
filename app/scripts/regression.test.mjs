import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { installTarget, installScope, installConflict } from "../electron/installTarget.js";
import { resetExpiries } from "../src/resetExpiries.js";
import {
  quotaEstimateLookup, quotaEstimateLookupTotal, quotaEstimateMeta, quotaEstimateStoreKey,
} from "../src/quotaEstimate.js";

const { zcodeCandidatePaths } = createRequire(import.meta.url)("../electron/zcodeLauncher.js");

let progress;
globalThis.window = { api: { onInstallProgress: (callback) => { progress = callback; } } };
const { getInstallState, busyComponents, upgradingTargets, setInstallResult } = await import("../src/installState.js");

const windows = installTarget({ command: "powershell.exe", args: [] }, "win32");
const wsl = (distro) => installTarget({ command: "wsl.exe", args: ["-d", distro, "--exec", "bash"] }, "win32");

test("安装锁按实际平台及发行版隔离，组件安装与看板升级互斥", () => {
  const runs = new Map([["first", { ...wsl("Ubuntu-22.04"), components: ["kimi"] }]]);
  assert.equal(installConflict(runs, windows, ["kimi"]), false);
  assert.equal(installConflict(runs, wsl("Ubuntu-20.04"), ["kimi"]), false);
  assert.equal(installConflict(runs, wsl("Ubuntu-22.04"), ["codex"]), false);
  assert.equal(installConflict(runs, wsl("Ubuntu-22.04"), ["codex", "kimi"]), true);
  assert.notEqual(installScope(windows), installScope(wsl("Ubuntu-22.04")));
  assert.notEqual(installScope(wsl("Ubuntu-20.04")), installScope(wsl("Ubuntu-22.04")));
});

test("Windows 与两个 WSL 任务独立显示、结束，IPC 失败不会移除其它任务", () => {
  const targets = [windows, wsl("Ubuntu-22.04"), wsl("Ubuntu-20.04")];
  const keys = targets.map((target) => `${installScope(target)}:component:kimi`);
  targets.forEach((target, i) => {
    progress({ key: keys[i], start: { ...target, label: keys[i], components: ["kimi"] } });
    progress({ key: keys[i], line: `output ${i}` });
  });
  assert.equal(Object.keys(getInstallState().runs).length, 3);
  assert.deepEqual([...busyComponents(getInstallState(), "windows")], ["kimi"]);
  assert.deepEqual(upgradingTargets(getInstallState(), { environment: "windows" }), ["Kimi Code"]);
  assert.deepEqual(upgradingTargets(getInstallState(), { native_environment: "windows" }), ["Kimi Code"]);
  assert.deepEqual(upgradingTargets(getInstallState(), null), ["Kimi Code"]);
  progress({ key: keys[1], end: { ok: true } });
  assert.equal(busyComponents(getInstallState(), "wsl", "Ubuntu-22.04").size, 0);
  assert.equal(busyComponents(getInstallState(), "wsl", "Ubuntu-20.04").has("kimi"), true);
  assert.equal(busyComponents(getInstallState(), "windows").has("kimi"), true);
  setInstallResult({ ok: false, error: "duplicate request" });
  assert.equal(Object.keys(getInstallState().runs).length, 2);
  keys.forEach((key, i) => assert.equal(getInstallState().log.find((entry) => entry.key === key).line, `output ${i}`));
  keys.forEach((key) => progress({ key, end: { ok: true } }));
  assert.equal(Object.keys(getInstallState().runs).length, 0);
  assert.equal(getInstallState().running, null);
});

test("Codex 到期列表排序且保留相同日期的每次机会", () => {
  const entries = resetExpiries({ rate_limit_reset_credits: {
    available_count: 3, expires_at_list: [3000, 2000, 3000], next_expires_at: 2000,
  } });
  assert.deepEqual(entries.map((entry) => entry.at), [2000, 3000, 3000]);
  assert.deepEqual(resetExpiries({ rate_limit_reset_credits: {
    available_count: 3, next_expires_at: 2000,
  } }).map((entry) => entry.at), [2000, null, null]);
});

test("GLM 列出 5h 与 7d 卡片的绝对日期，缓存回放不推迟日期", () => {
  const fetched = "2026-11-01T00:00:00Z";
  const entries = resetExpiries({ fetched_at: fetched, reset_cards: {
    five_hour: [{ expire_at: "2026-11-03T00:00:00Z", expire_after_seconds: 1 }, { expire_after_seconds: 86400 }],
    week: [{ expire_at: "2026-11-02T00:00:00Z" }],
  } });
  assert.deepEqual(entries.map((entry) => [entry.label, entry.at]), [
    ["5h", Date.parse("2026-11-02T00:00:00Z") / 1000],
    ["7d", Date.parse("2026-11-02T00:00:00Z") / 1000],
    ["5h", Date.parse("2026-11-03T00:00:00Z") / 1000],
  ]);
});

test("明确无到期限制与缺失到期时间分别展示", () => {
  assert.deepEqual(resetExpiries({ rate_limit_reset_credits: {
    available_count: 2, expires_at_list: [null],
  } }), [{ label: "", at: null, noExpiry: true }, { label: "", at: null }]);
});

test("GLM 日期缺失时保留真实次数并标记未知日期", () => {
  assert.deepEqual(resetExpiries({ reset_cards: { five_hour: [{ expire_at: null, expire_after_seconds: null }] } }),
    [{ label: "5h", at: null }]);
});

test("Codex 5h/7d 估算按窗口隔离，联合重置时不会共用 7d 历史", () => {
  const provider = "OpenAI Codex";
  const w5 = { used_percent: 10, window_seconds: 18000, reset_after_seconds: 16925 };
  const w7 = { used_percent: 20, window_seconds: 604800, reset_after_seconds: 549561 };
  assert.equal(quotaEstimateStoreKey(quotaEstimateMeta(provider, w5)), "codex|18000|1800");
  assert.equal(quotaEstimateStoreKey(quotaEstimateMeta(provider, w7)), "codex|604800|55800");
  const estimates = {
    "codex|18000|1800": { tokens: 6434278, history: [64e6] },
    "codex|604800|55800": { tokens: 62534629, history: [300e6] },
  };
  assert.equal(quotaEstimateLookup(estimates, provider, w5), 6434278);
  assert.equal(quotaEstimateLookup(estimates, provider, w7), 62534629);
  assert.ok(quotaEstimateLookupTotal(estimates, provider, w7, 62534629)
    > quotaEstimateLookupTotal(estimates, provider, w5, 6434278));

  // 两个窗口 elapsed 相同（同代重置）：已用 token 相同是真实用量，
  // 但总额必须各取自己的历史，不能都变成 7d 的中位。
  const aligned5 = { used_percent: 11, window_seconds: 18000, reset_after_seconds: 0 };
  const aligned7 = { used_percent: 11, window_seconds: 604800, reset_after_seconds: 586800 };
  const sameTokens = 7366836;
  const aligned = {
    "codex|18000|18000": { tokens: sameTokens, history: [64e6] },
    "codex|604800|18000": { tokens: sameTokens, history: [300e6] },
  };
  assert.notEqual(
    quotaEstimateLookupTotal(aligned, provider, aligned5, sameTokens),
    quotaEstimateLookupTotal(aligned, provider, aligned7, sameTokens),
  );
});

test("ZCode 启动路径支持注册表和环境目录并去重", () => {
  const paths = zcodeCandidatePaths({
    ZCODE_EXECUTABLE: "D:\\Tools\\ZCode.exe",
    LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
  }, ["D:\\Apps\\ZCode"]);
  assert.equal(paths[0], "D:\\Tools\\ZCode.exe");
  assert.ok(paths.includes("D:\\Apps\\ZCode\\ZCode.exe"));
  assert.ok(paths.includes("C:\\Users\\example\\AppData\\Local\\Programs\\ZCode\\ZCode.exe"));
  assert.ok(paths.includes("C:\\Program Files\\ZCode\\ZCode.exe"));
  assert.equal(zcodeCandidatePaths({}, ["C:\\ZCode", "c:\\zcode\\ZCODE.EXE"]).length, 1);
});
