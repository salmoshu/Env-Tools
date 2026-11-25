import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { installTarget, installScope, installConflict } from "../electron/installTarget.js";
import { resetExpiries } from "../src/resetExpiries.js";
import {
  quotaEstimateMeta, quotaEstimateRequest, quotaEstimateResult, quotaEstimateStoreKey, quotaEstimateView,
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

const codex = (plan = "prolite") => ({
  provider: "OpenAI Codex", plan, fetched_at: "2026-11-25T00:00:00Z",
});
const weeklyWindow = (pct = 6, reset = 548137) => ({
  window_seconds: 604800, used_percent: pct, reset_after_seconds: reset,
});
const capacity = (total) => ({ total, low: total * 0.9, high: total * 1.1, confidence: "medium", method: "increments" });

test("只有 7d 的 Codex 也显示额度，零本地用量不阻断已校准窗口", () => {
  const account = codex();
  const current = weeklyWindow(6);
  const query = quotaEstimateRequest(account, current, "work");
  const entry = quotaEstimateResult(query, { tokens: 0, estimate: capacity(3e9), externalActivity: true });
  const view = quotaEstimateView({ [query.storeKey]: entry }, account, current, "work");
  assert.equal(view.capacity.total, 3e9);
  assert.equal(view.estimatedUsed, 180e6);
  assert.equal(view.tokens, 0);
  assert.equal(view.externalActivity, true);
  assert.equal(quotaEstimateRequest(account, weeklyWindow(0, 604800), "work").elapsed, 0);
});

test("已估容量不随同套餐下一次快照闪回百分比，旧用量不会带入", () => {
  const account = codex();
  const query = quotaEstimateRequest(account, weeklyWindow(), "work");
  const entries = { [query.storeKey]: quotaEstimateResult(query, { tokens: 190e6, estimate: capacity(3e9) }) };
  const later = { ...account, fetched_at: "2026-11-25T00:01:00Z" };
  const view = quotaEstimateView(entries, later, weeklyWindow(7, 548077), "work");
  assert.equal(view.pending, true);
  assert.equal(view.tokens, null);
  assert.equal(view.estimatedUsed, 210e6);
});

test("5h、7d、套餐、账号及 Kimi 份额口径互不串用", () => {
  const account = codex("plus");
  const w5 = { window_seconds: 18000, reset_after_seconds: 3200, used_percent: 20 };
  const w7 = weeklyWindow(20, 604800 - 14800);
  const q5 = quotaEstimateRequest(account, w5, "work");
  const q7 = quotaEstimateRequest(account, w7, "work");
  const entries = {
    [q5.storeKey]: quotaEstimateResult(q5, { tokens: 2000, estimate: capacity(10000) }),
    [q7.storeKey]: quotaEstimateResult(q7, { tokens: 2000, estimate: capacity(20000) }),
  };
  assert.equal(q5.elapsed, q7.elapsed);
  assert.notEqual(q5.storeKey, q7.storeKey);
  assert.equal(quotaEstimateView(entries, account, w5, "work").capacity.total, 10000);
  assert.equal(quotaEstimateView(entries, account, w7, "work").capacity.total, 20000);
  assert.equal(quotaEstimateView(entries, codex("prolite"), w7, "work").capacity, undefined);
  assert.equal(quotaEstimateView(entries, account, w7, "other").capacity, undefined);
  const month = { window_seconds: 2592000, reset_after_seconds: 864000, used_percent: 20 };
  const individual = quotaEstimateMeta("Kimi Code", month);
  const shared = quotaEstimateMeta("Kimi Code", { ...month, quota_share_percent: 50 });
  assert.notEqual(quotaEstimateStoreKey(individual), quotaEstimateStoreKey(shared));
});

test("不从单个不完整点造总额，旧 SSH 只用已有历史作低置信估计", () => {
  const query = quotaEstimateRequest(codex(), weeklyWindow(), "work");
  assert.equal(quotaEstimateResult(query, {
    tokens: 100000, estimate: null, history: [99999], coverageComplete: false,
  }).capacity, null);
  const legacy = quotaEstimateResult(query, { tokens: 1000, history: [20000, 22000] });
  assert.equal(legacy.capacity.total, 21000);
  assert.equal(legacy.capacity.confidence, "low");
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
