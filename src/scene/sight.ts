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
import { SUB, terrainAtPoint } from './terrain';
import { dominantId, fineKey, hasFineDetail } from '../core/grid';
import { cellLine, gridDist } from '../core/util';

/** 视野预算。规则书：无障碍 15 格 = 1.5，＜1.56，所以第 16 格看不见。 */
export const VISION_BUDGET = 1.56;
/** 每格最低消耗（无障碍）。 */
export const BASE_CELL_COST = 0.1;
/** 完全挡住：够高或者性质挡死。 */
export const FULL_BLOCK = 99;
/** 视野半径（主格）：预算 ÷ 每格最低消耗，向上取整。脏区圆盘用它，别自己写 15。 */
export const VISION_RADIUS_CELLS = Math.ceil(VISION_BUDGET / BASE_CELL_COST);

/** 眼高占身高的比例。 */
export const EYE_RATIO = 0.93;
/** 站姿眼高默认（厘米）：男 173、女 164，性别不明按 170。 */
export const DEFAULT_HEIGHT_CM = { 男: 173, 女: 164, 其他: 170 } as const;
/** 蹲下／趴下是锁死高度，不按身高算。 */
// 坐和蹲的眼高差不多，暂时共用一个值；躺下就是趴。
export const STANCE_EYE = { 坐: 0.9, 蹲: 0.9, 躺: 0.3, 趴: 0.3 } as const;


export interface Body {
  sex?: Sex;
  heightCm?: number;
  stance?: Stance;
}

/** 眼高（米）。站姿按身高 × 0.93；蹲／趴用锁死值。 */
export function eyeHeight(body: Body = {}): number {
  const stance = body.stance ?? '站';
  if (stance === '坐') return STANCE_EYE.坐;
  if (stance === '蹲') return STANCE_EYE.蹲;
  if (stance === '躺') return STANCE_EYE.躺;
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
  const terrainById = new Map(world.terrains.map((t) => [t.id, t]));
  const cost = new Float32Array(map.width * map.height);
  for (let i = 0; i < cost.length; i++) {
    const base = map.cells[i] ?? '';
    // 空白/未登记地形既是墙（走不过去），也挡视线；地图边界不再能看穿。
    const baseTerrain = terrainById.get(base);
    let c = baseTerrain ? coef.get(base) ?? BASE_CELL_COST : FULL_BLOCK;
    // 有小格细节时，整格衰减只在“非完全挡死”的小格里取多数派：
    // - base 是墙、9 格全 floor / window → 降回 floor / window 的系数；
    // - base 是草地、8 草 1 floor → 仍是草地的 2，不会因一个 floor 小格变 0.1；
    // - base floor + 5/9 小墙、射线穿 floor → floor 的 0.1，墙由 blockers 精确挡。
    // 完全挡死的小格（visionCoef ≥ FULL_BLOCK）不参与整格系数，交给
    // sightSubcellBlockers 按 1/3 判；全是挡死小格时才把整格按挡死算。
    const cx = i % map.width, cy = Math.floor(i / map.width);
    if (hasFineDetail(map, cx, cy)) {
      const visible: string[] = [];
      let known = 0;
      for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
        const id = map.fineCells?.[fineKey(map.width, cx * SUB + sx, cy * SUB + sy)] ?? base;
        const t = terrainById.get(id);
        if (!t) continue;
        known++;
        if ((t.visionCoef ?? 0) < FULL_BLOCK) visible.push(id);
      }
      if (visible.length) {
        const rep = dominantId(visible);
        c = coef.get(rep) ?? BASE_CELL_COST;
      } else if (known === SUB * SUB || known === 0) {
        // 9 个小格都有地形且全是完全挡死，或 9 个小格全是空白/未登记：整格按挡死算。
        // 若只是“部分小格墙 + 其余空格”，整格仍用 base 系数，墙/空格交给精确遮挡。
        c = FULL_BLOCK;
      }
    }
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

/**
 * 建筑构件的视野系数。作者口径：
 * - 普通墙直接算 2
 * - 玻璃墙算 0.3（能透过，但看得没那么远）
 * - 开门算 0.1，就是无障碍基线，等于不挡
 */
export const WALL_SIGHT_COST = 2;
export const GLASS_SIGHT_COST = 0.3;

/** 单个建筑构件阻挡视线花多少预算。门洞／开着的门不额外加（格子自带的 0.1 基线已经算了）。 */
export function wallSightCostOf(r: { material?: string; blocksSight: boolean }): number {
  if (r.material === 'glass') return GLASS_SIGHT_COST;
  if (r.material === 'opening') return 0;
  return r.blocksSight ? WALL_SIGHT_COST : 0;
}

/** 沿视线逐格累加，含目标格。撞到墙角（两侧都挡死）返回 Infinity。 */
export function cellSightTotal(cost: Float32Array, width: number, x0: number, y0: number, x1: number, y1: number): number {
  const line = cellLine(x0, y0, x1, y1);
  let sum = 0;
  for (let i = 1; i < line.length; i++) {
    const [px, py] = line[i - 1], [x, y] = line[i];
    // 斜穿墙角：两侧都挡死就过不去
    if (px !== x && py !== y && cost[py * width + x] >= FULL_BLOCK && cost[y * width + px] >= FULL_BLOCK) return Infinity;
    sum += cost[y * width + x];
  }
  return sum;
}

/** 这条线穿过建筑构件要多花多少视野预算（墙 2、玻璃 0.3、门洞 0）。看着墙面本身不算被它挡。 */
export function wallSightSum(geometry: ReturnType<typeof architectureGeometry>, from: Point, to: Point): number {
  let sum = 0;
  for (const r of geometry) {
    const c = wallSightCostOf(r);
    if (c <= 0) continue;
    const inside = to.x >= r.x && to.x <= r.x + r.w && to.y >= r.y && to.y <= r.y + r.h;
    if (inside) continue;
    if (segmentHitsRect(from, to, r)) sum += c;
  }
  return sum;
}

/** 分桶边长（格）。100×80 是 13×10 个桶，一条 15 格的视线最多碰到 3×3 个桶。 */
export const WALL_BUCKET_CELLS = 8;

/** 墙段索引：每个桶记下和它相交的构件下标。 */
export interface WallIndex {
  cell: number;
  cols: number;
  rows: number;
  buckets: number[][];
  geometry: ReturnType<typeof architectureGeometry>;
  /** 查询时给扫过的构件打标记，同一个构件跨多个桶只累加一次。 */
  stamp: Int32Array;
  tick: number;
}

export function buildWallIndex(map: GameMap, geometry: ReturnType<typeof architectureGeometry>): WallIndex {
  const cell = WALL_BUCKET_CELLS;
  const cols = Math.max(1, Math.ceil(map.width / cell));
  const rows = Math.max(1, Math.ceil(map.height / cell));
  const buckets: number[][] = Array.from({ length: cols * rows }, () => []);
  for (let i = 0; i < geometry.length; i++) {
    const r = geometry[i];
    const x0 = Math.max(0, Math.floor(r.x / cell)), x1 = Math.min(cols - 1, Math.floor((r.x + r.w) / cell));
    const y0 = Math.max(0, Math.floor(r.y / cell)), y1 = Math.min(rows - 1, Math.floor((r.y + r.h) / cell));
    for (let by = y0; by <= y1; by++) for (let bx = x0; bx <= x1; bx++) buckets[by * cols + bx].push(i);
  }
  return { cell, cols, rows, buckets, geometry, stamp: new Int32Array(geometry.length), tick: 0 };
}

/**
 * 和 `wallSightSum` 逐项等价：只测线段 bbox 覆盖到的桶里的构件。
 * 桶按构件 bbox 登记，所以「线段与构件相交」必然意味着两者 bbox 相交、必然落在同一个桶里。
 */
export function wallSightSumIndexed(idx: WallIndex, from: Point, to: Point): number {
  const { cell, cols, rows, geometry } = idx;
  const x0 = Math.max(0, Math.floor(Math.min(from.x, to.x) / cell));
  const x1 = Math.min(cols - 1, Math.floor(Math.max(from.x, to.x) / cell));
  const y0 = Math.max(0, Math.floor(Math.min(from.y, to.y) / cell));
  const y1 = Math.min(rows - 1, Math.floor(Math.max(from.y, to.y) / cell));
  if (x0 > x1 || y0 > y1) return 0;
  if (idx.tick >= 0x7ffffffe) { idx.stamp.fill(0); idx.tick = 0; }
  const tick = ++idx.tick;
  let sum = 0;
  for (let by = y0; by <= y1; by++) for (let bx = x0; bx <= x1; bx++) {
    for (const i of idx.buckets[by * cols + bx]) {
      if (idx.stamp[i] === tick) continue;
      idx.stamp[i] = tick;
      const r = geometry[i];
      const c = wallSightCostOf(r);
      if (c <= 0) continue;
      const inside = to.x >= r.x && to.x <= r.x + r.w && to.y >= r.y && to.y <= r.y + r.h;
      if (inside) continue;
      if (segmentHitsRect(from, to, r)) sum += c;
    }
  }
  return sum;
}

/** 沿视线累加（逐格系数 + 穿过的墙按 2 记）；超过预算就看不见。 */
export function canSee(cost: Float32Array, width: number, x0: number, y0: number, x1: number, y1: number, budget = VISION_BUDGET): boolean {
  return cellSightTotal(cost, width, x0, y0, x1, y1) <= budget;
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
  // 只有存在小格细节的格子才需要挡死表；整格同地形时交给 cellSightCost。
  const w3 = map.width * SUB;
  const terrainById = new Map(world.terrains.map((t) => [t.id, t]));
  const out = new Uint8Array(w3 * map.height * SUB);
  let any = false;
  for (let cy = 0; cy < map.height; cy++) for (let cx = 0; cx < map.width; cx++) {
    if (!hasFineDetail(map, cx, cy)) continue;
    any = true;
    for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
      const id = map.fineCells?.[fineKey(map.width, cx * SUB + sx, cy * SUB + sy)] ?? map.cells[cy * map.width + cx] ?? '';
      const t = terrainById.get(id);
      // 空白/未登记的小格也是墙：以前只在 visionCoef ≥ 99 时挡，导致“走不过去但看得见”。
      if (!t || (t.visionCoef ?? 0) >= FULL_BLOCK) out[fineKey(map.width, cx * SUB + sx, cy * SUB + sy)] = 1;
    }
  }
  return any ? out : null;
}

/** 用现成的挡死表判一次；起点和终点自身不算。 */
function subcellBlockedWith(block: Uint8Array | null, width3: number, height3: number, from: Point, to: Point): boolean {
  if (!block) return false;
  const sx = Math.max(0, Math.min(width3 - 1, Math.floor(from.x * SUB))), sy = Math.max(0, Math.min(height3 - 1, Math.floor(from.y * SUB)));
  const tx = Math.max(0, Math.min(width3 - 1, Math.floor(to.x * SUB))), ty = Math.max(0, Math.min(height3 - 1, Math.floor(to.y * SUB)));
  return subcellLineBlocked(block, width3, sx, sy, tx, ty);
}

/** 从 from 点到 to 点，是否穿过挡死子格。地图没细分就是 false。 */
export function subcellSightBlocked(world: World, map: GameMap, from: Point, to: Point): boolean {
  return subcellBlockedWith(sightSubcellBlockers(world, map), map.width * SUB, map.height * SUB, from, to);
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

/**
 * 一个观察者看得见哪些格。返回 Uint8Array（1 = 看得见）。
 *
 * 三条遮挡都要算，缺一条墙就不挡视线了：
 *   1. 地形／物件的视野衰减系数（cellSightCost，含 0.1 基线）；
 *   2. 建筑薄墙、门的连续几何（architectureGeometry，门开着就有缝）；
 *   3. 细分格的挡死小块（visionCoef ≥ 99）。
 * 细分过的主格按 3×3 小格判，任意一小格看得见就整格可见。
 */
export function visionOf(world: World, map: GameMap, viewer: Viewer, ctx?: SightCtx): Uint8Array {
  const tables = (ctx ?? localSightCtx(world, map)).tablesFor(eyeHeight(viewer));
  return visionWithTables(map, viewer, tables);
}

/** 一次视野判定要用的表。建表是 O(格数 + 建筑段)，所以一批观察者应该共用。 */
export interface SightTables {
  cost: Float32Array;
  geometry: ReturnType<typeof architectureGeometry>;
  block: Uint8Array | null;
  /** 墙段按格分桶；没有索引时退回全扫（`wallSightSum`）。 */
  walls?: WallIndex;
}

/** 一批观察者共用的表：同眼高只建一次，和地图有关的只建一次。 */
export interface SightCtx { tablesFor(eye: number): SightTables }

export function buildSightTables(world: World, map: GameMap, eye: number): SightTables {
  const geometry = architectureGeometry(map);
  return {
    cost: cellSightCost(world, map, eye),
    geometry,
    block: sightSubcellBlockers(world, map),
    walls: buildWallIndex(map, geometry),
  };
}

/** 一次调用内自己管表（没有外部缓存时的兜底）；同眼高复用。 */
export function localSightCtx(world: World, map: GameMap): SightCtx {
  const byEye = new Map<number, SightTables>();
  return {
    tablesFor(eye: number): SightTables {
      let t = byEye.get(eye);
      if (!t) { t = buildSightTables(world, map, eye); byEye.set(eye, t); }
      return t;
    },
  };
}

/** 用现成的三张表算一个观察者看得见哪些格。 */
export function visionWithTables(
  map: GameMap, viewer: Viewer, tables: SightTables, cells?: Iterable<number>,
): Uint8Array {
  const { cost, geometry, block } = tables;
  const w3 = map.width * SUB, h3 = map.height * SUB;
  const cone = viewer.facing ? coneFor(map, viewer.x, viewer.y) : 360;
  const p = eyePoint(viewer);
  // 有分桶就走索引，没有就退回「逐段全扫」，两条路结果必须一样。
  const wallSum = tables.walls
    ? (to: Point) => wallSightSumIndexed(tables.walls!, p, to)
    : (to: Point) => wallSightSum(geometry, p, to);
  const vis = new Uint8Array(map.width * map.height);
  const maxCells = VISION_RADIUS_CELLS;
  const clear = (target: Point) => {
    const total = cellSightTotal(cost, map.width, Math.floor(p.x), Math.floor(p.y), Math.floor(target.x), Math.floor(target.y));
    if (total > VISION_BUDGET) return false;
    // 墙按系数 2 记：穿过一道就 2 > 1.56，等于挡住；开门的话几何里没有这块，不额外加。
    if (total + wallSum(target) > VISION_BUDGET) return false;
    return !subcellBlockedWith(block, w3, h3, p, target);
  };
  // 单个主格看得见吗；每个格子只依赖三张表和眼睛位置，所以可以只算指定格。
  const look = (x: number, y: number): boolean => {
    if (gridDist(x - viewer.x, y - viewer.y) > maxCells) return false;
    if (viewer.facing && !inCone(viewer.facing, viewer.x, viewer.y, x, y, cone)) return false;
    const n = hasFineDetail(map, x, y) ? SUB : 1;
    for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++)
      if (clear({ x: x + (sx + 0.5) / n, y: y + (sy + 0.5) / n })) return true;
    return false;
  };
  if (cells) {
    for (const i of cells) {
      const x = i % map.width, y = Math.floor(i / map.width);
      if (look(x, y)) vis[i] = 1;
    }
    return vis;
  }
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) if (look(x, y)) vis[y * map.width + x] = 1;
  return vis;
}

/** 队伍视野：各人取并集。 */
export function partyVisionOf(world: World, map: GameMap, viewers: Viewer[], ctx?: SightCtx, cells?: Iterable<number>): Uint8Array {
  const tables = ctx ?? localSightCtx(world, map);
  const out = new Uint8Array(map.width * map.height);
  const list = cells ? [...cells] : null;
  for (const v of viewers) {
    const one = visionWithTables(map, v, tables.tablesFor(eyeHeight(v)), list ?? undefined);
    if (list) { for (const i of list) if (one[i]) out[i] = 1; }
    else for (let i = 0; i < out.length; i++) if (one[i]) out[i] = 1;
  }
  return out;
}

/** 只算给定格集合（脏区）的队伍视野；网格外的格子保持 0。 */
export function partyVisionCells(world: World, map: GameMap, viewers: Viewer[], cells: Iterable<number>, ctx?: SightCtx): Uint8Array {
  return partyVisionOf(world, map, viewers, ctx, cells);
}


/**
 * 一次判定要用的两份表：每格衰减（跟眼睛高度有关）和子格挡死表（只跟地图有关）。
 * 建表是 O(格数)，所以别放在内层循环里——一个观察者建一次，反复用。
 */
export interface SightCache {
  cost: Float32Array;
  block: Uint8Array | null;
  /** 和 cost 同一批表里的几何与墙索引；点判定复用它，不再每次重扫全图建筑。 */
  geometry?: ReturnType<typeof architectureGeometry>;
  walls?: WallIndex;
}

export function sightCacheFor(world: World, map: GameMap, eye: Viewer, ctx?: SightCtx): SightCache {
  // 传了 ctx 就复用已经建好的表（交互判定里会被反复取，别再按人重建全图）。
  if (ctx) {
    const t = ctx.tablesFor(eyeHeight(eye));
    return { cost: t.cost, block: t.block, geometry: t.geometry, walls: t.walls };
  }
  return { cost: cellSightCost(world, map, eyeHeight(eye)), block: sightSubcellBlockers(world, map) };
}

/**
 * 一个点能不能被这双眼睛看到。口径和规则书视野一致：
 * 主格衰减走 canSee（包含目标格），建筑薄墙走连续几何，子格挡死表只细化遮挡。
 * 用于开门、判定可见性、滑块、看清范围这类“点”判定，不走老的 sightCosts。
 */
export function visiblePoint(
  world: World, map: GameMap, eye: Viewer, target: Point,
  geometry?: ReturnType<typeof architectureGeometry>,
  cache?: SightCache,
): boolean {
  const p = eyePoint(eye);
  // 用 >= 而不是 >：越界点以前会读到下一行第一格（甚至算出 NaN），现在一律不可见。
  if (p.x < 0 || p.y < 0 || p.x >= map.width || p.y >= map.height || target.x < 0 || target.y < 0 || target.x >= map.width || target.y >= map.height) return false;
  // 目标点本身落在空白/未登记子格上：它是墙，不是“看得见的墙”那种可观察点。
  if (!world.terrains.some((t) => t.id === terrainAtPoint(map, target.x, target.y))) return false;
  const x0 = Math.floor(p.x), y0 = Math.floor(p.y), x1 = Math.floor(target.x), y1 = Math.floor(target.y);
  const cost = cache ? cache.cost : cellSightCost(world, map, eyeHeight(eye));
  // 这条线只算一次：以前 canSee 算一遍、下面加墙又算一遍。
  const sum = cellSightTotal(cost, map.width, x0, y0, x1, y1);
  if (sum > VISION_BUDGET) return false;
  if (eye.facing && !inCone(eye.facing, p.x, p.y, target.x, target.y, coneFor(map, x0, y0))) return false;
  const g = geometry ?? cache?.geometry ?? architectureGeometry(map);
  // 调用方传了过滤后的 geometry（比如看某个建筑物件时要排除自己）时，
  // 不能用 cache 里那份全量墙索引，否则会把目标自己的别的墙也算进去。
  const useIndexed = !!cache?.walls && (!geometry || geometry === cache.geometry);
  const wallCost = useIndexed ? wallSightSumIndexed(cache.walls!, p, target) : wallSightSum(g, p, target);
  if (sum + wallCost > VISION_BUDGET) return false;
  const block = cache ? cache.block : sightSubcellBlockers(world, map);
  if (subcellBlockedWith(block, map.width * SUB, map.height * SUB, p, target)) return false;
  return true;
}

/** 把 Token 转成观察者。朝向与姿态是可选字段，没写就是全向站立。 */
export function viewerOf(t: Token & { facing?: Facing; stance?: Stance }, body: Body = {}): Viewer {
  return { x: t.x, y: t.y, subcell: t.subcell, facing: t.facing, stance: t.stance ?? body.stance, sex: body.sex, heightCm: body.heightCm };
}
