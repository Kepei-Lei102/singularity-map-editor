// 独立材质层的唯一读取入口。材质只决定表面，不参与通行和视线。
// 约定：
// - 大格材质在 materialCells（key = 主格序号）。
// - 细分格材质在 materialSubCells（key = sy3 * width*3 + sx3），只在细分区域生效。
// - 没写材质就退回地形颜色；没有覆盖的大格再退回 materialCells。

import type { GameMap, Id, Material, World } from '../core/types';
import { SUB, subKey, terrainAtSubcell } from './terrain';

export function materialMap(world: Pick<World, 'materials'>): Map<Id, Material> {
  return new Map((world.materials ?? []).map((m) => [m.id, m]));
}

/** 大格材质；'' = 不覆写。 */
export function materialAtCell(m: GameMap, cell: number): Id | '' {
  return m.materialCells?.[cell] ?? '';
}

/** 子格材质；先看覆盖，再退回大格。 */
export function materialAtSubcell(m: GameMap, x3: number, y3: number): Id | '' {
  const x = Math.floor(x3 / SUB), y = Math.floor(y3 / SUB);
  if (x < 0 || y < 0 || x >= m.width || y >= m.height) return '';
  const cell = y * m.width + x;
  if (m.subdivisions?.includes(cell)) {
    const override = m.materialSubCells?.[subKey(m, x3, y3)];
    if (override !== undefined) return override;
  }
  return materialAtCell(m, cell);
}

/** 点所在地的材质；px/py 是主格单位的坐标。 */
export function materialAtPoint(m: GameMap, px: number, py: number): Id | '' {
  return materialAtSubcell(m, Math.floor(px * SUB), Math.floor(py * SUB));
}

/** 玩家记忆里的材质：大格看 seen.materialCells，子格看 seen.materialSubCells，再退回大格。 */
export function rememberedMaterialAtCell(m: GameMap, cell: number): Id | '' {
  return m.seen.materialCells?.[cell] ?? '';
}

export function rememberedMaterialAtSubcell(m: GameMap, x3: number, y3: number): Id | '' {
  const x = Math.floor(x3 / SUB), y = Math.floor(y3 / SUB);
  if (x < 0 || y < 0 || x >= m.width || y >= m.height) return '';
  const cell = y * m.width + x;
  if (m.subdivisions?.includes(cell)) {
    const override = m.seen.materialSubCells?.[subKey(m, x3, y3)];
    if (override !== undefined) return override;
  }
  return rememberedMaterialAtCell(m, cell);
}

/** 这个材质 id 在当前地形上有没有实际意义（空地形上的材质不画，免得浮在黑色上）。 */
export function materialVisibleOnTerrain(m: GameMap, x3: number, y3: number): boolean {
  return terrainAtSubcell(m, x3, y3) !== '';
}
