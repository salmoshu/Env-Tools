// Squarified treemap layout (Bruls, Huizing & van Wijk, 2000)。
// 1:1 移植自 Jharu src/components/squarify.ts（Apache 2.0），纯函数、无
// 图表库依赖：每个矩形面积正比于其值，并尽可能接近正方形。

/// areas 作为一行沿长度 side 排布时的最差纵横比（>=1，越小越方）。
function worst(areas, side) {
  let sum = 0, max = -Infinity, min = Infinity;
  for (const a of areas) {
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  const s2 = side * side;
  return Math.max((s2 * max) / (sum * sum), (sum * sum) / (s2 * min));
}

/**
 * 把 items（{value, item}）排进 box（{x,y,w,h}，百分比 0-100）。
 * 非正/非有限值的项被剔除；结果按大到小排序。
 * @returns Array<{x,y,w,h,item,value}>
 */
export function squarify(items, box) {
  if (box.w <= 0 || box.h <= 0) return [];
  const sorted = items
    .filter((i) => Number.isFinite(i.value) && i.value > 0)
    .sort((a, b) => b.value - a.value);
  if (sorted.length === 0) return [];

  const total = sorted.reduce((a, i) => a + i.value, 0);
  const scale = (box.w * box.h) / total;
  const areas = sorted.map((i) => i.value * scale);

  const out = [];
  let { x, y, w, h } = box;
  let start = 0;

  while (start < sorted.length) {
    // 行沿剩余区域较短的一边排。
    const side = Math.min(w, h);
    let end = start + 1;
    while (
      end < sorted.length &&
      worst(areas.slice(start, end + 1), side) <= worst(areas.slice(start, end), side)
    ) {
      end++;
    }

    const rowAreas = areas.slice(start, end);
    const rowSum = rowAreas.reduce((a, b) => a + b, 0);
    const last = end >= sorted.length;

    if (w >= h) {
      // 沿左边缘向下的一列。
      const colW = last ? w : rowSum / h;
      let cy = y;
      for (let i = start; i < end; i++) {
        const ch = i === end - 1 ? y + h - cy : areas[i] / colW;
        out.push({ x, y: cy, w: colW, h: ch, item: sorted[i].item, value: sorted[i].value });
        cy += ch;
      }
      x += colW;
      w -= colW;
    } else {
      // 沿顶边向右的一行。
      const rowH = last ? h : rowSum / w;
      let cx = x;
      for (let i = start; i < end; i++) {
        const cw = i === end - 1 ? x + w - cx : areas[i] / rowH;
        out.push({ x: cx, y, w: cw, h: rowH, item: sorted[i].item, value: sorted[i].value });
        cx += cw;
      }
      y += rowH;
      h -= rowH;
    }
    start = end;
  }
  return out;
}
