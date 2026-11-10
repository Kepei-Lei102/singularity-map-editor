import { objectEnabled } from '../core/objectData.js';
import { architectureBlocksSight, architectureGeometry, isArchitectureObject, tokenPosition, isSubdivided } from './architecture';
import { produce } from 'immer';
import type { GameMap, MapObject, Token, VisionLayer, World } from '../core/types';
import { partyVisionDetailOf, visiblePoint, viewerOf, type Viewer } from './sight';
import { cloneLayer, emptyVision, mergeLayers, visionKey } from './vision';
import { cellLine, gridDist } from '../core/util';

// 视野。尺度：1 格 = 0.75 米。
//
// 看见：口径见 docs/视野统一-v0.1.md（规则书）——视野预算 1.56、每格基线 0.1，
//       路上经过的格子累加障碍系数，累计超过 1.56 就看不见；墙这类挡死几何再单独判一次。
//       物件没填系数时按高度折算，比眼高还高的直接挡死。目标格本身总是看得见。
// 看清：按圆形距离 ⌊√(dx²+dy²)⌋ 分档：1 格触手可及 / 5 格一步之遥 / 15 格屋子那头。

export const CELL_METERS = 0.75;
/**
 * 一回合折算多少分钟。奇点之后的时间和现实时间绑定：自由行动以分钟计，战斗以回合计，
 * 两者按 1 回合 = 5 分钟换算（多场跑团实测的平均值；例：晕厥 15 分钟 = 3 回合）。全局锁定。
 */
export const ROUND_MINUTES = 5;
/** 这么高以上的物件挡路（0.5 米：矮凳能跨过去，桌子不行）。 */
export const BLOCK_HEIGHT = 0.5;

/**
 * 这个物件现在挡不挡路。写了 blocksWhen 的（隔断、门、可开合的墙）只看状态：
 * 列出的状态挡，其余状态可以穿过，和高度无关；没写的旧物件仍按高度算。
 */
export function blocksMovement(o: MapObject) {
  return o.enabled !== false && !isArchitectureObject(o) && (o.physical?.blocksMove ?? (o.blocksWhen ? o.blocksWhen.includes(o.state) : o.height >= BLOCK_HEIGHT));
}

export const CLEAR_BANDS = [
  { d: 1, label: '触手可及' },
  { d: 5, label: '一步之遥' },
  { d: 15, label: '屋子那头' },
];

function sightToObject(world: World, map: GameMap, eye: Viewer, o: MapObject) {
  if (!objectEnabled(map, o)) return { d: Infinity, los: false };
  const p = tokenPosition(eye);
  let best = { d: Infinity, los: false };
  if (isArchitectureObject(o)) {
    const geometry = architectureGeometry(map, true), others = geometry.filter(r => r.objectId !== o.id && r.blocksSight);
    for (const r of geometry.filter(r => r.objectId === o.id)) {
      const target = { x: Math.max(r.x, Math.min(r.x + r.w, p.x)), y: Math.max(r.y, Math.min(r.y + r.h, p.y)) };
      const d = gridDist(target.x - p.x, target.y - p.y), los = visiblePoint(world, map, eye, target, others);
      if ((los && !best.los) || los === best.los && d < best.d) best = { d, los };
    }
    return best;
  }
  for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) {
    const fine = isSubdivided(map, x, y), n = fine ? 3 : 1;
    for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) {
      const target = { x: x + (sx + 0.5) / n, y: y + (sy + 0.5) / n };
      const d = gridDist(target.x - p.x, target.y - p.y), los = visiblePoint(world, map, eye, target);
      if ((los && !best.los) || los === best.los && d < best.d) best = { d, los };
    }
  }
  return best;
}
/**
 * 规则书视野。只有棋子才有朝向和姿态，所以这里收棋子列表而不是坐标。
 * 子格：主格衰减仍按整格；细分格再用 1/3 精度判断线穿过的挡死小块。
 */
export function detailedVisionRulebook(world: World, map: GameMap, tokens: Token[]): { vis: Uint8Array; sub: Record<number, number> } {
  const viewers = tokens.map((t) => {
    const pc = world.party.find((p) => p.id === t.pcId);
    return viewerOf(t, { sex: pc?.sex, heightCm: pc?.heightCm });
  });
  return partyVisionDetailOf(world, map, viewers);
}

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
        const mine = src.tokens.filter(t => t.pcId && members.has(t.pcId));
        const { vis, sub } = detailedVisionRulebook(next, src, mine);
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
  let best: Nearest | null = null;
  for (const t of map.tokens) {
    if (!t.pcId) continue;
    const pc = world.party.find((p) => p.id === t.pcId);
    const eye = viewerOf(t, { sex: pc?.sex, heightCm: pc?.heightCm });
    const { d, los } = sightToObject(world, map, eye, o);
    const better = !best || (los && !best.los) || (los === best.los && d < best.d);
    if (better) best = { tokenId: t.id, name: t.name, d, los };
  }
  return best;
}

/** 有没有哪个玩家角色在 range 以内、且看得见。 */
export function pcWithin(world: World, map: GameMap, o: MapObject, range: number) {
  return map.tokens.find((t) => {
    if (!t.pcId) return false;
    const pc = world.party.find((p) => p.id === t.pcId);
    const eye = viewerOf(t, { sex: pc?.sex, heightCm: pc?.heightCm });
    const result = sightToObject(world, map, eye, o);
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

