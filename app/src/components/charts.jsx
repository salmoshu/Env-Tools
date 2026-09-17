// 图表组件：原生 SVG 手绘（零依赖），从 v0.2.0 的 dashboard.js 移植。
// 数据变化时在 effect 里重建 SVG；hover 提示统一走 utils 的全局 tooltip。

import { useEffect, useRef } from "react";
import {
  abbrev, bindChartTooltip, esc, fmt, fmtPct, niceMax, tipRow, tipTitle,
} from "../utils.js";

const NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (parent) parent.appendChild(node);
  return node;
}

export const SERIES_DEFS = [
  ["input", "input", "var(--c-input)"],
  ["output", "output", "var(--c-output)"],
  ["cache_read", "cacheRead", "var(--c-cache-read)"],
  ["cache_creation", "cacheCreation", "var(--c-cache-creation)"],
];

export const MODEL_PALETTE = [
  "#5b8def", "#4cc38a", "#9b7ede", "#e5a545",
  "#e5484d", "#3bc9db", "#f47ab8", "#94a3b8",
];

function buildStackedBars(container, labels, series, columnTip) {
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

export function StackedBars({ labels, series, columnTip, className = "" }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !labels) return;
    buildStackedBars(ref.current, labels, series, columnTip);
  });
  useEffect(() => bindChartTooltip(ref), []);
  return <div ref={ref} className={`chart ${className}`} />;
}

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

export function DonutChart({ items }) {
  const ref = useRef(null);
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
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
  }, [items]);
  useEffect(() => bindChartTooltip(ref), []);
  return <div ref={ref} className="pie-wrap" />;
}

export function LineChart({ labels, values }) {
  const ref = useRef(null);
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
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
  }, [labels, values]);
  useEffect(() => bindChartTooltip(ref), []);
  return <div ref={ref} className="chart" />;
}

/** 数值折线图（token 趋势）：y 轴按数据自适应刻度，tooltip 显示绝对值 */
export function ValueLineChart({ labels, values, valueLabel = "tokens" }) {
  const ref = useRef(null);
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    container.textContent = "";
    const width = Math.max(container.clientWidth || 0, 240);
    const height = Math.max(container.clientHeight || 0, 170);
    const margin = { top: 10, right: 12, bottom: 20, left: 52 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const maxVal = niceMax(Math.max(1, ...values, 1));
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
      text.textContent = abbrev((maxVal * tick) / 4);
    }

    const step = innerW / Math.max(1, labels.length);
    const points = values.map((value, i) => [
      margin.left + step * (i + 0.5),
      margin.top + innerH * (1 - Math.min(1, (value || 0) / maxVal)),
    ]);
    const linePath = points.map(([x, y], i) => `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    const first = points[0] || [margin.left, margin.top + innerH];
    const last = points[points.length - 1] || first;
    svgEl("path", {
      d: `${linePath} L ${last[0].toFixed(1)} ${margin.top + innerH} L ${first[0].toFixed(1)} ${margin.top + innerH} Z`,
      fill: "var(--accent)", "fill-opacity": 0.1, stroke: "none",
    }, svg);
    svgEl("path", {
      d: linePath, fill: "none", stroke: "var(--accent)",
      "stroke-width": 2, "stroke-linejoin": "round",
    }, svg);
    for (const [x, y] of points) {
      svgEl("circle", { cx: x, cy: y, r: 2.2, fill: "var(--accent)" }, svg);
    }

    const labelStep = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(innerW / 54))));
    labels.forEach((label, i) => {
      const hit = svgEl("rect", {
        x: margin.left + step * i, y: margin.top, width: step, height: innerH,
        fill: "transparent",
      }, svg);
      hit.dataset.tip = tipTitle(labels[i]) + tipRow(valueLabel, fmt(values[i] || 0));
      if (i % labelStep === 0) {
        const text = svgEl("text", {
          x: margin.left + step * (i + 0.5), y: height - 6,
          "text-anchor": "middle", "font-size": 9, fill: "var(--faint)",
        }, svg);
        text.textContent = label;
      }
    });
    container.appendChild(svg);
  }, [labels, values, valueLabel]);
  useEffect(() => bindChartTooltip(ref), []);
  return <div ref={ref} className="chart" />;
}

export function ProjectBars({ items }) {
  const ref = useRef(null);
  useEffect(() => bindChartTooltip(ref), []);
  if (!items || !items.length) {
    return <div className="status">No data</div>;
  }
  const max = Math.max(1, ...items.map((item) => item.total));
  return (
    <div className="projects" ref={ref}>
      {items.map((item) => (
        <div
          key={`${item.name}\u0000${item.path}`}
          className="proj-row"
          data-tip={tipTitle(item.path || item.name) + tipRow("tokens", fmt(item.total))}
        >
          <span className="proj-name" title={item.name}>{item.name}</span>
          <div className="proj-track">
            <div className="proj-fill" style={{ width: `${((item.total / max) * 100).toFixed(1)}%` }} />
          </div>
          <span className="proj-val">{abbrev(item.total)}</span>
        </div>
      ))}
    </div>
  );
}

export function CalendarHeatmap({ calendar }) {
  const ref = useRef(null);
  useEffect(() => {
    const container = ref.current;
    if (!container || !calendar) return;
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
    // v0.7.1：网格铺满容器宽度，月份标签与周列一一对应
    monthsRow.className = "cal-months";
    monthsRow.style.display = "grid";
    monthsRow.style.gridTemplateColumns = `repeat(${weeks}, minmax(13px, 1fr))`;
    monthsRow.style.gap = "3px";
    const monthLabels = new Array(weeks).fill("");
    let lastLabeledMonth = -1;
    for (let week = 0; week < weeks; week++) {
      const sunday = new Date(first.getTime() + week * 7 * 86400000);
      // 该周周日进入新月份时标月份名（同月不重复标注）
      if (sunday.getDate() <= 7 && sunday.getMonth() !== lastLabeledMonth) {
        monthLabels[week] = monthNames[sunday.getMonth()];
        lastLabeledMonth = sunday.getMonth();
      }
    }
    for (const label of monthLabels) {
      const span = document.createElement("span");
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
    cells.style.display = "grid";
    cells.style.gridTemplateRows = "repeat(7, 13px)";
    cells.style.gridAutoFlow = "column";
    cells.style.gridAutoColumns = "minmax(13px, 1fr)";
    cells.style.gap = "3px";
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
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
      if (key === todayKey) cell.style.outline = "1px solid var(--marker)";
      cell.dataset.tip = tipTitle(key) +
        tipRow("tokens", fmt(entry ? entry[0] : 0)) +
        tipRow("requests", fmt(entry ? entry[1] : 0));
      cells.appendChild(cell);
    }
    body.appendChild(weekdays);
    body.appendChild(cells);
    container.appendChild(monthsRow);
    container.appendChild(body);
  }, [calendar]);
  useEffect(() => bindChartTooltip(ref), []);
  return <div className="calendar-scroll" ref={ref} />;
}
