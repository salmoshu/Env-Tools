// 通用工具：转义、格式化、图表坐标辅助。与 v0.2.0 渲染逻辑保持一致。

export function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function fmt(value) {
  return value == null ? "-" : Math.round(value).toLocaleString("en-US");
}

export function abbrev(value) {
  if (value >= 1e9) return (value / 1e9).toFixed(1) + "B";
  if (value >= 1e6) return (value / 1e6).toFixed(1) + "M";
  if (value >= 1e3) return (value / 1e3).toFixed(0) + "K";
  return String(Math.round(value));
}

export function fmtPct(fraction) {
  return fraction == null ? "-" : (fraction * 100).toFixed(1) + "%";
}

export function fmtTimestamp(seconds, withSeconds = false) {
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (n) => String(n).padStart(2, "0");
  const base = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withSeconds ? `${base}:${pad(date.getSeconds())}` : base;
}

export function fmtReset(seconds) {
  if (seconds == null) return "";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `resets in ${d}d ${h}h`;
  if (h > 0) return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
}

export function fmtSpan(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function niceMax(value) {
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  const fraction = value / exp;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * exp;
}

export function levelClass(pct) {
  if (pct < 50) return "low";
  if (pct < 80) return "mid";
  return "high";
}

// 当前时间在配额窗口内走过的比例（对齐终端版 window_time_fraction）
export function timeFractionOf(w) {
  if (!w.window_seconds || w.window_seconds <= 0 || w.reset_after_seconds == null) return null;
  return Math.min(1, Math.max(0, (w.window_seconds - w.reset_after_seconds) / w.window_seconds));
}

export function isNewerVersion(latest, current) {
  const a = String(latest).split(".").map((n) => parseInt(n, 10) || 0);
  const b = String(current).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

export const AGENT_LABELS = {
  all: "All agents",
  kimi: "Kimi",
  codex: "Codex",
  glm: "GLM",
  deepseek: "DeepSeek",
};

export const AGENT_COLORS = {
  kimi: "#5b8def",
  codex: "#4cc38a",
  glm: "#e5a545",
  deepseek: "#9b7ede",
  other: "#94a3b8",
};

// --- 主题（跨窗口同步，选择持久化在本机 localStorage） -------------------------

const THEME_KEY = "ai-usage-monitor.theme";

export function readThemePreference() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (["system", "dark", "light"].includes(stored)) return stored;
  } catch {}
  return "system";
}

export function resolvedTheme(preference) {
  if (preference === "light" || preference === "dark") return preference;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(preference) {
  document.documentElement.dataset.theme = resolvedTheme(preference);
}

export function writeThemePreference(preference) {
  try { localStorage.setItem(THEME_KEY, preference); } catch {}
}

export function watchExternalTheme(onChange) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onMedia = () => {
    if (readThemePreference() === "system") onChange("system");
  };
  const onStorage = (event) => {
    if (event.key && event.key !== THEME_KEY) return;
    onChange(readThemePreference());
  };
  media.addEventListener("change", onMedia);
  window.addEventListener("storage", onStorage);
  return () => {
    media.removeEventListener("change", onMedia);
    window.removeEventListener("storage", onStorage);
  };
}

// --- 全局悬浮提示框（图表 hover 共用） -----------------------------------------

let tooltipEl = null;

export function ensureTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement("div");
  tooltipEl.id = "tooltip";
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

export function showTooltip(x, y, html) {
  const el = ensureTooltip();
  el.innerHTML = html;
  el.style.display = "block";
  const rect = el.getBoundingClientRect();
  let left = x + 14;
  let top = y + 14;
  if (left + rect.width > window.innerWidth - 8) left = x - rect.width - 12;
  if (top + rect.height > window.innerHeight - 8) top = y - rect.height - 12;
  el.style.left = `${Math.max(4, left)}px`;
  el.style.top = `${Math.max(4, top)}px`;
}

export function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = "none";
}

export function tipTitle(text) {
  return `<b>${esc(text)}</b>`;
}

export function tipRow(name, value, color = "") {
  const swatch = color ? `<span class="swatch" style="background:${color}"></span>` : "";
  return `<div class="tt-row">${swatch}${esc(name)}<span class="tt-val">${esc(value)}</span></div>`;
}

// 图表容器统一 hover 处理：目标元素带 data-tip 时显示悬浮框
export function bindChartTooltip(ref) {
  const container = ref.current;
  if (!container) return () => {};
  const onMove = (event) => {
    const target = event.target;
    const tip = target instanceof Element ? target.dataset.tip : null;
    if (tip) showTooltip(event.clientX, event.clientY, tip);
    else hideTooltip();
  };
  container.addEventListener("mousemove", onMove);
  container.addEventListener("mouseleave", hideTooltip);
  return () => {
    container.removeEventListener("mousemove", onMove);
    container.removeEventListener("mouseleave", hideTooltip);
  };
}
