// 脏集 → 该重算哪些格（策略层，不算视野）。
//
// 三类触发分开处理：
//   · 只有棋子移动/转身：眼睛位置变了，能看见的范围只可能在「旧位置、新位置各一个半径圆盘」内；
//   · 结构变了（地形/建筑/物件/增删棋子）：任意视线都可能变，先保守地整图重算；
//   · 世界级变化（地形系数、队员、视野模式）：整份重算。
import type { GameMap, World } from '../core/types';
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
  /**
   * 结构视野改动按观察者半径收窄过。它仍然比纯棋子移动重得多，
   * 批量拖动时 store 会把这种计划也先欠着，松手补一次。
   */
  viewerScoped?: boolean;
  /** 这些地图的建筑记忆层必须整层重排（建筑几何变了，脏区近似会漏删旧墙）。 */
  architectureFullMaps?: Set<string>;
  /** 只改了地形、视野已收窄到观察者半径：记忆还能从圆盘再缩到真脏格 + 雾变化格。 */
  terrainOnlyMaps?: Set<string>;
  /** 只改材质：视野不动，记忆只同步材质变了的格。 */
  materialOnlyMaps?: Set<string>;
  /** 记忆同步专用脏格；有它时优先于 `maps`。 */
  memoryScopeMaps?: Map<string, Set<number>>;
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

/** 观察者半径圆盘：当前所有 PC 棋子 + 这次移动的旧/新位置（换 pcId 也靠它兜底）。 */
function viewerScope(map: GameMap, d: Dirty): Set<number> {
  const cells = new Set<number>();
  // 棋子可能站在 1/3 小格里，不能只按主格 floor 画圆盘：半径是主格中心距，
  // 小格偏移最多把边界格推到圆外一格，所以统一多圈一圈（宁可多算）。
  const r = VISION_RADIUS_CELLS + 1;
  const add = (x: number, y: number) => { for (const i of disc(map, Math.floor(x), Math.floor(y), r)) cells.add(i); };
  // 纯地形改动时，离改动格超过视野半径的观察者不可能被它影响；别把全队圆盘并进来。
  const changed = d.terrainOnly ? d.changedTerrainCells : undefined;
  const nearChanged = (x: number, y: number) => {
    if (!changed?.size) return true;
    for (const i of changed) {
      const cx = i % map.width, cy = Math.floor(i / map.width);
      if (gridDist(cx - x, cy - y) <= r) return true;
    }
    return false;
  };
  for (const t of map.tokens) if (t.pcId && nearChanged(Math.floor(t.x), Math.floor(t.y))) add(t.x, t.y);
  // 结构改动不走 moved；保留兜底，避免以后混入时漏算。
  for (const mv of d.moved) { add(mv.from.x, mv.from.y); add(mv.to.x, mv.to.y); }
  return cells;
}

/**
 * 脏集 → 每张图要重算的格子。
 * 结构视野改动只在观察者半径内换可见性（视野半径是硬上限），所以能用圆盘收窄；
 * 纯棋子移动仍按旧/新两个圆盘。手动雾、autoFog 开关、增删棋子、世界级变化走整图。
 */
export function planVision(next: World, dirty: Dirty[]): VisionPlan {
  const memoryFullMaps = new Set(dirty.filter((d) => d.full || (d.structure && !d.viewerScope && !d.materialOnly)).map((d) => d.mapId));
  const visionFull = dirty.some((d) => d.full)
    || dirty.some((d) => (d.visionStructure ?? d.structure) && !d.viewerScope);
  if (visionFull) return { full: true, maps: new Map(), memoryFullMaps: new Set(next.maps.map((m) => m.id)) };
  const maps = new Map<string, MapScope>();
  let viewerScoped = false;
  const architectureFullMaps = new Set(dirty.filter((d) => d.viewerScope && d.architectureChanged).map((d) => d.mapId));
  const terrainOnlyMaps = new Set(dirty.filter((d) => d.viewerScope && d.terrainOnly).map((d) => d.mapId));
  const materialOnlyMaps = new Set(dirty.filter((d) => d.materialOnly && d.changedMaterialCells?.size).map((d) => d.mapId));
  let memoryScopeMaps: Map<string, Set<number>> | undefined;
  for (const d of dirty) if (d.materialOnly && d.changedMaterialCells?.size) (memoryScopeMaps ??= new Map()).set(d.mapId, d.changedMaterialCells);
  for (const d of dirty) {
    const map = next.maps.find((m) => m.id === d.mapId);
    if (!map) continue;
    if (d.viewerScope) { viewerScoped = true; maps.set(d.mapId, viewerScope(map, d)); continue; }
    if (!d.moved.length) { maps.set(d.mapId, new Set()); continue; }
    const cells = new Set<number>();
    for (const mv of d.moved) {
      for (const i of disc(map, Math.floor(mv.from.x), Math.floor(mv.from.y))) cells.add(i);
      for (const i of disc(map, Math.floor(mv.to.x), Math.floor(mv.to.y))) cells.add(i);
    }
    maps.set(d.mapId, cells);
  }
  return { full: false, maps, memoryFullMaps, viewerScoped, architectureFullMaps, terrainOnlyMaps, materialOnlyMaps, memoryScopeMaps };
}
