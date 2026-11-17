// 地形读取的唯一入口。
// 约定：
// - 大格底在 GameMap.cells；规则/旧逻辑仍可用它。
// - 小格在 GameMap.fineCells 里是完整数组，长度 = width*3 * height*3，key = y3*(width*3)+x3。
// - 没有小格细节的大格，fineCells 的 9 格与 cells 相同；有细节时逐小格读。
// 渲染、碰撞、视线、迷雾、玩家同步都必须从这里拿地形，不要各自拼 key。

import type { GameMap, Terrain, World } from '../core/types';
import { SUB, fineKeyOf, hasFineDetail } from '../core/grid';
import { heightAt } from './height';

export { SUB };
export const subKey = (m: GameMap, x3: number, y3: number) => fineKeyOf(m, x3, y3);

/** 这个坐标（主格单位，可带小数）所在的大格有没有小格细节。 */
export function isSubdivided(m: GameMap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= m.width || y >= m.height) return false;
  return hasFineDetail(m, Math.floor(x), Math.floor(y));
}

/** 小格地形；没有 fineCells 的旧数据退回大格。 */
export function terrainAtSubcell(m: GameMap, x3: number, y3: number): string {
  if (x3 < 0 || y3 < 0 || x3 >= m.width * SUB || y3 >= m.height * SUB) return '';
  return m.fineCells?.[subKey(m, x3, y3)] ?? m.cells[Math.floor(y3 / SUB) * m.width + Math.floor(x3 / SUB)] ?? '';
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

/** 与这块矩形相交、且 blocksMove 的地形小块。有细格细节的格子返回 1/3 小块，否则返回整格。 */
export function terrainBlockers(world: Pick<World, 'terrains'>, m: GameMap, area: TerrainRect): TerrainRect[] {
  const terrains = terrainMap(world);
  const out: TerrainRect[] = [];
  const x0 = Math.max(0, Math.floor(area.x)), y0 = Math.max(0, Math.floor(area.y));
  const x1 = Math.min(m.width - 1, Math.ceil(area.x + area.w) - 1);
  const y1 = Math.min(m.height - 1, Math.ceil(area.y + area.h) - 1);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const fine = hasFineDetail(m, x, y), n = fine ? SUB : 1;
    for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) {
      const id = fine ? terrainAtSubcell(m, x * SUB + sx, y * SUB + sy) : m.cells[y * m.width + x] ?? '';
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

/**
 * 这一格的地形对走路是什么性质。
 * - open：能站
 * - wall：挡住，也跳不过去
 * - gap：挡住，但能跳过去（坑 / 楼间空隙）
 */
export type CellFloor = 'open' | 'wall' | 'gap';

/**
 * 这一格有没有坑底。
 *
 * 判据：它比旁边能站的地面低——那就是有底的坑（沟、浅坑），人掉下去是站在坑底的。
 * 跟旁边一样高＝没建模坑底（天井、楼间空隙），掉下去是下一层。
 */
export function hasPitBottom(world: Pick<World, 'terrains'>, m: GameMap, x: number, y: number): boolean {
  const terrains = terrainMap(world);
  const h = heightAt(m, x, y);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= m.width || ny >= m.height) continue;
    const t = terrains.get(m.cells[ny * m.width + nx] ?? '');
    if (!t || t.blocksMove) continue;
    if (heightAt(m, nx, ny) > h) return true;
  }
  return false;
}

export function cellFloor(world: Pick<World, 'terrains'>, m: GameMap, x: number, y: number): CellFloor {
  if (x < 0 || y < 0 || x >= m.width || y >= m.height) return 'wall';
  const terrains = terrainMap(world);
  const idx = y * m.width + x;
  if (!hasFineDetail(m, x, y)) {
    const t = terrains.get(m.cells[idx] ?? '');
    // 没登记的地形按旧规则当不可通行，也当墙（跳不过去）。
    if (!t) return 'wall';
    if (!t.blocksMove) return 'open';
    return t.crossable === false ? 'wall' : 'gap';
  }
  // 有细格细节的格子：三个子格有任何一个不能站，就按整格算。
  let sawGap = false;
  for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
    const t = terrains.get(terrainAtSubcell(m, x * SUB + sx, y * SUB + sy));
    if (!t) return 'wall';
    if (!t.blocksMove) continue;
    if (t.crossable === false) return 'wall';
    sawGap = true;
  }
  return sawGap ? 'gap' : 'open';
}
