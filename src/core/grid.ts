// 小格坐标空间：一个大格固定 3×3。规则层仍用大格；小格用于地形、材质和以后的贴图。
export const SUB = 3;

/** 小格整数坐标对；用于第二刀的 CellSet / 贴图。 */
export type Coord = [number, number];

export const fineWidth = (width: number) => width * SUB;
export const fineHeight = (height: number) => height * SUB;
export const fineCount = (width: number, height: number) => width * height * SUB * SUB;
export const fineKey = (width: number, x3: number, y3: number) => y3 * fineWidth(width) + x3;
export const fineKeyOf = (m: { width: number }, x3: number, y3: number) => fineKey(m.width, x3, y3);

/** 大格坐标 = 小格坐标除以 3 取整（去掉小数）。 */
export const bigOf = ([x3, y3]: Coord): Coord => [Math.floor(x3 / SUB), Math.floor(y3 / SUB)];

/** 把一个粗格地形铺成 3×3 小格；旧存档迁移和新建地图共用。 */
export function buildFineCells(width: number, height: number, cells: string[]): string[] {
  const out = new Array<string>(fineCount(width, height));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = cells[y * width + x] ?? '';
    for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) out[fineKey(width, x * SUB + sx, y * SUB + sy)] = v;
  }
  return out;
}

/** 一组 id 里出现最多的那个；空 id 跳过，全空返回 ''。 */
export function dominantId(ids: readonly string[]): string {
  let best = '', bestN = 0;
  const count = new Map<string, number>();
  for (const id of ids) {
    if (!id) continue;
    const n = (count.get(id) ?? 0) + 1;
    count.set(id, n);
    if (n > bestN) { best = id; bestN = n; }
  }
  return best;
}

/** 「铺满空白格」真正会处理的格数：大格底为空且没有小格细节。 */
export function blankCellCount(m: { width: number; height: number; cells: string[]; fineCells?: string[] }): number {
  let n = 0;
  for (let i = 0; i < m.cells.length; i++) {
    if (!m.cells[i] && !hasFineDetail(m, i % m.width, Math.floor(i / m.width))) n++;
  }
  return n;
}

/** 这一大格里的 9 个小格是否和粗格底不同（有细格细节）。 */
export function hasFineDetail(m: { width: number; height: number; cells: string[]; fineCells?: string[] }, x: number, y: number): boolean {
  if (!m.fineCells) return false;
  const base = m.cells[y * m.width + x] ?? '';
  for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
    if (m.fineCells[fineKey(m.width, x * SUB + sx, y * SUB + sy)] !== base) return true;
  }
  return false;
}


/** 一组小格的包围盒；x1/y1 是**开区间**。空组返回 null。 */
export interface FineBounds { x0: number; y0: number; x1: number; y1: number }

export function groupBounds(width: number, cells: readonly number[], height?: number): FineBounds | null {
  if (!cells.length) return null;
  const fw = fineWidth(width), limit = height === undefined ? Infinity : fw * fineHeight(height);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const key of cells) {
    if (!Number.isSafeInteger(key) || key < 0 || key >= limit) continue;
    const x = key % fw, y = Math.floor(key / fw);
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x + 1 > x1) x1 = x + 1;
    if (y + 1 > y1) y1 = y + 1;
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

/** 物件脚印覆盖的小格；默认给物件贴图组用。锚点按 1/3 格偏移。 */
export function objectFootprintCells(width: number, height: number, o: { x: number; y: number; w: number; h: number; anchor?: { x: number; y: number } }): number[] {
  const fw = width * SUB, fh = height * SUB;
  const ax = Math.max(0, Math.min(SUB - 1, Math.floor(o.anchor?.x ?? 0)));
  const ay = Math.max(0, Math.min(SUB - 1, Math.floor(o.anchor?.y ?? 0)));
  const x3 = Math.floor(o.x * SUB) + ax, y3 = Math.floor(o.y * SUB) + ay;
  const out: number[] = [];
  for (let y = y3; y < y3 + o.h * SUB; y++) for (let x = x3; x < x3 + o.w * SUB; x++) {
    if (x >= 0 && x < fw && y >= 0 && y < fh) out.push(y * fw + x);
  }
  return out;
}

/** 整组平移若干小格；移出地图的格子丢掉。 */
export function shiftGroupCells(width: number, height: number, cells: readonly number[], dx3: number, dy3: number): number[] {
  const fw = width * SUB, fh = height * SUB;
  const out: number[] = [];
  for (const key of cells) {
    if (!Number.isSafeInteger(key) || key < 0) continue;
    const x = key % fw + dx3, y = Math.floor(key / fw) + dy3;
    if (x >= 0 && x < fw && y >= 0 && y < fh) out.push(y * fw + x);
  }
  return out;
}
