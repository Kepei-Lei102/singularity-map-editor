import { objectEnabled } from './objectData.js';
// Pure component helpers shared by the browser, schema and module scripts.
export const isArchitectureObject = o => !!(o.geometry || o.opening);
export const openingIsOpen = o => !!o.opening?.openStates.includes(o.state);
export const architectureWalls = m => [...(m.architecture?.walls ?? []), ...(m.objects ?? []).filter(o => o.geometry).map(o => ({ id: o.id, ...o.geometry }))];
export const architectureDoors = m => [...(m.architecture?.doors ?? []), ...(m.objects ?? []).filter(o => o.opening).map(o => ({ id: o.id, ...o.opening, open: openingIsOpen(o) }))];
export function architectureObjectBounds(m, o) {
  let a, b;
  if (o.geometry) ({ a, b } = o.geometry);
  else if (o.opening) {
    const w = architectureWalls(m).find(w => w.id === o.opening.wallId);
    if (!w) return { x: o.x, y: o.y, w: o.w, h: o.h };
    const dx = Math.sign(w.b.x - w.a.x), dy = Math.sign(w.b.y - w.a.y);
    a = { x: w.a.x + dx * o.opening.offset, y: w.a.y + dy * o.opening.offset };
    b = { x: a.x + dx * o.opening.width, y: a.y + dy * o.opening.width };
  } else return { x: o.x, y: o.y, w: o.w, h: o.h };
  const x = Math.min(m.width - 1, Math.floor(Math.min(a.x, b.x) / 3)), y = Math.min(m.height - 1, Math.floor(Math.min(a.y, b.y) / 3));
  return { x, y, w: Math.max(1, Math.ceil(Math.max(a.x, b.x) / 3) - x), h: Math.max(1, Math.ceil(Math.max(a.y, b.y) / 3) - y) };
}
export function normalizeArchitectureBounds(m) {
  for (const o of m.objects ?? []) if (isArchitectureObject(o)) Object.assign(o, architectureObjectBounds(m, o));
}
export function migrateArchitecture(m) {
  if (m.architecture) {
    const a = m.architecture;
    const ids = new Set((m.objects ?? []).map(o => o.id));
    for (const e of [...a.walls, ...a.doors]) { if (ids.has(e.id)) throw new Error(`建筑 ID 与物件冲突：${e.id}`); ids.add(e.id); }
    const base = (id, name) => ({ id, kind: 'object', name, x: 0, y: 0, w: 1, h: 1, height: 2.4, color: '#8b8175', icon: '', states: ['固定'], state: 0, notes: '', hidden: false, secrets: [], media: [] });
    for (const { id, ...wall } of a.walls) m.objects.push({ ...base(id, wall.material === 'glass' ? '玻璃墙' : '墙'), geometry: { kind: 'wall', ...wall } });
    for (const d of a.doors) m.objects.push({ ...base(d.id, '门'), states: ['关闭', '打开'], state: d.open ? 1 : 0, blocksWhen: [0], opening: { wallId: d.wallId, offset: d.offset, width: d.width, openStates: [1] } });
    delete m.architecture;
  }
  normalizeArchitectureBounds(m);
  for (const r of m.rooms ?? []) for (const s of [r.reset, ...(r.layouts ?? [])].filter(Boolean)) {
    for (const d of s.doors ?? []) {
      const o = m.objects.find(o => o.id === d.id && o.opening);
      if (!o) continue;
      const state = o.states.findIndex((_, i) => o.opening.openStates.includes(i) === d.open);
      if (state < 0) throw new Error(`门快照没有对应状态：${d.id}`);
      const old = s.objects.find(v => v.id === d.id);
      if (old) old.state = state; else s.objects.push({ id: o.id, x: o.x, y: o.y, state });
    }
    delete s.doors;
  }
  return m;
}
/** Preparation view omits retired wall layouts, including their open doorway outlines. */
export function visibleArchitectureGeometry(m) {
  const active = (o, fallback) => o?.physical?.blocksMove ?? (o?.blocksWhen ? o.blocksWhen.includes(o.state) : fallback);
  const shownWalls = new Set(architectureWalls(m).filter(w => {
    const o = m.objects?.find(o => o.id === w.id);
    return active(o, true) || (o?.physical?.blocksSight ?? (o?.blocksWhen ? o.blocksWhen.includes(o.state) : w.material !== 'glass'));
  }).map(w => w.id));
  const shownDoors = new Set(architectureDoors(m).filter(d => shownWalls.has(d.wallId)).map(d => d.id));
  return architectureGeometry(m, true).filter(r => shownWalls.has(r.objectId) || shownDoors.has(r.objectId));
}
/** Geometry in main-cell units. Physics flags are transient, never object metadata. */
export function architectureGeometry(m, includeOpen = false) {
  const out = [], doors = architectureDoors(m);
  for (const w of architectureWalls(m)) {
    const owner = m.objects?.find(o => o.id === w.id), length = Math.abs(w.b.x - w.a.x) + Math.abs(w.b.y - w.a.y), dx = Math.sign(w.b.x - w.a.x), dy = Math.sign(w.b.y - w.a.y), half = w.thickness / 1500;
    if (owner && !objectEnabled(m, owner)) continue;
    const add = (start, end, material, entity = owner) => {
      if (end <= start) return;
      const capA = start === 0 ? half : 0, capB = end === length ? half : 0;
      const ax = (w.a.x + dx * start) / 3, ay = (w.a.y + dy * start) / 3, bx = (w.a.x + dx * end) / 3, by = (w.a.y + dy * end) / 3;
      const rect = dx ? { x: Math.min(ax, bx) - (dx > 0 ? capA : capB), y: ay - half, w: (end - start) / 3 + capA + capB, h: half * 2 }
        : { x: ax - half, y: Math.min(ay, by) - (dy > 0 ? capA : capB), w: half * 2, h: (end - start) / 3 + capA + capB };
      out.push({ ...rect, material, objectId: entity?.id ?? w.id, hidden: !!entity?.hidden, blocksMove: material !== 'opening' && (entity?.physical?.blocksMove ?? (entity?.opening ? true : entity?.blocksWhen ? entity.blocksWhen.includes(entity.state) : true)), blocksSight: material !== 'opening' && (entity?.physical?.blocksSight ?? (entity?.opening ? true : entity?.blocksWhen ? entity.blocksWhen.includes(entity.state) : material !== 'glass')) });
    };
    let from = 0;
    for (const d of doors.filter(d => d.wallId === w.id).sort((a, b) => a.offset - b.offset)) {
      add(from, d.offset, w.material);
      if ((!d.open || includeOpen) && objectEnabled(m, m.objects?.find(o => o.id === d.id) ?? { enabled: true })) add(d.offset, d.offset + d.width, d.open ? 'opening' : 'door', m.objects?.find(o => o.id === d.id));
      from = d.offset + d.width;
    }
    add(from, length, w.material);
  }
  return out;
}
