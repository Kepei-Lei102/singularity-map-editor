// 地形读取的唯一入口。
// 约定：
// - 底色永远在 GameMap.cells（大格）。
// - 细分过的格子里，子格可以在 subCells 里覆盖，key = sy3 * width*3 + sx3。
// - 没有覆盖时退回大格地形；不允许出现别的查找顺序。
// 渲染、碰撞、视线、迷雾、玩家同步都必须从这里拿地形，不要各自拼 key。

import type { GameMap, Terrain, World } from '../core/types';

export const SUB = 3;
export const subKey = (m: GameMap, x3: number, y3: number) => y3 * (m.width * SUB) + x3;

/** 这个坐标（主格单位，可带小数）所在的大格是否细分过。 */
export function isSubdivided(m: GameMap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= m.width || y >= m.height) return false;
  return !!m.subdivisions?.includes(Math.floor(y) * m.width + Math.floor(x));
}

/** 子格 id 对应的地形；先看覆盖，没有再退回大格。 */
export function terrainAtSubcell(m: GameMap, x3: number, y3: number): string {
  const x = Math.floor(x3 / SUB), y = Math.floor(y3 / SUB);
  if (x < 0 || y < 0 || x >= m.width || y >= m.height) return '';
  const cellIdx = y * m.width + x;
  if (m.subdivisions?.includes(cellIdx)) {
    const override = m.subCells?.[subKey(m, x3, y3)];
    if (override !== undefined) return override;
  }
  return m.cells[cellIdx] ?? '';
}

/** 点所在地形；px/py 是主格单位的小数坐标（和棋子、物件同一套坐标）。 */
export function terrainAtPoint(m: GameMap, px: number, py: number): string {
  return terrainAtSubcell(m, Math.floor(px * SUB), Math.floor(py * SUB));
}

export interface TerrainRect { x: number; y: number; w: number; h: number }

/** 地形查找表：运行时热路径用，不反复 find。 */
export function terrainMap(world: Pick<World, 'terrains'>): Map<string, Terrain> {
  return new Map(world.terrains.map((t) => [t.id, t]));
}

/** 与这块矩形相交、且 blocksMove 的地形小块。没细分的格子返回整格，细分过的格子返回 1/3 小块。 */
export function terrainBlockers(world: Pick<World, 'terrains'>, m: GameMap, area: TerrainRect): TerrainRect[] {
  const terrains = terrainMap(world);
  const out: TerrainRect[] = [];
  const x0 = Math.max(0, Math.floor(area.x)), y0 = Math.max(0, Math.floor(area.y));
  const x1 = Math.min(m.width - 1, Math.ceil(area.x + area.w) - 1);
  const y1 = Math.min(m.height - 1, Math.ceil(area.y + area.h) - 1);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const cellIdx = y * m.width + x;
    const fine = !!m.subdivisions?.includes(cellIdx);
    const n = fine ? SUB : 1;
    for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) {
      const id = fine ? terrainAtSubcell(m, x * SUB + sx, y * SUB + sy) : m.cells[cellIdx] ?? '';
      const t = terrains.get(id);
      if (t && !t.blocksMove) continue; // 没登记的地形（空白）按不可通行算，和旧规则一致
      out.push({ x: x + sx / n, y: y + sy / n, w: 1 / n, h: 1 / n });
    }
  }
  return out;
}

/** 矩形范围内有没有不可通行地形（只看地形，不看物件/墙）。 */
export function terrainBlocksRect(world: Pick<World, 'terrains'>, m: GameMap, rect: TerrainRect): boolean {
  return terrainBlockers(world, m, rect).length > 0;
}

/** 一个点是否站在不可通行地形上。 */
export function terrainBlocksPoint(world: Pick<World, 'terrains'>, m: GameMap, px: number, py: number): boolean {
  const id = terrainAtPoint(m, px, py);
  const t = terrainMap(world).get(id);
  return !t || t.blocksMove;
}

/** 这个位置的地形视野衰减系数。现在规则仍按大格算，等第二步细化到子格。 */
export function terrainVisionCoef(world: Pick<World, 'terrains'>, m: GameMap, x: number, y: number): number {
  const id = m.cells[y * m.width + x] ?? '';
  return terrainMap(world).get(id)?.visionCoef ?? 0;
}
