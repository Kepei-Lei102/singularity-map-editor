import { architectureGeometry, isArchitectureObject } from './architectureData.js';
export { architectureGeometry, architectureWalls, architectureDoors, architectureObjectBounds, isArchitectureObject, openingIsOpen, migrateArchitecture, normalizeArchitectureBounds } from './architectureData.js';
import type { ArchitectureFragment, GameMap, Point, Token, Wall, World } from './types';

export const tokenPosition = (t: { x: number; y: number; subcell?: Point }): Point => t.subcell
  ? { x: (t.subcell.x + 0.5) / 3, y: (t.subcell.y + 0.5) / 3 }
  : { x: t.x + 0.5, y: t.y + 0.5 };
export const isSubdivided = (m: GameMap, x: number, y: number) => (m.subdivisions ?? []).includes(Math.floor(y) * m.width + Math.floor(x));
export const subKey = (m: GameMap, x: number, y: number) => y * m.width * 3 + x;
export function fogAt(m: GameMap, L: { fog: number[]; subFog?: Record<number, number> }, x: number, y: number) {
  if (isSubdivided(m, x, y)) return L.subFog?.[subKey(m, Math.floor(x * 3), Math.floor(y * 3))] ?? 0;
  return L.fog[Math.floor(y) * m.width + Math.floor(x)] ?? 0;
}
export function wallCovered(m: Pick<GameMap, 'width' | 'height' | 'subdivisions'>, w: Wall) {
  const subs = new Set(m.subdivisions);
  const length = Math.abs(w.b.x - w.a.x) + Math.abs(w.b.y - w.a.y);
  for (let i = 0; i < length; i++) {
    const x = w.a.x + (i + 0.5) * Math.sign(w.b.x - w.a.x), y = w.a.y + (i + 0.5) * Math.sign(w.b.y - w.a.y);
    const candidates = w.a.x === w.b.x ? [[Math.floor(x / 3 - 1e-7), Math.floor(y / 3)], [Math.floor(x / 3), Math.floor(y / 3)]]
      : [[Math.floor(x / 3), Math.floor(y / 3 - 1e-7)], [Math.floor(x / 3), Math.floor(y / 3)]];
    if (!candidates.some(([cx, cy]) => cx >= 0 && cy >= 0 && cx < m.width && cy < m.height && subs.has(cy * m.width + cx))) return false;
  }
  return true;
}

export function segmentHitsRect(a: Point, b: Point, r: { x: number; y: number; w: number; h: number }, pad = 0) {
  let lo = 0, hi = 1;
  for (const [p, delta, min, max] of [[a.x, b.x - a.x, r.x - pad, r.x + r.w + pad], [a.y, b.y - a.y, r.y - pad, r.y + r.h + pad]]) {
    if (Math.abs(delta) < 1e-12) { if (p < min || p > max) return false; }
    else { const t0 = (min - p) / delta, t1 = (max - p) / delta; lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1)); if (lo > hi) return false; }
  }
  return true;
}
export const architectureBlocksSight = (m: GameMap, a: Point, b: Point) => architectureGeometry(m).some(r => r.blocksSight && segmentHitsRect(a, b, r));
export function furnitureSweepBlocked(m: GameMap, o: { x: number; y: number; w: number; h: number }, x: number, y: number) {
  return architectureGeometry(m).some(r => r.blocksMove && segmentHitsRect({ x: o.x + o.w / 2, y: o.y + o.h / 2 }, { x: x + o.w / 2, y: y + o.h / 2 }, { x: r.x - o.w / 2 + 1e-8, y: r.y - o.h / 2 + 1e-8, w: r.w + o.w - 2e-8, h: r.h + o.h - 2e-8 }));
}
/** 圆形人物沿整条线段扫掠。对轴对齐运动，矩形扩张+圆角精确距离。 */
function circleSweep(a: Point, b: Point, r: { x: number; y: number; w: number; h: number }, radius: number) {
  if (segmentHitsRect(a, b, r)) return true;
  const distPoint = (p: Point, u: Point, v: Point) => { const dx = v.x - u.x, dy = v.y - u.y, t = Math.max(0, Math.min(1, ((p.x - u.x) * dx + (p.y - u.y) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(p.x - u.x - t * dx, p.y - u.y - t * dy); };
  const corners = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
  const distRect = (p: Point) => Math.hypot(Math.max(r.x - p.x, 0, p.x - r.x - r.w), Math.max(r.y - p.y, 0, p.y - r.y - r.h));
  return Math.min(distRect(a), distRect(b), ...corners.map(p => distPoint(p, a, b))) < radius - 1e-8;
}
export function characterPathClear(w: World, m: GameMap, a: Point, b: Point, id?: string) {
  const radius = 1 / 3; // 0.50m 直径 / 0.75m 主格
  if (Math.min(a.x, b.x) < radius || Math.min(a.y, b.y) < radius || Math.max(a.x, b.x) > m.width - radius || Math.max(a.y, b.y) > m.height - radius) return false;
  if (architectureGeometry(m).some(r => r.blocksMove && circleSweep(a, b, r, radius))) return false;
  for (let y = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius)); y <= Math.min(m.height - 1, Math.floor(Math.max(a.y, b.y) + radius)); y++)
    for (let x = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius)); x <= Math.min(m.width - 1, Math.floor(Math.max(a.x, b.x) + radius)); x++) {
      const t = w.terrains.find(t => t.id === m.cells[y * m.width + x]);
      if ((!t || t.blocksMove) && circleSweep(a, b, { x, y, w: 1, h: 1 }, radius)) return false;
    }
  if (m.objects.some(o => o.kind === 'object' && !isArchitectureObject(o) && (o.physical?.blocksMove ?? (o.blocksWhen ? o.blocksWhen.includes(o.state) : o.height >= 0.5)) && circleSweep(a, b, o, radius))) return false;
  return !m.tokens.some(t => t.id !== id && circleSweep(a, b, { ...tokenPosition(t), w: 0, h: 0 }, radius * 2));
}
export function nextTokenStep(m: GameMap, t: Token, dx: number, dy: number) {
  const a = tokenPosition(t), fine = isSubdivided(m, a.x, a.y);
  let b = { x: a.x + dx * (fine ? 1 / 3 : 1), y: a.y + dy * (fine ? 1 / 3 : 1) };
  if (!isSubdivided(m, b.x, b.y)) b = { x: Math.floor(b.x) + 0.5, y: Math.floor(b.y) + 0.5 };
  return { a, b, cost: Math.round((Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) * 3) };
}
export function setTokenPosition(m: GameMap, t: Token, p: Point) {
  t.x = Math.floor(p.x); t.y = Math.floor(p.y);
  if (isSubdivided(m, p.x, p.y)) t.subcell = { x: Math.floor(p.x * 3 + 1e-8), y: Math.floor(p.y * 3 + 1e-8) };
  else delete t.subcell;
}
export function clipArchitecture(m: GameMap, L: { fog: number[]; subFog?: Record<number, number> }, value = 1, geometry: ArchitectureFragment[] = architectureGeometry(m, true).filter(r => !r.hidden)) {
  const out: ArchitectureFragment[] = [];
  for (const r of geometry) {
    const scale = 3;
    for (let sy = Math.max(0, Math.floor(r.y * scale)); sy < Math.min(m.height * scale, Math.ceil((r.y + r.h) * scale)); sy++)
      for (let sx = Math.max(0, Math.floor(r.x * scale)); sx < Math.min(m.width * scale, Math.ceil((r.x + r.w) * scale)); sx++) {
        if (fogAt(m, L, (sx + 0.5) / 3, (sy + 0.5) / 3) !== value) continue;
        const x = Math.max(r.x, sx / 3), y = Math.max(r.y, sy / 3), right = Math.min(r.x + r.w, (sx + 1) / 3), bottom = Math.min(r.y + r.h, (sy + 1) / 3);
        if (right > x && bottom > y) out.push({ x, y, w: right - x, h: bottom - y, material: r.material });
      }
  }
  return out;
}

/** Reject newly solid geometry overlapping people or solid furniture; all state workflows use this. */
export function architectureTransitionError(before: GameMap, after: GameMap): string | null {
  const old = architectureGeometry(before).filter(r => r.blocksMove), next = architectureGeometry(after).filter(r => r.blocksMove);
  const added = next.filter(r => !old.some(b => b.x === r.x && b.y === r.y && b.w === r.w && b.h === r.h));
  if (added.some(r => after.tokens.some(t => circleSweep(tokenPosition(t), tokenPosition(t), r, 1 / 3)) || after.objects.some(o => !isArchitectureObject(o) && o.kind === 'object' && (o.physical?.blocksMove ?? (o.blocksWhen ? o.blocksWhen.includes(o.state) : o.height >= .5)) && o.x < r.x + r.w - 1e-8 && o.x + o.w > r.x + 1e-8 && o.y < r.y + r.h - 1e-8 && o.y + o.h > r.y + 1e-8))) return '门洞中有人或家具，不能关门';
  return null;
}
export function objectStateError(map: GameMap, id: string, state: number): string | null {
  const o = map.objects.find(o => o.id === id);
  if (!o || !Number.isInteger(state) || state < 0 || state >= o.states.length) return '无效物件状态';
  if (!isArchitectureObject(o)) return null;
  return architectureTransitionError(map, { ...map, objects: map.objects.map(o => o.id === id ? { ...o, state } : o) });
}
