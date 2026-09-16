// 全量模式（Usage Analytics）：Kimi 本地会话日志的用量分析看板 + 各套餐配额总览。
// 图表全部用原生 SVG/DOM 手绘（项目零依赖，CSP 也不允许外链脚本），
// 聚合口径参考 kimi-usage-dashboard（github.com/coconilu/kimi-usage-dashboard）。

const NS = "http://www.w3.org/2000/svg";
const ANALYTICS_REFRESH_MS = 5 * 60 * 1000;
const DAYS_KEY = "ai-usage-monitor.analytics-days";
const SERIES_COLORS = {
  input: "#5b8def",
  output: "#4cc38a",
  cache_read: "#9b7ede",
  cache_creation: "#e5a545",
};
const SERIES_DEFS = [
  ["input", "input", "var(--c-input)"],
  ["output", "output", "var(--c-output)"],
  ["cache_read", "cacheRead", "var(--c-cache-read)"],
  ["cache_creation", "cacheCreation", "var(--c-cache-creation)"],
];
const MODEL_PALETTE = [
  "#5b8def", "#4cc38a", "#9b7ede", "#e5a545",
  "#e5484d", "#3bc9db", "#f47ab8", "#94a3b8",
];
const MODEL_OTHER_COLOR = "#6b7385";

const metaEl = document.getElementById("meta");
const kpiRow = document.getElementById("kpi-row");
const quotaCards = document.getElementById("quota-cards");
const quotaErrors = document.getElementById("quota-errors");
const analyticsError = document.getElementById("analytics-error");
const daysSelect = document.getElementById("days-select");
const btnRefresh = document.getElementById("btn-refresh");
const titleVersion = document.getElementById("title-version");
const envBadge = document.getElementById("env-badge");
const tooltip = document.getElementById("tooltip");

let lastAnalytics = null;
let analyticsBusy = false;
let sessionsSort = { key: "total", dir: -1 };

// --- 主题：与用量看板共用同一个 localStorage 键，跨窗口实时同步 --------------
const THEME_KEY = "ai-usage-monitor.theme";
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
let themePreference = "system";
try {
  const stored = localStorage.getItem(THEME_KEY);
  if (["system", "dark", "light"].includes(stored)) themePreference = stored;
} catch {}

function resolvedTheme() {
  if (themePreference === "light" || themePreference === "dark") return themePreference;
  return systemDark.matches ? "dark" : "light";
}

function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
}

systemDark.addEventListener("change", () => {
  if (themePreference === "system") applyTheme();
});
// 在用量看板窗口的设置页切换主题时同步过来
window.addEventListener("storage", (event) => {
  if (event.key !== THEME_KEY) return;
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (["system", "dark", "light"].includes(stored)) themePreference = stored;
  } catch {}
  applyTheme();
});
applyTheme();

// --- 通用工具 ---------------------------------------------------------------
function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmt(value) {
  return value == null ? "-" : Math.round(value).toLocaleString("en-US");
}

function abbrev(value) {
  if (value >= 1e9) return (value / 1e9).toFixed(1) + "B";
  if (value >= 1e6) return (value / 1e6).toFixed(1) + "M";
  if (value >= 1e3) return (value / 1e3).toFixed(0) + "K";
  return String(Math.round(value));
}

function fmtPct(fraction) {
  return fraction == null ? "-" : (fraction * 100).toFixed(1) + "%";
}

function fmtTimestamp(seconds, withSeconds = false) {
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (n) => String(n).padStart(2, "0");
  const base = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withSeconds ? `${base}:${pad(date.getSeconds())}` : base;
}

function svgEl(tag, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (parent) parent.appendChild(node);
  return node;
}

function niceMax(value) {
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  const fraction = value / exp;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * exp;
}

// --- 悬浮提示框 ---------------------------------------------------------------
function showTooltip(x, y, html) {
  tooltip.innerHTML = html;
  tooltip.style.display = "block";
  const rect = tooltip.getBoundingClientRect();
  let left = x + 14;
  let top = y + 14;
  if (left + rect.width > window.innerWidth - 8) left = x - rect.width - 12;
  if (top + rect.height > window.innerHeight - 8) top = y - rect.height - 12;
  tooltip.style.left = `${Math.max(4, left)}px`;
  tooltip.style.top = `${Math.max(4, top)}px`;
}

function hideTooltip() {
  tooltip.style.display = "none";
}

function bindChartTooltip(container) {
  container.addEventListener("mousemove", (event) => {
    const target = event.target;
    const tip = target instanceof Element ? target.dataset.tip : null;
    if (tip) showTooltip(event.clientX, event.clientY, tip);
    else hideTooltip();
  });
  container.addEventListener("mouseleave", hideTooltip);
}

function tipTitle(text) {
  return `<b>${esc(text)}</b>`;
}

function tipRow(name, value, color = "") {
  const swatch = color ? `<span class="swatch" style="background:${color}"></span>` : "";
  return `<div class="tt-row">${swatch}${esc(name)}<span class="tt-val">${esc(value)}</span></div>`;
}

// --- 图表：堆叠柱状图 ---------------------------------------------------------
function stackedBarChart(container, labels, series, columnTip) {
  container.textContent = "";
  const width = Math.max(container.clientWidth || 0, 240);
  const height = Math.max(container.clientHeight || 0, 160);
  const margin = { top: 10, right: 10, bottom: 20, left: 52 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const totals = labels.map((_, i) => series.reduce((sum, s) => sum + (s.data[i] || 0), 0));
  const maxVal = niceMax(Math.max(1, ...totals));
  const svg = svgEl("svg", { width, height });

  for (let tick = 0; tick <= 4; tick++) {
    const y = margin.top + innerH - (innerH * tick) / 4;
    svgEl("line", {
      x1: margin.left, x2: margin.left + innerW, y1: y, y2: y,
      stroke: "var(--track)", "stroke-width": 1,
    }, svg);
    if (tick > 0) {
      const text = svgEl("text", {
        x: margin.left - 8, y: y + 3, "text-anchor": "end",
        "font-size": 9, fill: "var(--faint)",
      }, svg);
      text.textContent = abbrev((maxVal * tick) / 4);
    }
  }

  const slot = innerW / labels.length;
  const barWidth = Math.max(2, Math.min(30, slot * 0.62));
  const labelStep = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(innerW / 54))));
  labels.forEach((label, i) => {
    const x = margin.left + slot * i + (slot - barWidth) / 2;
    let acc = 0;
    for (const item of series) {
      const value = item.data[i] || 0;
      if (!value) continue;
      const bottom = margin.top + innerH - (acc / maxVal) * innerH;
      const top = margin.top + innerH - ((acc + value) / maxVal) * innerH;
      svgEl("rect", {
        x, y: top, width: barWidth, height: Math.max(1, bottom - top),
        fill: item.color, rx: Math.min(2, barWidth / 4),
      }, svg);
      acc += value;
    }
    const hit = svgEl("rect", {
      x: margin.left + slot * i, y: margin.top, width: slot, height: innerH,
      fill: "transparent",
    }, svg);
    hit.dataset.tip = columnTip(i, totals[i]);
    if (i % labelStep === 0) {
      const text = svgEl("text", {
        x: margin.left + slot * i + slot / 2, y: height - 6,
        "text-anchor": "middle", "font-size": 9, fill: "var(--faint)",
      }, svg);
      text.textContent = label;
    }
  });
  container.appendChild(svg);
}

// --- 图表：环形占比图 ---------------------------------------------------------
function donutArcPath(cx, cy, rInner, rOuter, start, end) {
  const px = (r, a) => cx + r * Math.cos(a);
  const py = (r, a) => cy + r * Math.sin(a);
  const large = end - start > Math.PI ? 1 : 0;
  return [
    `M ${px(rOuter, start)} ${py(rOuter, start)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${px(rOuter, end)} ${py(rOuter, end)}`,
    `L ${px(rInner, end)} ${py(rInner, end)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${px(rInner, start)} ${py(rInner, start)}`,
    "Z",
  ].join(" ");
}

function donutChart(container, items) {
  container.textContent = "";
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const size = 190;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = 82;
  const rInner = 50;
  const svg = svgEl("svg", { width: size, height: size });
  let angle = -Math.PI / 2;
  for (const item of items) {
    if (!item.value) continue;
    const fraction = total ? item.value / total : 0;
    // 接近整圆时留一个小缺口，避免 arc 起终点重合退化成无填充
    const sweep = Math.min(fraction, 0.9999) * Math.PI * 2;
    const path = donutArcPath(cx, cy, rInner, rOuter, angle, angle + sweep);
    svgEl("path", { d: path, fill: item.color, stroke: "var(--card)", "stroke-width": 1.5 }, svg);
    const hit = svgEl("path", { d: path, fill: "transparent" }, svg);
    hit.dataset.tip = tipTitle(item.name) +
      tipRow("tokens", fmt(item.value)) +
      tipRow("share", fmtPct(fraction));
    angle += sweep;
  }
  const centerValue = svgEl("text", {
    x: cx, y: cy - 1, "text-anchor": "middle",
    "font-size": 15, "font-weight": 600, fill: "var(--text)",
  }, svg);
  centerValue.textContent = abbrev(total);
  const centerLabel = svgEl("text", {
    x: cx, y: cy + 14, "text-anchor": "middle", "font-size": 9, fill: "var(--faint)",
  }, svg);
  centerLabel.textContent = "tokens";
  container.appendChild(svg);

  const legend = document.createElement("div");
  legend.className = "pie-legend";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<span class="swatch" style="background:${item.color}"></span>` +
      `<span class="name" title="${esc(item.name)}">${esc(item.name)}</span>` +
      `<span class="val">${abbrev(item.value)} · ${fmtPct(total ? item.value / total : 0)}</span>`;
    legend.appendChild(row);
  }
  container.appendChild(legend);
}

// --- 图表：折线图（缓存命中率）-------------------------------------------------
function lineChart(container, labels, values) {
  container.textContent = "";
  const width = Math.max(container.clientWidth || 0, 240);
  const height = Math.max(container.clientHeight || 0, 160);
  const margin = { top: 10, right: 10, bottom: 20, left: 44 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const svg = svgEl("svg", { width, height });

  for (let tick = 0; tick <= 4; tick++) {
    const fraction = tick / 4;
    const y = margin.top + innerH * (1 - fraction);
    svgEl("line", {
      x1: margin.left, x2: margin.left + innerW, y1: y, y2: y,
      stroke: "var(--track)", "stroke-width": 1,
    }, svg);
    const text = svgEl("text", {
      x: margin.left - 6, y: y + 3, "text-anchor": "end",
      "font-size": 9, fill: "var(--faint)",
    }, svg);
    text.textContent = `${fraction * 100}%`;
  }

  const step = innerW / Math.max(1, labels.length);
  const points = values.map((value, i) => [
    margin.left + step * (i + 0.5),
    margin.top + innerH * (1 - Math.min(1, Math.max(0, value))),
  ]);
  const linePath = points.map(([x, y], i) => `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const first = points[0] || [margin.left, margin.top + innerH];
  const last = points[points.length - 1] || first;
  svgEl("path", {
    d: `${linePath} L ${last[0].toFixed(1)} ${margin.top + innerH} L ${first[0].toFixed(1)} ${margin.top + innerH} Z`,
    fill: "var(--c-output)", "fill-opacity": 0.12, stroke: "none",
  }, svg);
  svgEl("path", {
    d: linePath, fill: "none", stroke: "var(--c-output)",
    "stroke-width": 2, "stroke-linejoin": "round",
  }, svg);

  const labelStep = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(innerW / 54))));
  labels.forEach((label, i) => {
    const hit = svgEl("rect", {
      x: margin.left + step * i, y: margin.top, width: step, height: innerH,
      fill: "transparent",
    }, svg);
    hit.dataset.tip = tipTitle(labels[i]) + tipRow("hit rate", fmtPct(values[i]));
    if (i % labelStep === 0) {
      const text = svgEl("text", {
        x: margin.left + step * (i + 0.5), y: height - 6,
        "text-anchor": "middle", "font-size": 9, fill: "var(--faint)",
      }, svg);
      text.textContent = label;
    }
  });
  container.appendChild(svg);
}

// --- 图表：项目排行（横向条）---------------------------------------------------
function projectBars(container, items) {
  container.textContent = "";
  if (!items.length) {
    container.innerHTML = '<div class="status">No data</div>';
    return;
  }
  const max = Math.max(1, ...items.map((item) => item.total));
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "proj-row";
    row.dataset.tip = tipTitle(item.path || item.name) +
      tipRow("tokens", fmt(item.total));
    row.innerHTML =
      `<span class="proj-name" title="${esc(item.name)}">${esc(item.name)}</span>` +
      `<div class="proj-track"><div class="proj-fill" style="width:${((item.total / max) * 100).toFixed(1)}%"></div></div>` +
      `<span class="proj-val">${abbrev(item.total)}</span>`;
    container.appendChild(row);
  }
}

// --- 图表：年度活动日历（GitHub 贡献图风格）-------------------------------------
function calendarHeatmap(container, calendar) {
  container.textContent = "";
  const byDate = new Map(calendar.days.map(([date, total, requests]) => [date, [total, requests]]));
  const start = new Date(`${calendar.range[0]}T00:00:00`);
  const end = new Date(`${calendar.range[1]}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
  // 对齐到周日开头 / 周六结尾
  const first = new Date(start);
  first.setDate(first.getDate() - first.getDay());
  const last = new Date(end);
  last.setDate(last.getDate() + (6 - last.getDay()));
  const maxVal = Math.max(1, ...calendar.days.map((cell) => cell[1]));
  const totalDays = Math.round((last - first) / 86400000) + 1;

  const weeks = Math.ceil(totalDays / 7);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthsRow = document.createElement("div");
  monthsRow.className = "cal-months";
  const monthLabels = new Array(weeks).fill("");
  for (let week = 0; week < weeks; week++) {
    const sunday = new Date(first.getTime() + week * 7 * 86400000);
    // 该周周日落在某月前 7 天时，把月份名标在这一列
    if (sunday.getDate() <= 7) monthLabels[week] = monthNames[sunday.getMonth()];
  }
  for (const label of monthLabels) {
    const span = document.createElement("span");
    span.style.width = "16px";
    span.textContent = label;
    monthsRow.appendChild(span);
  }

  const body = document.createElement("div");
  body.className = "cal-body";
  const weekdays = document.createElement("div");
  weekdays.className = "cal-weekdays";
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let day = 0; day < 7; day++) {
    const span = document.createElement("span");
    span.style.lineHeight = "13px";
    span.textContent = [0, 1, 3, 5].includes(day) ? dayNames[day] : "";
    weekdays.appendChild(span);
  }
  const cells = document.createElement("div");
  cells.className = "cal-days";
  const todayKey = new Date();
  for (let index = 0; index < totalDays; index++) {
    const day = new Date(first.getTime() + index * 86400000);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const entry = byDate.get(key);
    const cell = document.createElement("div");
    cell.className = "cal-cell";
    if (entry && entry[0] > 0) {
      const level = Math.min(4, Math.ceil((entry[0] / maxVal) * 4));
      cell.classList.add(`l${level}`);
    }
    if (key === `${todayKey.getFullYear()}-${String(todayKey.getMonth() + 1).padStart(2, "0")}-${String(todayKey.getDate()).padStart(2, "0")}`) {
      cell.style.outline = "1px solid var(--marker)";
    }
    cell.dataset.tip = tipTitle(key) +
      tipRow("tokens", fmt(entry ? entry[0] : 0)) +
      tipRow("requests", fmt(entry ? entry[1] : 0));
    cells.appendChild(cell);
  }
  body.appendChild(weekdays);
  body.appendChild(cells);
  container.appendChild(monthsRow);
  container.appendChild(body);
}

// --- 渲染：KPI 行 ---------------------------------------------------------------
function renderKpi(kpi) {
  let wowHtml = "";
  if (kpi.week_over_week != null) {
    const percent = (kpi.week_over_week * 100).toFixed(1);
    const up = kpi.week_over_week >= 0;
    wowHtml = `<span class="${up ? "up" : "down"}">${up ? "+" : ""}${percent}%</span> vs prev week`;
  }
  const cards = [
    ["Tokens (7 days)", fmt(kpi.week_total), wowHtml],
    ["Tokens today", fmt(kpi.today_total), ""],
    ["Cache hit rate", fmtPct(kpi.cache_hit_rate), ""],
    ["Active sessions", fmt(kpi.active_sessions), ""],
    ["Previous week", fmt(kpi.prev_week_total), ""],
  ];
  kpiRow.innerHTML = cards.map(([label, value, sub]) =>
    `<div class="kpi-card"><div class="kpi-label">${esc(label)}</div>` +
    `<div class="kpi-value">${esc(value)}</div>` +
    (sub ? `<div class="kpi-sub">${sub}</div>` : "") +
    "</div>"
  ).join("");
}

// --- 渲染：各图表 ---------------------------------------------------------------
function shortDateLabel(date) {
  return date.slice(5);
}

function renderCharts(analytics) {
  const dayList = analytics.day_list || [];
  const shortDays = dayList.map(shortDateLabel);
  const dailyByDate = new Map((analytics.daily || []).map((entry) => [entry.date, entry]));

  // 1. 每日 token 趋势
  document.getElementById("legend-daily").innerHTML = SERIES_DEFS.map(
    ([key, name, color]) => `<span class="item"><span class="swatch" style="background:${color}"></span>${esc(name)}</span>`
  ).join("");
  const dailyContainer = document.getElementById("chart-daily");
  stackedBarChart(
    dailyContainer,
    shortDays,
    SERIES_DEFS.map(([key, , color]) => ({
      color,
      data: (analytics.daily || []).map((entry) => entry[key]),
    })),
    (i, total) => {
      const entry = (analytics.daily || [])[i] || {};
      return tipTitle(entry.date || "") +
        SERIES_DEFS.map(([key, name]) => tipRow(name, fmt(entry[key]), SERIES_COLORS[key])).join("") +
        tipRow("total", fmt(total)) +
        tipRow("requests", fmt(entry.requests)) +
        tipRow("cache hit", fmtPct(entry.cache_hit_rate));
    },
  );

  // 2. 今日按小时
  document.getElementById("legend-hourly").innerHTML = SERIES_DEFS.slice(0, 3).map(
    ([key, name, color]) => `<span class="item"><span class="swatch" style="background:${color}"></span>${esc(name)}</span>`
  ).join("");
  const hourly = analytics.today_hourly || [];
  stackedBarChart(
    document.getElementById("chart-hourly"),
    hourly.map((entry) => String(entry.hour).padStart(2, "0")),
    SERIES_DEFS.map(([key, , color]) => ({ color, data: hourly.map((entry) => entry[key]) })),
    (i, total) => {
      const entry = hourly[i] || {};
      return tipTitle(`${String(i).padStart(2, "0")}:00 – ${String(i).padStart(2, "0")}:59`) +
        SERIES_DEFS.map(([key, name]) => tipRow(name, fmt(entry[key]), SERIES_COLORS[key])).join("") +
        tipRow("total", fmt(total)) +
        tipRow("requests", fmt(entry.requests));
    },
  );

  // 3. 模型占比（Top 8 + 其他）
  const rank = analytics.model_rank || [];
  const topModels = rank.slice(0, 8);
  const otherTotal = rank.slice(8).reduce((sum, item) => sum + item.total, 0);
  const pieItems = topModels.map((item, i) => ({
    name: item.model,
    value: item.total,
    color: MODEL_PALETTE[i % MODEL_PALETTE.length],
  }));
  if (otherTotal > 0) pieItems.push({ name: "other", value: otherTotal, color: MODEL_OTHER_COLOR });
  donutChart(document.getElementById("chart-pie"), pieItems);

  // 4. 每日 × 模型 堆叠柱
  const models = analytics.models || [];
  document.getElementById("legend-model").innerHTML = models.map((model, i) =>
    `<span class="item"><span class="swatch" style="background:${MODEL_PALETTE[i % MODEL_PALETTE.length]}"></span>${esc(model)}</span>`
  ).join("");
  const dailyModel = analytics.daily_model || {};
  stackedBarChart(
    document.getElementById("chart-model"),
    shortDays,
    models.map((model, i) => ({
      color: MODEL_PALETTE[i % MODEL_PALETTE.length],
      data: dayList.map((day) => (dailyModel[day] || [])[i] || 0),
    })),
    (i) => {
      const date = dayList[i] || "";
      const perModel = dailyModel[date] || [];
      return tipTitle(date) +
        models.map((model, j) => perModel[j] ? tipRow(model, fmt(perModel[j]), MODEL_PALETTE[j % MODEL_PALETTE.length]) : "").join("") +
        tipRow("total", fmt((dailyByDate.get(date) || {}).total || 0));
    },
  );

  // 5. 缓存命中率折线
  lineChart(
    document.getElementById("chart-hitrate"),
    shortDays,
    (analytics.daily || []).map((entry) => entry.cache_hit_rate),
  );

  // 6. 项目排行 Top 15
  projectBars(document.getElementById("chart-projects"), (analytics.project_rank || []).slice(0, 15));

  // 7. 年度活动日历
  calendarHeatmap(document.getElementById("chart-calendar"), analytics.calendar || { range: ["", ""], days: [] });
}

// --- 渲染：会话明细表 -------------------------------------------------------------
const SESSION_TABLE = document.getElementById("session-table");
const SESSION_SORT_KEYS = new Set(["first", "last", "total"]);

SESSION_TABLE.addEventListener("click", (event) => {
  const header = event.target.closest("th.sortable");
  if (!header) return;
  const key = header.dataset.key;
  if (sessionsSort.key === key) sessionsSort.dir = -sessionsSort.dir;
  else sessionsSort = { key, dir: -1 };
  if (lastAnalytics) renderSessions(lastAnalytics);
});

function renderSessions(analytics) {
  const rows = (analytics.sessions || []).slice()
    .sort((a, b) => ((a[sessionsSort.key] || 0) - (b[sessionsSort.key] || 0)) * sessionsSort.dir)
    .slice(0, 200);
  const header = (key, label, left = false) => {
    const arrow = sessionsSort.key === key ? (sessionsSort.dir < 0 ? " ▼" : " ▲") : "";
    const sortable = SESSION_SORT_KEYS.has(key) ? " sortable" : "";
    const attrs = sortable ? ` class="sortable${left ? " l" : ""}" data-key="${key}"` : (left ? ' class="l"' : "");
    return `<th${attrs}>${label}${arrow}</th>`;
  };
  const body = rows.map((session) => {
    const modelText = session.models.length > 1
      ? `${session.models.length} models`
      : (session.models[0] || "-");
    return "<tr>" +
      `<td class="l mono" title="${esc(session.session_id)}">${esc(session.session_id.replace("session_", "").slice(0, 8))}…</td>` +
      `<td class="l" title="${esc(session.work_dir)}">${esc(session.project)}</td>` +
      `<td class="l mono" title="${esc(session.models.join(", "))}">${esc(modelText)}</td>` +
      `<td>${fmt(session.input)}</td><td>${fmt(session.output)}</td><td>${fmt(session.cache_read)}</td>` +
      `<td>${fmt(session.requests)}</td>` +
      `<td class="l mono">${fmtTimestamp(session.first)}</td>` +
      `<td class="l mono">${fmtTimestamp(session.last)}</td>` +
      `<td><b>${fmt(session.total)}</b></td></tr>`;
  }).join("");
  SESSION_TABLE.innerHTML = "<thead><tr>" +
    header("session", "Session", true) +
    header("project", "Project", true) +
    header("models", "Models", true) +
    header("input", "Input") +
    header("output", "Output") +
    header("cache", "CacheRead") +
    header("requests", "Requests") +
    header("first", "Start", true) +
    header("last", "End", true) +
    header("total", "Total") +
    "</tr></thead><tbody>" + body + "</tbody>";
}

// --- 渲染：分析数据总入口 ----------------------------------------------------------
function renderAnalytics(analytics) {
  lastAnalytics = analytics;
  metaEl.textContent = `Range ${analytics.date_range[0]} – ${analytics.date_range[1]}` +
    ` (${analytics.days} days) · Updated ${analytics.generated_at}` +
    ` · Source ${analytics.source || "~/.kimi-code/sessions"}`;
  analyticsError.classList.add("hidden");
  renderKpi(analytics.kpi || {});
  renderCharts(analytics);
  renderSessions(analytics);
}

// --- 渲染：套餐配额卡片 -------------------------------------------------------------
function timeFractionOf(w) {
  if (!w.window_seconds || w.window_seconds <= 0 || w.reset_after_seconds == null) return null;
  return Math.min(1, Math.max(0, (w.window_seconds - w.reset_after_seconds) / w.window_seconds));
}

function levelClass(pct) {
  if (pct < 50) return "low";
  if (pct < 80) return "mid";
  return "high";
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

function fmtSpan(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function membershipLine(account) {
  const membership = account.membership;
  if (!membership || membership.error || !membership.ends_at) return "";
  const autoRenew = Boolean(membership.auto_renew);
  const endMs = new Date(membership.ends_at).getTime();
  if (!Number.isFinite(endMs)) return "";
  const leftSeconds = Math.floor((endMs - Date.now()) / 1000);
  const ended = leftSeconds < 0;
  const span = fmtSpan(Math.abs(leftSeconds));
  const pad = (n) => String(n).padStart(2, "0");
  const endDate = new Date(endMs);
  const endText = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())} ` +
    `${pad(endDate.getHours())}:${pad(endDate.getMinutes())}`;
  const left = ended ? `ended ${span} ago` : `${autoRenew ? "renews" : "ends"} in ${span}`;
  return `<div class="qmembership"><span>${autoRenew ? "Renews" : "Ends"}</span>` +
    `<strong>${esc(endText)}</strong>` +
    `<em class="${ended ? "ended" : ""}">${esc(left)}</em></div>`;
}

function renderQuota(payload) {
  if (payload.error) {
    quotaCards.innerHTML = "";
    quotaErrors.innerHTML = `<div class="error-card">${esc(payload.error)}</div>`;
    return;
  }
  const data = payload.data || {};
  const accounts = data.accounts || [];
  const errors = data.errors || [];
  const versions = data.versions || {};
  titleVersion.textContent = data.monitor_version ? `v${data.monitor_version}` : "";
  const switched = data.environment && data.native_environment
    && data.environment !== data.native_environment;
  envBadge.classList.toggle("hidden", !switched);
  if (switched) envBadge.textContent = data.environment;

  if (!accounts.length && !errors.length) {
    quotaCards.innerHTML = '<div class="status">No data</div>';
    quotaErrors.innerHTML = "";
    return;
  }
  quotaCards.innerHTML = accounts.map((account) => {
    const updated = account.fetched_at
      ? new Date(account.fetched_at).toLocaleTimeString("en-GB", { hour12: false })
      : "";
    const windows = (account.windows || []).map((w) => {
      const pct = w.used_percent == null ? 0 : Math.max(0, Math.min(100, w.used_percent));
      const fraction = timeFractionOf(w);
      const marker = fraction == null
        ? ""
        : `<div class="marker" style="left:${(fraction * 100).toFixed(1)}%"></div>`;
      const reset = fmtReset(w.reset_after_seconds);
      const tail = reset
        ? ` <span class="reset">${esc(reset)}</span>`
        : (w.usage && account.provider !== "GLM"
          ? ` <span class="reset">Usage ${esc(w.usage)}</span>`
          : "");
      return `<div class="qquota"><div class="qrow"><span>${esc(w.label)}</span>` +
        `<span class="pct">${pct.toFixed(1)}%${tail}</span></div>` +
        `<div class="bar"><div class="fill ${levelClass(pct)}" style="width:${pct}%"></div>${marker}</div></div>`;
    }).join("");
    const version = (versions[account.provider] || {}).current;
    return `<div class="qcard">` +
      `<div class="qcard-head"><span class="qname">${esc(account.provider)}</span>` +
      `<span class="plan">${esc(account.plan || "unknown")}</span>` +
      (version ? `<span class="qupdated">v${esc(version)}</span>` : "") +
      `<span class="qupdated">${esc(updated)}</span></div>` +
      membershipLine(account) +
      windows +
      "</div>";
  }).join("");
  quotaErrors.innerHTML = errors.map((err) =>
    `<div class="error-card">${esc(err.provider)}: ${esc(err.error)}</div>`
  ).join("");
}

// --- 数据获取 -----------------------------------------------------------------------
async function requestAnalytics() {
  if (analyticsBusy) return;
  analyticsBusy = true;
  btnRefresh.classList.add("spin");
  try {
    const result = await api.getAnalytics(Number(daysSelect.value) || 30);
    if (result && result.ok && result.analytics) {
      renderAnalytics(result.analytics);
    } else {
      analyticsError.textContent = (result && result.error) || "Analytics failed";
      analyticsError.classList.remove("hidden");
    }
  } catch (error) {
    analyticsError.textContent = `Analytics failed: ${error.message || error}`;
    analyticsError.classList.remove("hidden");
  } finally {
    analyticsBusy = false;
    btnRefresh.classList.remove("spin");
  }
}

// --- 事件接线 -----------------------------------------------------------------------
document.getElementById("btn-min").addEventListener("click", () => api.minimize());
document.getElementById("btn-close").addEventListener("click", () => api.close());
document.getElementById("btn-board").addEventListener("click", () => api.openUsageBoard());
document.getElementById("btn-settings").addEventListener("click", () => api.openBoardSettings());
btnRefresh.addEventListener("click", () => {
  api.refresh();
  requestAnalytics();
});
daysSelect.addEventListener("change", () => {
  try { localStorage.setItem(DAYS_KEY, daysSelect.value); } catch {}
  requestAnalytics();
});

try {
  const storedDays = localStorage.getItem(DAYS_KEY);
  if (storedDays && daysSelect.querySelector(`option[value="${storedDays}"]`)) {
    daysSelect.value = storedDays;
  }
} catch {}

api.onUsageUpdate(renderQuota);
bindChartTooltip(document.getElementById("chart-daily"));
bindChartTooltip(document.getElementById("chart-hourly"));
bindChartTooltip(document.getElementById("chart-model"));
bindChartTooltip(document.getElementById("chart-hitrate"));
bindChartTooltip(document.getElementById("chart-projects"));
bindChartTooltip(document.getElementById("chart-calendar"));

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (lastAnalytics) renderCharts(lastAnalytics);
  }, 160);
});

requestAnalytics();
setInterval(requestAnalytics, ANALYTICS_REFRESH_MS);
