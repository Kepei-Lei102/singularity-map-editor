import { clipArchitecture, isArchitectureObject, migrateArchitecture } from './architecture';
import { repairWorld } from './schema.js';
import type { Draft } from 'immer';
import type { GameMap, MapObject, SeenObject, VisionLayer, World } from './types';
import { linesToFlow } from './flow';
import { cloneLayer, emptyVision, mergeLayers, pruneMemory, spatialFog, visionKey } from './vision';

// 星际争霸式迷雾：fog 0 没去过 / 1 看得见 / 2 记忆。
// 规则只有一条：看得见的地方，记忆 = 现实；看不见的地方，记忆停在上一次看见时。

type Rect = { x: number; y: number; w: number; h: number };

export function anyVisible(m: { width: number; height: number; fog: number[]; subdivisions?: number[]; subFog?: Record<number, number> }, r: Rect) {
  for (let y = Math.max(0, r.y); y < Math.min(m.height, r.y + r.h); y++)
    for (let x = Math.max(0, r.x); x < Math.min(m.width, r.x + r.w); x++) {
      if (!(m.subdivisions ?? []).includes(y * m.width + x)) { if (m.fog[y * m.width + x] === 1) return true; }
      else for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) if (m.subFog?.[(y * 3 + sy) * m.width * 3 + x * 3 + sx] === 1) return true;
    }
  return false;
}

export const emptyLayer = emptyVision;

export function snapshot(o: MapObject | Draft<MapObject>): SeenObject {
  return {
    id: o.id, name: o.name, icon: o.icon, color: o.color, x: o.x, y: o.y, w: o.w, h: o.h, height: o.height,
    stateLabel: o.states.length > 1 ? o.states[o.state] ?? '' : null,
  };
}

export function sameSeen(a: SeenObject, b: SeenObject) {
  return a.name === b.name && a.icon === b.icon && a.color === b.color && a.x === b.x && a.y === b.y &&
    a.w === b.w && a.h === b.h && a.height === b.height && a.stateLabel === b.stateLabel;
}

/** 把一份迷雾里"看得见"的部分同步进它的记忆。 */
function syncLayer(m: Draft<GameMap>, L: Draft<VisionLayer>, rev: number) {
  L.seen.cellRevs ??= Array(m.width * m.height).fill(0); L.seen.observed ??= {}; L.seen.objectRevs ??= {}; L.seen.subRevs ??= {}; L.seen.architectureRevs ??= {};
  for (let key = 0; key < m.width * m.height * 9; key++) if (spatialFog(m, L, key) === 1) { L.seen.observed[key] = rev; L.seen.subRevs[key] = rev; L.seen.architectureRevs[key] = rev; }
  const n = m.width * m.height;
  for (let i = 0; i < n; i++) if (L.fog[i] === 1) { L.seen.cells[i] = m.cells[i]; L.seen.cellRevs[i] = rev; }
  L.seen.subCells ??= {};
  for (const [key, f] of Object.entries(L.subFog ?? {})) if (f === 1) {
    const sx = +key % (m.width * 3), sy = Math.floor(+key / (m.width * 3));
    L.seen.subCells[+key] = m.cells[Math.floor(sy / 3) * m.width + Math.floor(sx / 3)];
  }
  const historical = clipArchitecture(m, L, 2, L.seen.architecture ?? []);
  L.seen.architecture = [...historical, ...clipArchitecture(m, L)];
  const box = { ...m, fog: L.fog, subFog: L.subFog };
  const live = m.objects.filter((o) => o.kind === 'object' && !isArchitectureObject(o) && !o.hidden && anyVisible(box, o));
  const liveIds = new Set(live.map((o) => o.id));
  // 记忆里的东西，原地方现在看得见了、但它已经不在那（被搬走/删掉/藏起来）→ 忘掉
  const kept = L.seen.objects.filter((r) => liveIds.has(r.id) || !anyVisible(box, r));
  if (kept.length !== L.seen.objects.length) L.seen.objects = kept;
  for (const o of live) {
    const snap = snapshot(o);
    L.seen.objectRevs[o.id] = rev;
    const i = L.seen.objects.findIndex((r) => r.id === o.id);
    if (i < 0) L.seen.objects.push(snap);
    else if (!sameSeen(L.seen.objects[i], snap)) L.seen.objects[i] = snap;
  }
}

/** 每次修改世界后执行：全队那份和每个人自己那份，都把"看得见"的部分同步进记忆。 */
export function syncMemory(d: Draft<World>) {
  const rev = d.observationSeq = (d.observationSeq ?? 0) + 1;
  for (const m of d.maps) {
    migrateArchitecture(m);
    if (d.visionMode === 'shared') {
      syncLayer(m, m, rev); pruneMemory(m, m);
      for (const p of d.party) m.views[p.id] = cloneLayer(m);
    } else {
      const done = new Set<string>();
      for (const p of d.party) {
        const key = visionKey(d, p.id); if (done.has(key)) continue; done.add(key);
        const L = m.views[p.id]; syncLayer(m, L, rev); pruneMemory(m, L);
        for (const peer of d.party.filter(x => visionKey(d, x.id) === key)) m.views[peer.id] = cloneLayer(L);
      }
      Object.assign(m, mergeLayers(m, d.party.map(p => m.views[p.id])));
    }
  }
}

/** 旧存档（只有 0/1 迷雾）补上记忆字段。 */
export function migrateWorld(w: World): World {
  for (const m of w.maps) {
    migrateArchitecture(m);
    if (!m.seen) m.seen = { cells: m.cells.map((c, i) => (m.fog[i] === 1 ? c : '')), objects: [] };
    m.autoFog ??= true;
    m.rooms ??= [];
    m.roomCells ??= new Array(m.width * m.height).fill('');
    m.views ??= {};
    m.spawn ??= null;
    // 新建筑旧记忆缺子格时不继承整格揭示；自动视野从真实眼睛重新计算。
    if (m.subdivisions?.length && !m.autoFog && !m.subFog) m.subFog = {};
    for (const o of m.objects) for (const s of o.secrets) { s.kind ??= 'roll'; s.range ??= 1; }
  }
  w.visionMode ??= 'shared';
  w.visionGroups ??= [];
  const groupIds = new Set(w.visionGroups.map(g => g.id));
  for (const p of w.party) if (p.visionGroupId && !groupIds.has(p.visionGroupId)) p.visionGroupId = null;
  for (const m of w.maps) for (const id of Object.keys(m.views)) if (!w.party.some(p => p.id === id)) delete m.views[id];
  w.marks ??= [];
  w.npcs ??= [];
  for (const n of w.npcs) { n.progress ??= { status: 'waiting', beatsDone: [] }; n.progress.beatsDone ??= []; }
  // Imported revisions are world-local; keep the next actual observation newer than
  // every persisted record, even in a hand-edited/older save missing its sequence.
  let maxRev = w.observationSeq ?? 0;
  for (const m of w.maps) for (const L of [m, ...Object.values(m.views)]) {
    for (const value of L.seen.cellRevs ?? []) maxRev = Math.max(maxRev, value ?? 0);
    for (const field of [L.seen.observed, L.seen.objectRevs, L.seen.subRevs, L.seen.architectureRevs])
      for (const value of Object.values(field ?? {})) maxRev = Math.max(maxRev, value);
  }
  w.observationSeq = maxRev;
  // Legacy private reveals used names; bind them once to stable IDs on load.
  for (const m of w.maps) for (const o of m.objects) for (const s of o.secrets)
    if (s.revealed?.scope === 'private' && !s.revealed.recipients)
      s.revealed.recipients = w.party.filter(p => p.name === s.revealed!.to).map(p => p.id);
  repairWorld(w); // 旧版输入框允许过的超范围数值夹回来
  delete (w as { clock?: number }).clock; // 旧版的世界时钟，已改成直接读真实时间
  if (!w.flows) w.flows = [linesToFlow(w.lines ?? [])];
  delete w.lines;
  return w;
}

/** 主持人用：玩家记得的样子和现在不一样的物件。 */
export function staleMemories(m: GameMap) {
  return m.seen.objects.filter((r) => {
    if (anyVisible(m, r)) return false;
    const o = m.objects.find((x) => x.id === r.id);
    return !o || o.hidden || !sameSeen(r, snapshot(o));
  });
}
