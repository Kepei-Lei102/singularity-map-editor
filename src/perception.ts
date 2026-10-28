import { architectureBlocksSight, architectureGeometry, isArchitectureObject, segmentHitsRect, tokenPosition, isSubdivided, subKey } from './architecture';
import { produce } from 'immer';
import type { GameMap, MapObject, VisionLayer, World } from './types';
import { cloneLayer, emptyVision, mergeLayers, visionKey } from './vision';
import { cellLine, gridDist } from './util';

// 视野。尺度：1 格 = 0.75 米。
//
// 看见：从玩家角色往外画视线，不设半径。路上经过的格子按地形的视野衰减系数累加（空地不算），
//       累计 ≥ 1 就看不见了：墙 99 直接挡住，草丛 2 一格就挡住，窗 0.5 能透过一层。
//       比人高的物件（≥ EYE 米）也挡视线。目标格本身总是看得见（看得见墙面、草丛本身）。
// 看清：按圆形距离 ⌊√(dx²+dy²)⌋ 分档：1 格触手可及 / 5 格一步之遥 / 15 格屋子那头。

export const CELL_METERS = 0.75;
/**
 * 一回合折算多少分钟。奇点之后的时间和现实时间绑定：自由行动以分钟计，战斗以回合计，
 * 两者按 1 回合 = 5 分钟换算（多场跑团实测的平均值；例：晕厥 15 分钟 = 3 回合）。全局锁定。
 */
export const ROUND_MINUTES = 5;
export const EYE = 1.8;
/** 这么高以上的物件挡路（0.5 米：矮凳能跨过去，桌子不行）。 */
export const BLOCK_HEIGHT = 0.5;

/**
 * 这个物件现在挡不挡路。写了 blocksWhen 的（隔断、门、可开合的墙）只看状态：
 * 列出的状态挡，其余状态可以穿过，和高度无关；没写的旧物件仍按高度算。
 */
export function blocksMovement(o: MapObject) {
  return !isArchitectureObject(o) && (o.physical?.blocksMove ?? (o.blocksWhen ? o.blocksWhen.includes(o.state) : o.height >= BLOCK_HEIGHT));
}

export const CLEAR_BANDS = [
  { d: 1, label: '触手可及' },
  { d: 5, label: '一步之遥' },
  { d: 15, label: '屋子那头' },
];

/** 每一格挡视线的程度。 */
export function sightCosts(world: World, map: GameMap) {
  const coef = new Map(world.terrains.map((t) => [t.id, t.visionCoef]));
  const cost = new Float32Array(map.width * map.height);
  for (let i = 0; i < cost.length; i++) {
    const c = coef.get(map.cells[i]) ?? 0;
    cost[i] = c > 0.1 ? c : 0;
  }
  for (const o of map.objects) {
    if (o.kind !== 'object' || isArchitectureObject(o)) continue;
    const blocksSight = o.physical?.blocksSight ?? (o.blocksWhen ? o.blocksWhen.includes(o.state) : o.height >= EYE);
    if (!blocksSight) continue;
    for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++)
      if (x >= 0 && y >= 0 && x < map.width && y < map.height) cost[y * map.width + x] = 99;
  }
  return cost;
}

/**
 * 视线：沿 Bresenham 线累加路上格子的衰减（起点和目标格不算）。
 * 斜着跨一步时，如果两侧的两格都挡视线（两堵墙在拐角处碰在一起），视线过不去——墙角没有缝。
 */
export function canSee(cost: Float32Array, width: number, x0: number, y0: number, x1: number, y1: number) {
  const line = cellLine(x0, y0, x1, y1);
  let sum = 0;
  for (let i = 1; i < line.length; i++) {
    const [px, py] = line[i - 1], [x, y] = line[i];
    if (px !== x && py !== y && cost[py * width + x] >= 1 && cost[y * width + px] >= 1) return false;
    if (i === line.length - 1) break;
    sum += cost[y * width + x];
    if (sum >= 1) return false;
  }
  return true;
}

/** 旧地形保持主格衰减，薄墙用连续几何遮挡。目标采用主格坐标的真实中心。 */
export function seesPoint(cost: Float32Array, map: GameMap, eye: { x: number; y: number; subcell?: { x: number; y: number } }, target: { x: number; y: number }, geometry?: ReturnType<typeof architectureGeometry>) {
  const p = tokenPosition(eye);
  return canSee(cost, map.width, Math.floor(p.x), Math.floor(p.y), Math.floor(target.x), Math.floor(target.y)) && !(geometry ? geometry.some(r => r.blocksSight && segmentHitsRect(p, target, r)) : architectureBlocksSight(map, p, target));
}
function sightToObject(cost: Float32Array, map: GameMap, t: { x: number; y: number; subcell?: { x: number; y: number } }, o: MapObject) {
  const p = tokenPosition(t);
  let best = { d: Infinity, los: false };
  if (isArchitectureObject(o)) {
    const geometry = architectureGeometry(map, true), others = geometry.filter(r => r.objectId !== o.id && r.blocksSight);
    for (const r of geometry.filter(r => r.objectId === o.id)) {
      const target = { x: Math.max(r.x, Math.min(r.x + r.w, p.x)), y: Math.max(r.y, Math.min(r.y + r.h, p.y)) };
      const d = gridDist(target.x - p.x, target.y - p.y), los = seesPoint(cost, map, t, target, others);
      if ((los && !best.los) || los === best.los && d < best.d) best = { d, los };
    }
    return best;
  }
  for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) {
    const fine = isSubdivided(map, x, y), n = fine ? 3 : 1;
    for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) {
      const target = { x: x + (sx + 0.5) / n, y: y + (sy + 0.5) / n };
      const d = gridDist(target.x - p.x, target.y - p.y), los = seesPoint(cost, map, t, target);
      if ((los && !best.los) || los === best.los && d < best.d) best = { d, los };
    }
  }
  return best;
}
export function detailedVision(world: World, map: GameMap, eyes: { x: number; y: number; subcell?: { x: number; y: number } }[]) {
  const vis = new Uint8Array(map.width * map.height), sub: Record<number, number> = {};
  const cost = sightCosts(world, map), geometry = architectureGeometry(map);
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
    const n = isSubdivided(map, x, y) ? 3 : 1;
    for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) {
      const target = { x: x + (sx + 0.5) / n, y: y + (sy + 0.5) / n };
      const visible = eyes.some(t => seesPoint(cost, map, t, target, geometry)) ? 1 : 0;
      if (visible) vis[y * map.width + x] = 1;
      if (n === 3) sub[subKey(map, x * 3 + sx, y * 3 + sy)] = visible;
    }
  }
  return { vis, sub };
}
export function visionFrom(world: World, map: GameMap, eyes: { x: number; y: number }[]) { return detailedVision(world, map, eyes).vis; }

/** 全队能看见的格子。 */
export const partyVision = (world: World, map: GameMap) => visionFrom(world, map, map.tokens.filter((t) => t.pcId));

const step = (f: number, seeing: number) => (seeing ? 1 : f === 1 ? 2 : f);

/**
 * 自动迷雾：在每次修改世界后执行。只有棋子、地形、物件（或视野模式）变了才重算。
 * 全队共享：全队一份，看得见 → 1，原来看得见、现在看不见 → 2（记忆）。
 * 各自独立：每个玩家角色一份（map.views），只算他自己的眼睛；地图上那份是所有人的并集，给主持人看。
 */
export function withVision(next: World, prev: World): World {
  return produce(next, d => {
    const membershipChanged = next.party !== prev.party || next.visionGroups !== prev.visionGroups || next.visionMode !== prev.visionMode;
    for (const m of d.maps) {
      const src = next.maps.find(x => x.id === m.id)!;
      const before = prev.maps.find(x => x.id === m.id);
      const dirty = membershipChanged || !before || !before.autoFog || before.cells !== src.cells || before.objects !== src.objects || before.tokens !== src.tokens || before.architecture !== src.architecture || before.subdivisions !== src.subdivisions || next.terrains !== prev.terrains;
      const ids = new Set(d.party.map(p => p.id));
      for (const id of Object.keys(m.views)) if (!ids.has(id)) delete m.views[id];
      for (const p of d.party) m.views[p.id] ??= emptyVision(m.width * m.height);
      const apply = (L: VisionLayer, members: Set<string>) => {
        const { vis, sub } = detailedVision(next, src, src.tokens.filter(t => t.pcId && members.has(t.pcId)));
        L.fog = L.fog.map((f, i) => step(f, vis[i]));
        const old = L.subFog ?? {};
        L.subFog = Object.fromEntries(Object.entries(sub).map(([k, v]) => [k, step(old[+k] ?? 0, v)]));
      };
      if (prev.visionMode === 'shared' && next.visionMode !== 'shared' && before)
        for (const p of d.party) m.views[p.id] = cloneLayer(before);
      if (next.visionMode === 'shared') {
        if (prev.visionMode !== 'shared') Object.assign(m, mergeLayers(src, d.party.map(p => m.views[p.id])));
        if (m.autoFog && dirty) apply(m, ids);
        for (const p of d.party) m.views[p.id] = cloneLayer(m);
      } else {
        const groups = new Map<string, string[]>();
        for (const p of d.party) { const key = visionKey(next, p.id); groups.set(key, [...groups.get(key) ?? [], p.id]); }
        for (const members of groups.values()) {
          const L = members.length === 1 ? cloneLayer(m.views[members[0]]) : mergeLayers(src, members.map(id => m.views[id]));
          if (m.autoFog && dirty) apply(L, new Set(members));
          for (const id of members) m.views[id] = cloneLayer(L);
        }
        Object.assign(m, mergeLayers(src, d.party.map(p => m.views[p.id])));
      }
    }
  });
}

export interface Nearest { tokenId: string; name: string; d: number; los: boolean }

/** 离物件最近的玩家角色（优先看得见的）。 */
export function nearestPc(world: World, map: GameMap, o: MapObject): Nearest | null {
  const cost = sightCosts(world, map);
  let best: Nearest | null = null;
  for (const t of map.tokens) {
    if (!t.pcId) continue;
    const { d, los } = sightToObject(cost, map, t, o);
    const better = !best || (los && !best.los) || (los === best.los && d < best.d);
    if (better) best = { tokenId: t.id, name: t.name, d, los };
  }
  return best;
}

/** 有没有哪个玩家角色在 range 以内、且看得见。 */
export function pcWithin(world: World, map: GameMap, o: MapObject, range: number) {
  const cost = sightCosts(world, map);
  return map.tokens.find((t) => {
    if (!t.pcId) return false;
    const result = sightToObject(cost, map, t, o);
    return result.los && result.d <= range;
  });
}

// ---------- 听得见：至少能大声说话交流 ----------

export const HEAR_RANGE = 10; // 格（7.5 米）：大声说话还能听清

/** 两个人能不能大声说话交流：距离在 HEAR_RANGE 以内，而且中间没隔着墙（门、家具不挡声音）。 */
export function canHear(world: World, map: GameMap, a: { x: number; y: number }, b: { x: number; y: number }) {
  const ap = tokenPosition(a), bp = tokenPosition(b);
  if (gridDist(ap.x - bp.x, ap.y - bp.y) > HEAR_RANGE || architectureBlocksSight(map, ap, bp)) return false;
  const walls = new Set(world.terrains.filter((t) => t.blocksMove && t.visionCoef >= 99).map((t) => t.id));
  const line = cellLine(a.x, a.y, b.x, b.y);
  const wall = (x: number, y: number) => walls.has(map.cells[y * map.width + x]);
  for (let i = 1; i < line.length; i++) {
    const [px, py] = line[i - 1], [x, y] = line[i];
    if (px !== x && py !== y && wall(x, py) && wall(px, y)) return false; // 墙角碰在一起，声音也过不去
    if (i < line.length - 1 && wall(x, y)) return false;
  }
  return true;
}

/** 这个视角（pcId）此刻看得到的标记：自己的，加上此刻能和他大声说话交流的人的（canHear）。 */
export function visibleMarks(w: World, mapId: string, viewer: string | null) {
  const m = w.maps.find((x) => x.id === mapId);
  if (!m) return [];
  const now = Date.now();
  const live = w.marks.filter((k) => k.mapId === mapId && now - k.createdAt < k.life * 60000);
  if (!viewer) return live; // 主持人全看得到
  const me = m.tokens.find((t) => t.pcId === viewer);
  return live.filter((k) => {
    if (k.author === viewer) return true;
    if (k.audience) return k.audience.includes(viewer); // 玩家窗口：主持人那边按完整地形算好了，不要用删过的地形重算
    const other = m.tokens.find((t) => t.pcId === k.author);
    return !!me && !!other && canHear(w, m, me, other);
  });
}

