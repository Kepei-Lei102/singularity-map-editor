// 视线：按《规则书》【视野衰减系数】【视野难度的核心是每格衰减系数】实现。
//
// 和 perception.ts 的老算法的区别只有三处：
//   1. 每格基线不是 0 而是 0.1（无障碍也是 0.1），所以预算 1.56 ÷ 0.1 = 15.6 → 15 格。
//   2. 预算从 "≥1 就断" 改成 "≤1.56"。1.5 够，1.6 不够。
//   3. 累加包含目标格本身（老算法把目标格排除在外，会多算一格）。
//
// 视野锥：按格子所在区域取。D20 区 120°，D100 区 60°（恐怖区）。30° 暂不做。

import type { Facing, GameMap, MapObject, Point, Sex, Stance, Token, World } from '../core/types';
export type { Facing, Sex, Stance } from '../core/types';
import { objectEnabled } from '../core/objectData.js';
import { architectureGeometry, isArchitectureObject, segmentHitsRect } from './architecture';
import { SUB, subKey, terrainAtSubcell } from './terrain';
import { cellLine, gridDist } from '../core/util';

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
  subcell?: Point;   // 绝对子格索引；和 Token.subcell 同一套
  facing?: Facing;   // 不填＝全向（老行为）
}

/** 观察者的实际眼睛位置。x/y 是所属主格；有 subcell 时用子格中心。 */
export function eyePoint(v: Viewer): Point {
  return v.subcell ? { x: (v.subcell.x + 0.5) / SUB, y: (v.subcell.y + 0.5) / SUB } : { x: v.x + 0.5, y: v.y + 0.5 };
}

/**
 * 子格挡死表：1 = 这 1/3 小格是完全挡死的（地形 visionCoef ≥ 99）。
 * 只用于细化遮挡，不参与衰减；整格衰减仍按 cellSightCost。
 */
export function sightSubcellBlockers(world: World, map: GameMap): Uint8Array | null {
  if (!map.subdivisions?.length) return null;
  const w3 = map.width * SUB, h3 = map.height * SUB;
  const coef = new Map(world.terrains.map((t) => [t.id, t.visionCoef]));
  const out = new Uint8Array(w3 * h3);
  for (let y3 = 0; y3 < h3; y3++) for (let x3 = 0; x3 < w3; x3++) {
    const c = coef.get(terrainAtSubcell(map, x3, y3)) ?? 0;
    if (c >= FULL_BLOCK) out[y3 * w3 + x3] = 1;
  }
  return out;
}

/** 高精度线是否穿过挡死子格；起点和终点自身不算。 */
/** 从 from 点到 to 点，是否穿过挡死子格。地图没细分就是 false。 */
export function subcellSightBlocked(world: World, map: GameMap, from: Point, to: Point): boolean {
  const block = sightSubcellBlockers(world, map);
  if (!block) return false;
  const w3 = map.width * SUB, h3 = map.height * SUB;
  const sx = Math.max(0, Math.min(w3 - 1, Math.floor(from.x * SUB))), sy = Math.max(0, Math.min(h3 - 1, Math.floor(from.y * SUB)));
  const tx = Math.max(0, Math.min(w3 - 1, Math.floor(to.x * SUB))), ty = Math.max(0, Math.min(h3 - 1, Math.floor(to.y * SUB)));
  return subcellLineBlocked(block, w3, sx, sy, tx, ty);
}

function subcellLineBlocked(block: Uint8Array, width3: number, x0: number, y0: number, x1: number, y1: number) {
  const line = cellLine(x0, y0, x1, y1);
  for (let i = 1; i < line.length - 1; i++) {
    const [px, py] = line[i - 1], [x, y] = line[i];
    if (block[y * width3 + x]) return true;
    // 斜穿 1/3 格墙角：两侧都挡死就过不去
    if (px !== x && py !== y && block[py * width3 + x] && block[y * width3 + px]) return true;
  }
  return false;
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

/** 一个人看得见的细分格。粗格仍由 visionOf 决定；这里只细化“线穿过哪块 1/3”。 */
export function visionDetailOf(world: World, map: GameMap, viewer: Viewer): { vis: Uint8Array; sub: Record<number, number> } {
  const vis = visionOf(world, map, viewer);
  const sub: Record<number, number> = {};
  const block = sightSubcellBlockers(world, map);
  if (!block || !map.subdivisions?.length) return { vis, sub };
  const p = eyePoint(viewer);
  const w3 = map.width * SUB, h3 = map.height * SUB;
  const ex = Math.max(0, Math.min(w3 - 1, Math.floor(p.x * SUB))), ey = Math.max(0, Math.min(h3 - 1, Math.floor(p.y * SUB)));
  for (const idx of map.subdivisions) {
    const x = idx % map.width, y = Math.floor(idx / map.width);
    if (!vis[idx]) continue;
    for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
      const x3 = x * SUB + sx, y3 = y * SUB + sy;
      sub[subKey(map, x3, y3)] = subcellLineBlocked(block, w3, ex, ey, x3, y3) ? 0 : 1;
    }
  }
  return { vis, sub };
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

/** 队伍视野，细到 1/3 小格。 */
export function partyVisionDetailOf(world: World, map: GameMap, viewers: Viewer[]): { vis: Uint8Array; sub: Record<number, number> } {
  const vis = new Uint8Array(map.width * map.height), sub: Record<number, number> = {};
  for (const v of viewers) {
    const one = visionDetailOf(world, map, v);
    for (let i = 0; i < vis.length; i++) if (one.vis[i]) vis[i] = 1;
    for (const [k, val] of Object.entries(one.sub)) if (val) sub[+k] = 1;
  }
  return { vis, sub };
}

/**
 * 一个点能不能被这双眼睛看到。口径和规则书视野一致：
 * 主格衰减走 canSee（包含目标格），建筑薄墙走连续几何，子格挡死表只细化遮挡。
 * 用于开门、判定可见性、滑块、看清范围这类“点”判定，不走老的 sightCosts。
 */
export function visiblePoint(world: World, map: GameMap, eye: Viewer, target: Point, geometry?: ReturnType<typeof architectureGeometry>): boolean {
  const p = eyePoint(eye);
  if (p.x < 0 || p.y < 0 || p.x > map.width || p.y > map.height || target.x < 0 || target.y < 0 || target.x > map.width || target.y > map.height) return false;
  const x0 = Math.floor(p.x), y0 = Math.floor(p.y), x1 = Math.floor(target.x), y1 = Math.floor(target.y);
  const cost = cellSightCost(world, map, eyeHeight(eye));
  if (!canSee(cost, map.width, x0, y0, x1, y1)) return false;
  if (eye.facing && !inCone(eye.facing, p.x, p.y, target.x, target.y, coneFor(map, x0, y0))) return false;
  const g = geometry ?? architectureGeometry(map);
  if (g.some((r) => r.blocksSight && segmentHitsRect(p, target, r))) return false;
  if (subcellSightBlocked(world, map, p, target)) return false;
  return true;
}

/** 把 Token 转成观察者。朝向与姿态是可选字段，没写就是全向站立。 */
export function viewerOf(t: Token & { facing?: Facing; stance?: Stance }, body: Body = {}): Viewer {
  return { x: t.x, y: t.y, subcell: t.subcell, facing: t.facing, stance: t.stance ?? body.stance, sex: body.sex, heightCm: body.heightCm };
}
