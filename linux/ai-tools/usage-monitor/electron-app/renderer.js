const content = document.getElementById("content");
const btnPin = document.getElementById("btn-pin");
const btnRefresh = document.getElementById("btn-refresh");
const filterBtn = document.getElementById("provider-filter");
const filterMenu = document.getElementById("filter-menu");
const filterLabel = filterBtn.querySelector(".filter-label");
let lastPayload = null;
let currentFilter = "__all__";
const ERROR_DISMISS_MS = 8000;

document.getElementById("btn-min").addEventListener("click", () => api.minimize());
document.getElementById("btn-close").addEventListener("click", () => api.close());
document.getElementById("btn-refresh").addEventListener("click", () => {
  // 已有内容时保留旧数据,不闪烁成"刷新中";仅首次无内容时显示占位
  if (!content.querySelector(".provider")) {
    content.innerHTML = '<div class="status">刷新中…</div>';
  }
  btnRefresh.classList.add("spin");
  api.refresh();
});
btnPin.addEventListener("click", async () => {
  updatePinState(await api.togglePin());
});
api.getPinState().then(updatePinState);

// provider 筛选:All 或单个模型(自定义下拉菜单)
filterBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  filterMenu.classList.toggle("open");
});
document.addEventListener("click", () => filterMenu.classList.remove("open"));

function buildFilterMenu(accounts) {
  const names = accounts.map((a) => a.provider);
  if (!names.includes(currentFilter)) currentFilter = "__all__";
  filterMenu.innerHTML =
    '<div class="item" data-val="__all__">All</div>' +
    names.map((n) => `<div class="item" data-val="${esc(n)}">${esc(n)}</div>`).join("");
  filterMenu.querySelectorAll(".item").forEach((item) => {
    if (item.dataset.val === currentFilter) item.classList.add("active");
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      currentFilter = item.dataset.val;
      filterLabel.textContent = currentFilter === "__all__" ? "All" : currentFilter;
      filterMenu.classList.remove("open");
      if (lastPayload) {
        api.resetFit();
        render(lastPayload);
        updateCompact();
        fitWindow();
      }
    });
  });
  filterLabel.textContent = currentFilter === "__all__" ? "All" : currentFilter;
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
  let html = `<span class="ver">v${esc(info.current)}`;
  if (info.latest && isNewerVersion(info.latest, info.current)) {
    html += ` <span class="new">→ ${esc(info.latest)}</span>`;
  }
  return html + "</span>";
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
  const accounts = currentFilter === "__all__"
    ? allAccounts
    : allAccounts.filter((a) => a.provider === currentFilter);
  // 报错也按当前筛选显示:选单个模型时隐藏其它模型的报错
  const visibleErrors = currentFilter === "__all__"
    ? errors
    : errors.filter((e) => e.provider === currentFilter);
  let html = "";

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
    for (const w of account.windows || []) {
      const pct = w.used_percent == null ? 0 : Math.max(0, Math.min(100, w.used_percent));
      const frac = timeFraction(w);
      const marker = frac == null
        ? ""
        : `<div class="marker" style="left:${(frac * 100).toFixed(1)}%"></div>`;
      html += `<div class="quota">
        <div class="quota-row">
          <span>${esc(w.label)}</span>
          <span class="pct">${pct.toFixed(1)}% <span class="reset">· ${esc(fmtReset(w.reset_after_seconds))}</span></span>
        </div>
        <div class="bar"><div class="fill ${levelClass(pct)}" style="width:${pct}%"></div>${marker}</div>
      </div>`;
    }
    html += "</div>";
  }

  for (const err of visibleErrors) {
    html += `<div class="error-card">${esc(err.provider)}: ${esc(err.error)}</div>`;
  }

  content.innerHTML = html || '<div class="status">暂无数据</div>';
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
window.addEventListener("resize", updateCompact);

api.onUsageUpdate((payload) => {
  lastPayload = payload;
  btnRefresh.classList.remove("spin");
  if (payload.data) buildFilterMenu(payload.data.accounts || []);
  render(payload);
  updateCompact();
  fitWindow();
});
