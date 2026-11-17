// 独立材质层的唯一读取入口。材质只决定表面，不参与通行和视线。
// 约定：
// - 大格材质底在 materialCells（key = 主格序号）。
// - 小格材质覆盖在 fineMaterials（key = y3*(width*3)+x3）；没有覆盖就退回大格。
// - 没写材质就退回地形颜色。

import type { GameMap, Id, Material, World } from '../core/types';
import { SUB, fineKeyOf } from '../core/grid';
import { terrainAtSubcell } from './terrain';

export function materialMap(world: Pick<World, 'materials'>): Map<Id, Material> {
  return new Map((world.materials ?? []).map((m) => [m.id, m]));
}

/** 大格材质；'' = 不覆写。 */
export function materialAtCell(m: GameMap, cell: number): Id | '' {
  return m.materialCells?.[cell] ?? '';
}

/** 小格材质；先看小格覆盖，再退回大格。 */
export function materialAtSubcell(m: GameMap, x3: number, y3: number): Id | '' {
  if (x3 < 0 || y3 < 0 || x3 >= m.width * SUB || y3 >= m.height * SUB) return '';
  const fine = m.fineMaterials?.[fineKeyOf(m, x3, y3)];
  if (fine !== undefined) return fine;
  return materialAtCell(m, Math.floor(y3 / SUB) * m.width + Math.floor(x3 / SUB));
}

/** 点所在地的材质；px/py 是主格单位的坐标。 */
export function materialAtPoint(m: GameMap, px: number, py: number): Id | '' {
  return materialAtSubcell(m, Math.floor(px * SUB), Math.floor(py * SUB));
}

/** 玩家记忆里的材质：大格看 seen.materialCells。 */
export function rememberedMaterialAtCell(m: GameMap, cell: number): Id | '' {
  return m.seen.materialCells?.[cell] ?? '';
}

export function rememberedMaterialAtSubcell(m: GameMap, x3: number, y3: number): Id | '' {
  if (x3 < 0 || y3 < 0 || x3 >= m.width * SUB || y3 >= m.height * SUB) return '';
  return rememberedMaterialAtCell(m, Math.floor(y3 / SUB) * m.width + Math.floor(x3 / SUB));
}

/** 这个材质 id 在当前地形上有没有实际意义（空地形上的材质不画，免得浮在黑色上）。 */
export function materialVisibleOnTerrain(m: GameMap, x3: number, y3: number): boolean {
  return terrainAtSubcell(m, x3, y3) !== '';
}
