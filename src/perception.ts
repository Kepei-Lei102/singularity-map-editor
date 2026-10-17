import { produce } from 'immer';
import type { GameMap, MapObject, VisionLayer, World } from './types';
import { emptyLayer } from './memory';
import { cellLine, distToRect, gridDist } from './util';

// 视野。尺度：1 格 = 1.5 米。
//
// 看见：从玩家角色往外画视线，不设半径。路上经过的格子按地形的视野衰减系数累加（空地不算），
//       累计 ≥ 1 就看不见了：墙 99 直接挡住，草丛 2 一格就挡住，窗 0.5 能透过一层。
//       比人高的物件（≥ EYE 米）也挡视线。目标格本身总是看得见（看得见墙面、草丛本身）。
// 看清：按圆形距离 ⌊√(dx²+dy²)⌋ 分档：1 格触手可及 / 5 格一步之遥 / 15 格屋子那头。

export const CELL_METERS = 1.5;
/**
 * 一回合折算多少分钟。奇点之后的时间和现实时间绑定：自由行动以分钟计，战斗以回合计，
 * 两者按 1 回合 = 5 分钟换算（多场跑团实测的平均值；例：晕厥 15 分钟 = 3 回合）。全局锁定。
 */
export const ROUND_MINUTES = 5;
export const EYE = 1.8;
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
    if (o.kind !== 'object' || o.height < EYE) continue;
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

/** 某个角色看这个物件：物件上任何一格在视线里都算看得见；返回看得见的格子里最近的距离（都看不见就返回最近那格、los=false）。 */
function sightToObject(cost: Float32Array, width: number, t: { x: number; y: number }, o: MapObject) {
  let best: { d: number; los: boolean } | null = null;
  const cells: [number, number, number][] = [];
  for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) cells.push([gridDist(x - t.x, y - t.y), x, y]);
  cells.sort((a, b) => a[0] - b[0]);
  for (const [d, x, y] of cells) {
    if (canSee(cost, width, t.x, t.y, x, y)) return { d, los: true };
    best ??= { d, los: false };
  }
  return best ?? { ...distToRect(t.x, t.y, o), los: false };
}

/** 从这些棋子的眼睛看出去，能看见的格子（1 = 看得见）。 */
export function visionFrom(world: World, map: GameMap, eyes: { x: number; y: number }[]): Uint8Array {
  const vis = new Uint8Array(map.width * map.height);
  const ok = eyes.filter((t) => t.x >= 0 && t.y >= 0 && t.x < map.width && t.y < map.height);
  if (!ok.length) return vis;
  const cost = sightCosts(world, map);
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++)
      for (const t of ok) if (canSee(cost, map.width, t.x, t.y, x, y)) { vis[y * map.width + x] = 1; break; }
  return vis;
}

/** 全队能看见的格子。 */
export const partyVision = (world: World, map: GameMap) => visionFrom(world, map, map.tokens.filter((t) => t.pcId));

const step = (f: number, seeing: number) => (seeing ? 1 : f === 1 ? 2 : f);

/**
 * 自动迷雾：在每次修改世界后执行。只有棋子、地形、物件（或视野模式）变了才重算。
 * 全队共享：全队一份，看得见 → 1，原来看得见、现在看不见 → 2（记忆）。
 * 各自独立：每个玩家角色一份（map.views），只算他自己的眼睛；地图上那份是所有人的并集，给主持人看。
 */
export function withVision(next: World, prev: World): World {
  const changes: { i: number; fog: number[]; views?: Record<string, VisionLayer> }[] = [];
  next.maps.forEach((m, i) => {
    if (!m.autoFog) return;
    const p = prev.maps.find((x) => x.id === m.id);
    if (p && p.autoFog && p.cells === m.cells && p.objects === m.objects && p.tokens === m.tokens &&
      prev.terrains === next.terrains && prev.visionMode === next.visionMode) return;
    if (next.visionMode !== 'individual') {
      const vis = partyVision(next, m);
      let changed = false;
      const fog = m.fog.map((f, k) => { const nf = step(f, vis[k]); if (nf !== f) changed = true; return nf; });
      if (changed) changes.push({ i, fog });
      return;
    }
    const n = m.width * m.height;
    const views: Record<string, VisionLayer> = { ...m.views };
    let vchanged = false;
    // 按角色分组：同一个角色在这张图上有几个棋子（比如分身、附身），几双眼睛看到的合在一起
    const eyes = new Map<string, typeof m.tokens>();
    for (const t of m.tokens) if (t.pcId) eyes.set(t.pcId, [...(eyes.get(t.pcId) ?? []), t]);
    for (const [pc, ts] of eyes) {
      const vis = visionFrom(next, m, ts);
      const L = views[pc] ?? emptyLayer(n);
      let ch = !m.views[pc];
      const fog = L.fog.map((f, k) => { const nf = step(f, vis[k]); if (nf !== f) ch = true; return nf; });
      if (ch) { views[pc] = { ...L, fog }; vchanged = true; }
    }
    // 不在这张图上的人：之前看得见的都变成记忆
    for (const [pc, L] of Object.entries(m.views))
      if (!m.tokens.some((t) => t.pcId === pc) && L.fog.includes(1)) { views[pc] = { ...L, fog: L.fog.map((f) => (f === 1 ? 2 : f)) }; vchanged = true; }
    let changed = false;
    const all = Object.values(views);
    const fog = m.fog.map((f, k) => {
      const nf = all.some((L) => L.fog[k] === 1) ? 1 : all.some((L) => L.fog[k]) || f ? 2 : 0;
      if (nf !== f) changed = true;
      return nf;
    });
    if (changed || vchanged) changes.push({ i, fog, views });
  });
  if (!changes.length) return next;
  return produce(next, (d) => {
    changes.forEach(({ i, fog, views }) => { d.maps[i].fog = fog; if (views) d.maps[i].views = views; });
  });
}

export interface Nearest { tokenId: string; name: string; d: number; los: boolean }

/** 离物件最近的玩家角色（优先看得见的）。 */
export function nearestPc(world: World, map: GameMap, o: MapObject): Nearest | null {
  const cost = sightCosts(world, map);
  let best: Nearest | null = null;
  for (const t of map.tokens) {
    if (!t.pcId) continue;
    const { d, los } = sightToObject(cost, map.width, t, o);
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
    // 范围内的格子里有一格看得见就行（大件家具的另一头露在外面也算）
    for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++)
      if (gridDist(x - t.x, y - t.y) <= range && canSee(cost, map.width, t.x, t.y, x, y)) return true;
    return false;
  });
}

// ---------- 听得见：至少能大声说话交流 ----------

export const HEAR_RANGE = 10; // 格（15 米）：大声说话还能听清

/** 两个人能不能大声说话交流：距离在 HEAR_RANGE 以内，而且中间没隔着墙（门、家具不挡声音）。 */
export function canHear(world: World, map: GameMap, a: { x: number; y: number }, b: { x: number; y: number }) {
  if (gridDist(a.x - b.x, a.y - b.y) > HEAR_RANGE) return false;
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
    const other = m.tokens.find((t) => t.pcId === k.author);
    return !!me && !!other && canHear(w, m, me, other);
  });
}

