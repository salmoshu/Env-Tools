const content = document.getElementById("content");
const btnPin = document.getElementById("btn-pin");
const btnRefresh = document.getElementById("btn-refresh");
const btnSettings = document.getElementById("btn-settings");
const titleVersion = document.getElementById("title-version");
const envBadge = document.getElementById("env-badge");
let lastPayload = null;
// provider 筛选为多选集合，位于设置页 Display 面板
let selectedProviders = new Set();
let knownProviders = [];
const ERROR_DISMISS_MS = 8000;
const settingsView = document.getElementById("settings-view");
const settingsNote = document.getElementById("settings-note");
const settingsSave = document.getElementById("settings-save");
const displayList = document.getElementById("display-list");
const sideEnvironment = document.getElementById("side-environment");
const environmentList = document.getElementById("environment-list");
const environmentNote = document.getElementById("environment-note");
const apikeysEnvHint = document.getElementById("apikeys-env-hint");
const keyInputs = {
  deepseek: document.getElementById("deepseek-key"),
  glm: document.getElementById("glm-key"),
};
const keyStates = {
  deepseek: document.getElementById("deepseek-key-state"),
  glm: document.getElementById("glm-key-state"),
};
let settingsOpen = false;
let currentSettings = null;

document.getElementById("btn-min").addEventListener("click", () => api.minimize());
document.getElementById("btn-close").addEventListener("click", () => api.close());
document.getElementById("btn-refresh").addEventListener("click", () => {
  // 已有内容时保留旧数据,不闪烁成"刷新中";仅首次无内容时显示占位
  if (!content.querySelector(".provider")) {
    content.innerHTML = '<div class="status">Refreshing…</div>';
  }
  btnRefresh.classList.add("spin");
  api.refresh();
});
btnPin.addEventListener("click", async () => {
  updatePinState(await api.togglePin());
});
api.getPinState().then(updatePinState);

function showKeyStatus(provider, info = {}) {
  const el = keyStates[provider];
  el.classList.remove("configured", "invalid");
  if (info.configured) {
    el.textContent = `Configured (${info.source || "local"})`;
    el.classList.add("configured");
    keyInputs[provider].placeholder = "Leave blank to keep current key";
  } else if (info.source === "invalid") {
    el.textContent = "Invalid credential file";
    el.classList.add("invalid");
    keyInputs[provider].placeholder = "Enter a replacement key";
  } else {
    el.textContent = "Not configured";
    keyInputs[provider].placeholder = "Enter API key";
  }
}

async function openSettings() {
  settingsOpen = true;
  content.classList.add("hidden");
  settingsView.classList.remove("hidden");
  btnSettings.classList.add("active");
  api.settingsOpen(true);
  for (const input of Object.values(keyInputs)) input.value = "";
  settingsNote.className = "settings-note";
  settingsNote.textContent = "Keys are sent to the backend through stdin only.";
  settingsSave.disabled = false;
  fitWindow();
  loadSettingsInfo();
  loadApiKeyStatus();
}

function closeSettings() {
  settingsOpen = false;
  settingsView.classList.add("hidden");
  content.classList.remove("hidden");
  btnSettings.classList.remove("active");
  for (const input of Object.values(keyInputs)) input.value = "";
  api.settingsOpen(false);
  api.resetFit();
  if (lastPayload) {
    render(lastPayload);
    updateCompact();
  }
  fitWindow();
}

// 设置页元信息：版本、数据源环境、后端路径
async function loadSettingsInfo() {
  try {
    const result = await api.getSettings();
    if (!result || !result.ok) throw new Error((result && result.error) || "unknown error");
    currentSettings = result;
    document.getElementById("about-version").textContent = `v${result.version || "unknown"}`;
    document.getElementById("about-environment").textContent = result.environment || "—";
    document.getElementById("about-script").textContent = result.script || "—";
    const available = result.available_environments || [];
    sideEnvironment.classList.toggle("hidden", available.length < 2);
    buildEnvironmentList(available, result.environment);
    apikeysEnvHint.textContent = result.environment === "windows"
      ? "Keys are written to the Windows-side credential files (via WSL interop)."
      : "Keys are stored locally with private file permissions.";
  } catch (err) {
    environmentNote.className = "settings-note error";
    environmentNote.textContent = `Cannot read settings: ${err.message || err}`;
  }
}

function buildEnvironmentList(available, current) {
  environmentList.innerHTML = available.map((env) =>
    `<div class="env-option${env === current ? " selected" : ""}" data-env="${esc(env)}">` +
    `<span class="radio"></span>${esc(env === "wsl" ? "WSL" : env)}</div>`
  ).join("");
  environmentList.querySelectorAll(".env-option").forEach((item) => {
    item.addEventListener("click", async () => {
      const env = item.dataset.env;
      if (!currentSettings || env === currentSettings.environment) return;
      environmentNote.className = "settings-note";
      environmentNote.textContent = "Saving…";
      try {
        const result = await api.setSettings({ environment: env });
        if (!result || !result.ok) throw new Error((result && result.error) || "unknown error");
        currentSettings.environment = env;
        buildEnvironmentList(available, env);
        document.getElementById("about-environment").textContent = env;
        environmentNote.className = "settings-note ok";
        environmentNote.textContent = "Saved. Usage data is refreshing…";
      } catch (err) {
        environmentNote.className = "settings-note error";
        environmentNote.textContent = `Save failed: ${err.message || err}`;
      }
    });
  });
}

async function loadApiKeyStatus() {
  for (const provider of Object.keys(keyInputs)) {
    keyStates[provider].textContent = "Checking…";
  }
  try {
    const result = await api.getApiKeyStatus();
    if (!result || !result.ok) throw new Error((result && result.error) || "unknown error");
    for (const provider of Object.keys(keyInputs)) {
      showKeyStatus(provider, (result.status || {})[provider]);
    }
  } catch (err) {
    settingsNote.className = "settings-note error";
    settingsNote.textContent = `Cannot read key status: ${err.message || err}`;
  }
}

// 边栏切换面板
settingsView.querySelectorAll(".side-item").forEach((item) => {
  item.addEventListener("click", () => {
    settingsView.querySelectorAll(".side-item").forEach((i) => i.classList.remove("active"));
    item.classList.add("active");
    settingsView.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
    document.getElementById(`panel-${item.dataset.panel}`).classList.remove("hidden");
    fitWindow();
  });
});

btnSettings.addEventListener("click", () => (settingsOpen ? closeSettings() : openSettings()));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && settingsOpen) closeSettings();
});
settingsSave.addEventListener("click", async () => {
  const values = {};
  for (const [provider, input] of Object.entries(keyInputs)) {
    if (input.value.trim()) values[provider] = input.value.trim();
  }
  if (Object.keys(values).length === 0) {
    settingsNote.className = "settings-note error";
    settingsNote.textContent = "Enter at least one new API key.";
    return;
  }
  settingsSave.disabled = true;
  settingsNote.className = "settings-note";
  settingsNote.textContent = "Saving…";
  try {
    const result = await api.saveApiKeys(values);
    if (!result || !result.ok) throw new Error((result && result.error) || "unknown error");
    for (const provider of Object.keys(keyInputs)) {
      showKeyStatus(provider, (result.status || {})[provider]);
      keyInputs[provider].value = "";
    }
    settingsNote.className = "settings-note ok";
    settingsNote.textContent = "Saved. Usage data is refreshing…";
  } catch (err) {
    settingsNote.className = "settings-note error";
    settingsNote.textContent = `Save failed: ${err.message || err}`;
  } finally {
    settingsSave.disabled = false;
  }
});

// provider 筛选位于设置页 Display 面板：复选列表，即点即生效
function isAllSelected() {
  return knownProviders.length > 0 && selectedProviders.size === knownProviders.length;
}

// 勾选态统一从这里刷新
function refreshFilterUi() {
  displayList.querySelectorAll(".display-list-item").forEach((item) => {
    const cb = item.querySelector(".cb");
    if (item.dataset.val === "__all__") {
      cb.classList.toggle("on", isAllSelected());
      cb.classList.toggle("partial", !isAllSelected() && selectedProviders.size > 0);
    } else {
      cb.classList.toggle("on", selectedProviders.has(item.dataset.val));
      cb.classList.remove("partial");
    }
  });
}

// 筛选变化后重绘内容并贴合窗口
function applyFilter() {
  refreshFilterUi();
  if (lastPayload && !settingsOpen) {
    api.resetFit();
    render(lastPayload);
    updateCompact();
    fitWindow();
  }
}

function buildDisplayList(accounts, errors = []) {
  // 拉取失败的模型也保留在列表里(错误卡片单独展示),
  // 避免临时失败时选项消失、筛选被静默重置
  const names = accounts.map((a) => a.provider);
  const seen = new Set(names);
  for (const e of errors || []) {
    const p = e && e.provider;
    if (p && p !== "Kimi Monthly Total" && !seen.has(p)) {
      seen.add(p);
      names.push(p);
    }
  }
  // 列表自适应:首次或之前是全选 → 新列表继续全选;否则剔除已消失的 provider
  const prevAll = knownProviders.length > 0 && selectedProviders.size === knownProviders.length;
  if (knownProviders.length === 0 || prevAll) {
    selectedProviders = new Set(names);
  } else {
    selectedProviders = new Set([...selectedProviders].filter((n) => names.includes(n)));
  }
  knownProviders = names;

  displayList.innerHTML =
    '<div class="display-list-item" data-val="__all__"><span class="cb"></span>All</div>' +
    names.map((n) => `<div class="display-list-item" data-val="${esc(n)}"><span class="cb"></span>${esc(n)}</div>`).join("");

  displayList.querySelectorAll(".display-list-item").forEach((item) => {
    item.addEventListener("click", () => {
      const val = item.dataset.val;
      if (val === "__all__") {
        selectedProviders = isAllSelected() ? new Set() : new Set(knownProviders);
      } else if (selectedProviders.has(val)) {
        selectedProviders.delete(val);
      } else {
        selectedProviders.add(val);
      }
      applyFilter();
    });
  });
  refreshFilterUi();
}

function updatePinState(pinned) {
  btnPin.classList.toggle("active", Boolean(pinned));
}

function fmtReset(seconds) {
  if (seconds == null) return "";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `resets in ${d}d ${h}h`;
  if (h > 0) return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
}

function fmtLimitResetCredits(resetCredits) {
  if (!resetCredits || typeof resetCredits !== "object") return "";
  const available = resetCredits.available_count;
  const applicable = resetCredits.applicable_available_count;
  if (available == null && applicable == null) return "";
  const parts = [];
  if (available != null) parts.push(`${available} remaining`);
  if (applicable != null) {
    parts.push(Number(applicable) > 0
      ? `${applicable} usable now`
      : "Not usable until limit reached");
  }
  return `Reset chance: ${parts.join(" · ")}`;
}

function fmtDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function fmtCompactDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function membershipEndStatus(endsAt) {
  const endMs = new Date(endsAt).getTime();
  if (!Number.isFinite(endMs)) return { text: "", ended: false };
  const seconds = Math.floor((endMs - Date.now()) / 1000);
  return seconds >= 0
    ? { text: `ends in ${fmtCompactDuration(seconds)}`, ended: false }
    : { text: `ended ${fmtCompactDuration(-seconds)} ago`, ended: true };
}

function levelClass(pct) {
  if (pct < 50) return "low";
  if (pct < 80) return "mid";
  return "high";
}

// 当前时间在配额窗口内走过的比例(0~1),对齐终端版 window_time_fraction
function timeFraction(w) {
  if (!w.window_seconds || w.window_seconds <= 0 || w.reset_after_seconds == null) return null;
  return Math.min(1, Math.max(0, (w.window_seconds - w.reset_after_seconds) / w.window_seconds));
}

function isNewerVersion(latest, current) {
  const a = String(latest).split(".").map((n) => parseInt(n, 10) || 0);
  const b = String(current).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function versionBadge(versions, provider) {
  const info = (versions || {})[provider] || {};
  if (!info.current) return "";
  if (info.latest && isNewerVersion(info.latest, info.current)) {
    // 有更新时徽章可点击,触发升级确认
    return `<span class="ver upgrade" data-provider="${esc(provider)}" title="Click to upgrade">` +
      `v${esc(info.current)} <span class="new">→ ${esc(info.latest)}</span></span>`;
  }
  return `<span class="ver">v${esc(info.current)}</span>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function render(payload) {
  if (payload.error) {
    content.innerHTML = `<div class="error-card">${esc(payload.error)}</div>`;
    scheduleErrorDismiss();
    return;
  }
  const { accounts: allAccounts = [], errors = [], versions = {} } = payload.data || {};
  const accounts = allAccounts.filter((a) => selectedProviders.has(a.provider));
  // 报错也按当前筛选显示:只显示勾选中的模型的报错
  const visibleErrors = errors.filter((e) => selectedProviders.has(e.provider));
  let html = "";

  if (knownProviders.length > 0 && selectedProviders.size === 0) {
    content.innerHTML = '<div class="status">No providers selected</div>';
    return;
  }

  for (const account of accounts) {
    const updated = account.fetched_at
      ? new Date(account.fetched_at).toLocaleTimeString("zh-CN", { hour12: false })
      : "";
    html += `<div class="provider">
      <div class="provider-head">
        <span class="provider-name">${esc(account.provider)}</span>
        ${versionBadge(versions, account.provider)}
        <span class="plan">${esc(account.plan || "unknown")}</span>
        <span class="updated">${esc(updated)}</span>
      </div>`;
    const membership = account.membership;
    if (membership && membership.error) {
      html += `<div class="membership error">${esc(membership.error)}</div>`;
    } else if (membership && membership.purchased_at && membership.ends_at) {
      // 单行精简显示:过期时间 + 剩余时间
      const endStatus = membershipEndStatus(membership.ends_at);
      const endClass = endStatus.ended ? " ended" : "";
      html += `<div class="membership">
        <div class="membership-end${endClass}"><span>Ends</span><strong>${esc(fmtDateTime(membership.ends_at))}</strong><em>${esc(endStatus.text)}</em></div>
      </div>`;
    }
    for (const w of account.windows || []) {
      const pct = w.used_percent == null ? 0 : Math.max(0, Math.min(100, w.used_percent));
      const frac = timeFraction(w);
      const marker = frac == null
        ? ""
        : `<div class="marker" style="left:${(frac * 100).toFixed(1)}%"></div>`;
      // 百分比右侧附加信息:剩余时间/余额等,无内容时不要残留 "·"
      const pctTail = [];
      const resetText = fmtReset(w.reset_after_seconds);
      if (resetText) pctTail.push(`<span class="reset">${esc(resetText)}</span>`);
      if (w.usage) pctTail.push(`<span class="usage">Usage ${esc(w.usage)}</span>`);
      const tailHtml = pctTail.length ? ` · ${pctTail.join(" · ")}` : "";
      html += `<div class="quota">
        <div class="quota-row">
          <span>${esc(w.label)}</span>
          <span class="pct">${pct.toFixed(1)}%${tailHtml}</span>
        </div>
        <div class="bar"><div class="fill ${levelClass(pct)}" style="width:${pct}%"></div>${marker}</div>
      </div>`;
    }
    const limitResetText = fmtLimitResetCredits(account.rate_limit_reset_credits);
    if (limitResetText) {
      const applicable = account.rate_limit_reset_credits.applicable_available_count;
      const statusClass = Number(applicable) > 0 ? " ready" : "";
      html += `<div class="limit-resets${statusClass}">${esc(limitResetText)}</div>`;
    }
    html += "</div>";
  }

  for (const err of visibleErrors) {
    html += `<div class="error-card">${esc(err.provider)}: ${esc(err.error)}</div>`;
  }

  content.innerHTML = html || '<div class="status">No data</div>';
  scheduleErrorDismiss();
}

// 报错卡片出现后自动淡出消失,避免长期占据看板
function scheduleErrorDismiss() {
  const cards = content.querySelectorAll(".error-card");
  cards.forEach((el, i) => {
    setTimeout(() => {
      el.classList.add("hide");
      setTimeout(() => {
        el.remove();
        updateCompact();
        fitWindow();
      }, 400);
    }, ERROR_DISMISS_MS + i * 400);
  });
}

function fitWindow() {
  requestAnimationFrame(() => {
    // 必须在未折叠状态下测量,否则会得到"只含文字"的偏小高度
    document.body.classList.remove("compact");
    api.fitHeight(document.body.offsetHeight);
  });
}

// 窗口被手动拉窄时切换紧凑模式:隐藏进度条,仅显示文字
function updateCompact() {
  document.body.classList.remove("compact");
  const natural = document.body.offsetHeight;
  document.body.classList.toggle("compact", window.innerHeight < natural - 4);
}
window.addEventListener("resize", () => {
  updateCompact();
});

api.onUsageUpdate((payload) => {
  lastPayload = payload;
  btnRefresh.classList.remove("spin");
  if (payload.data) {
    buildDisplayList(payload.data.accounts || [], payload.data.errors || []);
    // 标题栏版本号；数据源被切换到非本机环境时显示环境标记
    const version = payload.data.monitor_version;
    titleVersion.textContent = version ? `v${version}` : "";
    const switched = payload.data.environment
      && payload.data.native_environment
      && payload.data.environment !== payload.data.native_environment;
    envBadge.classList.toggle("hidden", !switched);
    if (switched) envBadge.textContent = payload.data.environment;
  }
  render(payload);
  if (!settingsOpen) {
    updateCompact();
    fitWindow();
  }
});

// --- 点击版本徽章升级 ------------------------------------------------------
let upgrading = false;

// 当前所有可升级的 provider
function outdatedProviders() {
  const versions = (lastPayload && lastPayload.data && lastPayload.data.versions) || {};
  return Object.keys(versions).filter((p) => {
    const info = versions[p] || {};
    return info.current && info.latest && isNewerVersion(info.latest, info.current);
  });
}

function closeUpgradeOverlay() {
  const el = document.getElementById("upgrade-overlay");
  if (el) el.remove();
}

// 升级确认浮层(无边框窗口没有原生 confirm);多个 agent 可升级时给出"全部升级"选项
function showUpgradeOverlay(provider) {
  closeUpgradeOverlay();
  const outdated = outdatedProviders();
  if (!outdated.includes(provider)) return;
  const info = lastPayload.data.versions[provider];
  const buttons = [`<button data-act="one">Upgrade ${esc(provider)}</button>`];
  if (outdated.length > 1) {
    buttons.push(`<button data-act="all">Upgrade all (${outdated.length})</button>`);
  }
  buttons.push('<button data-act="cancel" class="ghost">Cancel</button>');
  const overlay = document.createElement("div");
  overlay.id = "upgrade-overlay";
  overlay.innerHTML = `<div class="upgrade-card">
    <div class="upgrade-title">${esc(provider)}</div>
    <div class="upgrade-ver">v${esc(info.current)} → ${esc(info.latest)}</div>
    <div class="upgrade-msg">Upgrade now?</div>
    <div class="upgrade-btns">${buttons.join("")}</div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn || upgrading) return;
    if (btn.dataset.act === "cancel") {
      closeUpgradeOverlay();
      return;
    }
    const targets = btn.dataset.act === "all" ? outdated : [provider];
    upgrading = true;
    const msg = overlay.querySelector(".upgrade-msg");
    overlay.querySelector(".upgrade-btns").innerHTML = "";
    msg.textContent = `Upgrading ${targets.join(", ")} …`;
    try {
      const data = (lastPayload && lastPayload.data) || {};
      // 升级目标跟随当前数据源环境（WSL 或 Windows 侧的 agent）
      const res = await api.upgrade(targets, data.environment, data.windows_setup_script);
      msg.textContent = res && res.ok
        ? "Upgrade finished"
        : `Upgrade failed: ${(res && res.error) || "unknown error"}`;
    } catch (err) {
      msg.textContent = `Upgrade failed: ${err}`;
    }
    upgrading = false;
    setTimeout(closeUpgradeOverlay, 1600);
    // 主进程升级完成后会推送 usage-update,这里无需手动重绘
  });
}

content.addEventListener("click", (e) => {
  const badge = e.target.closest(".ver.upgrade");
  if (badge && !upgrading) showUpgradeOverlay(badge.dataset.provider);
});
