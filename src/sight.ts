// 视线：按《规则书》【视野衰减系数】【视野难度的核心是每格衰减系数】实现。
//
// 和 perception.ts 的老算法的区别只有三处：
//   1. 每格基线不是 0 而是 0.1（无障碍也是 0.1），所以预算 1.56 ÷ 0.1 = 15.6 → 15 格。
//   2. 预算从 "≥1 就断" 改成 "≤1.56"。1.5 够，1.6 不够。
//   3. 累加包含目标格本身（老算法把目标格排除在外，会多算一格）。
//
// 视野锥：按格子所在区域取。D20 区 120°，D100 区 60°（恐怖区）。30° 暂不做。

import type { Facing, GameMap, MapObject, Sex, Stance, Token, World } from './types';
export type { Facing, Sex, Stance } from './types';
import { objectEnabled } from './objectData.js';
import { isArchitectureObject } from './architecture';
import { cellLine, gridDist } from './util';

/** 视野预算。规则书：无障碍 15 格 = 1.5，＜1.56，所以第 16 格看不见。 */
export const VISION_BUDGET = 1.56;
/** 每格最低消耗（无障碍）。 */
export const BASE_CELL_COST = 0.1;
/** 完全挡住：够高或者性质挡死。 */
export const FULL_BLOCK = 99;

/** 眼高占身高的比例。 */
export const EYE_RATIO = 0.93;
/** 站姿眼高默认（厘米）：男 173、女 164，性别不明按 170。 */
export const DEFAULT_HEIGHT_CM = { 男: 173, 女: 164, 其他: 170 } as const;
/** 蹲下／趴下是锁死高度，不按身高算。 */
export const STANCE_EYE = { 蹲: 0.9, 趴: 0.3 } as const;


export interface Body {
  sex?: Sex;
  heightCm?: number;
  stance?: Stance;
}

/** 眼高（米）。站姿按身高 × 0.93；蹲／趴用锁死值。 */
export function eyeHeight(body: Body = {}): number {
  const stance = body.stance ?? '站';
  if (stance === '蹲') return STANCE_EYE.蹲;
  if (stance === '趴') return STANCE_EYE.趴;
  const cm = body.heightCm ?? DEFAULT_HEIGHT_CM[body.sex ?? '其他'];
  return Math.round(cm * EYE_RATIO) / 100;
}

/** 视野锥角：站在 D100 区里 60°，否则 120°。 */
export function coneFor(map: GameMap, x: number, y: number): number {
  const i = y * map.width + x;
  return map.d100?.[i] ? 60 : 120;
}

/** 一格挡视线的程度：地形系数与基线取大；物件按身高或显式系数给。 */
export function cellSightCost(
  world: World,
  map: GameMap,
  eye: number,
): Float32Array {
  const coef = new Map(world.terrains.map((t) => [t.id, t.visionCoef]));
  const cost = new Float32Array(map.width * map.height);
  for (let i = 0; i < cost.length; i++) {
    const c = coef.get(map.cells[i]) ?? BASE_CELL_COST;
    cost[i] = Math.max(c, BASE_CELL_COST);
  }
  for (const o of map.objects) {
    if (!objectEnabled(map, o) || o.kind !== 'object' || isArchitectureObject(o)) continue;
    const c = objectSightCost(o, eye);
    if (c <= 0) continue;
    for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++)
      if (x >= 0 && y >= 0 && x < map.width && y < map.height) {
        const i = y * map.width + x;
        cost[i] = Math.max(cost[i], c);
      }
  }
  return cost;
}

/**
 * 物件挡视线的程度。三种来源，优先级从高到低：
 *   1. 显式 sightCost（草丛、窗这类设计师填的常量）
 *   2. 性质挡死（physical.blocksSight）
 *   3. 按身高：达到眼高就挡死，否则按 高度÷眼高 折算
 */
export function objectSightCost(o: MapObject, eye: number): number {
  const explicit = (o as MapObject & { sightCost?: number }).sightCost;
  if (typeof explicit === 'number') return explicit;
  if (o.physical?.blocksSight) return FULL_BLOCK;
  // 只有状态挡视线、且当前状态不在挡视线名单里 → 不挡
  const stateBlocks = o.blocksWhen ? o.blocksWhen.includes(o.state) : true;
  if (!stateBlocks) return 0;
  if (o.height >= eye) return FULL_BLOCK;
  const h = Math.max(o.height, 0);
  return Math.min(1, h / eye) * BASE_CELL_COST * 10;
}

/** 沿视线累加，含目标格；超过预算就看不见。 */
export function canSee(cost: Float32Array, width: number, x0: number, y0: number, x1: number, y1: number, budget = VISION_BUDGET): boolean {
  const line = cellLine(x0, y0, x1, y1);
  let sum = 0;
  for (let i = 1; i < line.length; i++) {
    const [px, py] = line[i - 1], [x, y] = line[i];
    // 斜穿墙角：两侧都挡死就过不去
    if (px !== x && py !== y && cost[py * width + x] >= FULL_BLOCK && cost[y * width + px] >= FULL_BLOCK) return false;
    sum += cost[y * width + x];
    if (sum > budget) return false;
  }
  return true;
}

const FACING_VEC: Record<Facing, [number, number]> = { 北: [0, -1], 东: [1, 0], 南: [0, 1], 西: [-1, 0] };

/** 目标格在不在锥形里。同格永远算。 */
export function inCone(facing: Facing, x0: number, y0: number, x1: number, y1: number, coneDeg: number): boolean {
  if (x0 === x1 && y0 === y1) return true;
  const [fx, fy] = FACING_VEC[facing];
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const cos = (fx * dx + fy * dy) / len;
  return cos >= Math.cos((coneDeg / 2) * Math.PI / 180);
}

export interface Viewer extends Body {
  x: number;
  y: number;
  facing?: Facing;   // 不填＝全向（老行为）
}

/** 一个观察者看得见哪些格。返回 Uint8Array（1 = 看得见）。 */
export function visionOf(world: World, map: GameMap, viewer: Viewer): Uint8Array {
  const eye = eyeHeight(viewer);
  const cost = cellSightCost(world, map, eye);
  const cone = viewer.facing ? coneFor(map, viewer.x, viewer.y) : 360;
  const vis = new Uint8Array(map.width * map.height);
  const maxCells = Math.ceil(VISION_BUDGET / BASE_CELL_COST); // 15
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
    if (gridDist(x - viewer.x, y - viewer.y) > maxCells) continue;
    if (viewer.facing && !inCone(viewer.facing, viewer.x, viewer.y, x, y, cone)) continue;
    if (canSee(cost, map.width, viewer.x, viewer.y, x, y)) vis[y * map.width + x] = 1;
  }
  return vis;
}

/** 队伍视野：各人取并集。 */
export function partyVisionOf(world: World, map: GameMap, viewers: Viewer[]): Uint8Array {
  const out = new Uint8Array(map.width * map.height);
  for (const v of viewers) {
    const one = visionOf(world, map, v);
    for (let i = 0; i < out.length; i++) if (one[i]) out[i] = 1;
  }
  return out;
}

/** 把 Token 转成观察者。朝向与姿态是可选字段，没写就是全向站立。 */
export function viewerOf(t: Token & { facing?: Facing; stance?: Stance }, body: Body = {}): Viewer {
  return { x: t.x, y: t.y, facing: t.facing, stance: t.stance ?? body.stance, sex: body.sex, heightCm: body.heightCm };
}
