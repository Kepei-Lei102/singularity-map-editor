import type { Draft } from 'immer';
import type { GameMap, MapObject, SeenObject, VisionLayer, World } from './types';
import { linesToFlow } from './flow';

// 星际争霸式迷雾：fog 0 没去过 / 1 看得见 / 2 记忆。
// 规则只有一条：看得见的地方，记忆 = 现实；看不见的地方，记忆停在上一次看见时。

type Rect = { x: number; y: number; w: number; h: number };

export function anyVisible(m: { width: number; height: number; fog: number[] }, r: Rect) {
  for (let y = Math.max(0, r.y); y < Math.min(m.height, r.y + r.h); y++)
    for (let x = Math.max(0, r.x); x < Math.min(m.width, r.x + r.w); x++)
      if (m.fog[y * m.width + x] === 1) return true;
  return false;
}

export const emptyLayer = (n: number): VisionLayer => ({ fog: new Array(n).fill(0), seen: { cells: new Array(n).fill(''), objects: [] } });

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
function syncLayer(m: Draft<GameMap>, L: Draft<VisionLayer>) {
  const n = m.width * m.height;
  for (let i = 0; i < n; i++) if (L.fog[i] === 1 && L.seen.cells[i] !== m.cells[i]) L.seen.cells[i] = m.cells[i];
  const box = { width: m.width, height: m.height, fog: L.fog };
  const live = m.objects.filter((o) => o.kind === 'object' && !o.hidden && anyVisible(box, o));
  const liveIds = new Set(live.map((o) => o.id));
  // 记忆里的东西，原地方现在看得见了、但它已经不在那（被搬走/删掉/藏起来）→ 忘掉
  const kept = L.seen.objects.filter((r) => liveIds.has(r.id) || !anyVisible(box, r));
  if (kept.length !== L.seen.objects.length) L.seen.objects = kept;
  for (const o of live) {
    const snap = snapshot(o);
    const i = L.seen.objects.findIndex((r) => r.id === o.id);
    if (i < 0) L.seen.objects.push(snap);
    else if (!sameSeen(L.seen.objects[i], snap)) L.seen.objects[i] = snap;
  }
}

/** 每次修改世界后执行：全队那份和每个人自己那份，都把"看得见"的部分同步进记忆。 */
export function syncMemory(d: Draft<World>) {
  for (const m of d.maps) {
    if (!m.seen) m.seen = { cells: new Array(m.width * m.height).fill(''), objects: [] };
    syncLayer(m, m);
    for (const L of Object.values(m.views ?? {})) syncLayer(m, L);
  }
}

/** 旧存档（只有 0/1 迷雾）补上记忆字段。 */
export function migrateWorld(w: World): World {
  for (const m of w.maps) {
    if (!m.seen) m.seen = { cells: m.cells.map((c, i) => (m.fog[i] === 1 ? c : '')), objects: [] };
    m.autoFog ??= true;
    m.rooms ??= [];
    m.roomCells ??= new Array(m.width * m.height).fill('');
    m.views ??= {};
    m.spawn ??= null;
    for (const o of m.objects) for (const s of o.secrets) { s.kind ??= 'roll'; s.range ??= 1; }
  }
  w.visionMode ??= 'shared';
  w.marks ??= [];
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
