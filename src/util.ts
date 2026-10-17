export const uid = () => Math.random().toString(36).slice(2, 10);

/** 一格在世界坐标里的像素边长。 */
export const CS = 32;

export function download(filename: string, data: Blob | string, mime = 'text/plain') {
  const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fmtTime(t: number) {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 两格之间的格子（Bresenham），画笔拖动时防止断线。 */
export function cellLine(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1); // 只走整数格，小数会让循环停不下来
  const out: [number, number][] = [];
  if (![x0, y0, x1, y1].every(Number.isFinite)) return out; // 坏坐标（NaN、无穷）：一格也不走，也不会死循环
  if (Math.abs(x1 - x0) + Math.abs(y1 - y0) > 4000) return [[x0, y0], [x1, y1]]; // 地图最大 200×200，再远一定是坏数据
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return out;
}

/** 圆形距离，向下取整：⌊√(dx²+dy²)⌋ */
export const gridDist = (dx: number, dy: number) => Math.floor(Math.sqrt(dx * dx + dy * dy));

/** 某格到一个矩形（物件）最近那一格的距离，以及那一格。 */
export function distToRect(x: number, y: number, r: { x: number; y: number; w: number; h: number }) {
  const nx = Math.max(r.x, Math.min(r.x + r.w - 1, x));
  const ny = Math.max(r.y, Math.min(r.y + r.h - 1, y));
  return { d: gridDist(nx - x, ny - y), nx, ny };
}

// ---------- Excel 式坐标：列 A, B … Z, AA …；行从 1 开始。内部 x/y 仍然从 0 开始。 ----------

export function colName(x: number) {
  let s = '';
  for (let n = x + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
export const cellName = (x: number, y: number) => `${colName(x)}${y + 1}`;
/** 一个矩形覆盖的格子：B2，或 B2:F3。 */
export const rangeName = (r: { x: number; y: number; w: number; h: number }) =>
  r.w === 1 && r.h === 1 ? cellName(r.x, r.y) : `${cellName(r.x, r.y)}:${cellName(r.x + r.w - 1, r.y + r.h - 1)}`;
export function parseCell(s: string): { x: number; y: number } | null {
  const m = /^\s*([A-Za-z]+)\s*(\d+)\s*$/.exec(s);
  if (!m || +m[2] < 1) return null;
  let x = 0;
  for (const ch of m[1].toUpperCase()) x = x * 26 + (ch.charCodeAt(0) - 64);
  return { x: x - 1, y: +m[2] - 1 };
}
