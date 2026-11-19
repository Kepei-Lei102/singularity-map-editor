// 视野表的缓存：每格衰减表、建筑几何、子格挡死表都是 O(格数 + 建筑段)，
// 一队 9 个人各建一遍纯属浪费。这里按「地图对象 + 引用相等」复用，同眼高只建一次。
//
// 失效规则：immer 每次改动都会换掉被改到的数组/对象，没改的保持同一引用。
// 所以只要 refsOf() 里任何一个引用变了，这张地图的表就作废重建；缓存跟着地图对象走
// （WeakMap），换图/导入后旧表自然被回收。
import type { GameMap, World } from '../core/types';
import { buildSightTables, cellSightCost, type SightCtx, type SightTables } from './sight';

/** 同一地图最多缓存几个眼高：站/蹲/趴/坐各一个，再多也没用。 */
const MAX_EYES = 4;

interface Entry {
  refs: unknown[];
  ready: boolean;
  geometry?: SightTables['geometry'];
  block?: Uint8Array | null;
  cost: Map<number, Float32Array>;
}

const entries = new WeakMap<GameMap, Entry>();

/**
 * 表依赖哪些东西：地形定义、整格/细分格、材质格、物件（含开关状态与高度）、建筑段。
 * map.objects 同时被 cellSightCost（物件高度）和 architectureGeometry（门/墙状态）用到。
 */
function refsOf(world: World, map: GameMap): unknown[] {
  return [world.terrains, map.cells, map.fineCells, map.materialCells, map.fineMaterials, map.objects, map.architecture];
}

/** 给一张地图取表；同一张图、同一份内容反复调用不会重建。 */
export function sightCtxFor(world: World, map: GameMap): SightCtx {
  const refs = refsOf(world, map);
  let entry = entries.get(map);
  // 只有引用变了才重建：成本表也依赖这些引用，所以整份丢掉，不做部分保留。
  if (!entry || refs.some((r, i) => r !== entry!.refs[i])) {
    entry = { refs, ready: false, cost: new Map() };
    entries.set(map, entry);
  }
  const e = entry;
  return {
    tablesFor(eye: number): SightTables {
      if (!e.ready) {
        const tables = buildSightTables(world, map, eye);
        e.geometry = tables.geometry;
        e.block = tables.block;
        e.cost.set(eye, tables.cost);
        e.ready = true;
        return tables;
      }
      let cost = e.cost.get(eye);
      if (!cost) {
        // 几何和挡死表跟眼高无关，只有衰减表要按眼高重算。
        cost = cellSightCost(world, map, eye);
        e.cost.set(eye, cost);
        if (e.cost.size > MAX_EYES) {
          for (const key of e.cost.keys()) {
            if (e.cost.size <= MAX_EYES) break;
            if (key !== eye) e.cost.delete(key);
          }
        }
      }
      return { cost, geometry: e.geometry!, block: e.block ?? null };
    },
  };
}

/** 测试/诊断用：当前缓存了几张表。 */
export function sightCacheSize(map: GameMap): number {
  return entries.get(map)?.cost.size ?? 0;
}
