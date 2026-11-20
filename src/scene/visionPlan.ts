// 脏集 → 该重算哪些格（策略层，不算视野）。
//
// 三类触发分开处理：
//   · 只有棋子移动/转身：眼睛位置变了，能看见的范围只可能在「旧位置、新位置各一个半径圆盘」内；
//   · 结构变了（地形/建筑/物件/增删棋子）：任意视线都可能变，先保守地整图重算；
//   · 世界级变化（地形系数、队员、视野模式）：整份重算。
import type { World } from '../core/types';
import { VISION_RADIUS_CELLS } from './sight';
import { gridDist } from '../core/util';
import type { Dirty } from './dirty';

/** 一张图的脏格：null = 整图；空集合 = 这张图没变。 */
export type MapScope = Set<number> | null;

export interface VisionPlan {
  full: boolean;
  maps: Map<string, MapScope>;
  /** 这些地图需要整份记忆同步（材质/贴图组/高度这类 memory-only 改动也算）。 */
  memoryFullMaps?: Set<string>;
}

/** 以 (cx, cy) 为心、半径 R 的圆盘（含边界），按主格取整。 */
function disc(map: { width: number; height: number }, cx: number, cy: number, r = VISION_RADIUS_CELLS): number[] {
  const out: number[] = [];
  const x0 = Math.max(0, cx - r), x1 = Math.min(map.width - 1, cx + r);
  const y0 = Math.max(0, cy - r), y1 = Math.min(map.height - 1, cy + r);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++)
    if (gridDist(x - cx, y - cy) <= r) out.push(y * map.width + x);
  return out;
}

/**
 * 脏集 → 每张图要重算的格子。
 * 只对「纯棋子移动」收窄；其余情况一律整图（宁可多算，不漏算）。
 */
export function planVision(next: World, dirty: Dirty[]): VisionPlan {
  const memoryFullMaps = new Set(dirty.filter((d) => d.full || d.structure).map((d) => d.mapId));
  const visionFull = dirty.some((d) => d.full) || dirty.some((d) => d.visionStructure ?? d.structure);
  if (visionFull) return { full: true, maps: new Map(), memoryFullMaps: new Set(next.maps.map((m) => m.id)) };
  const maps = new Map<string, MapScope>();
  for (const d of dirty) {
    const map = next.maps.find((m) => m.id === d.mapId);
    if (!map) continue;
    if (!d.moved.length) { maps.set(d.mapId, new Set()); continue; }
    const cells = new Set<number>();
    for (const mv of d.moved) {
      for (const i of disc(map, Math.floor(mv.from.x), Math.floor(mv.from.y))) cells.add(i);
      for (const i of disc(map, Math.floor(mv.to.x), Math.floor(mv.to.y))) cells.add(i);
    }
    maps.set(d.mapId, cells);
  }
  return { full: false, maps, memoryFullMaps };
}
