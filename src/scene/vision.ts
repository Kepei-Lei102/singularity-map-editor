import type { GameMap, Id, VisionLayer, World } from '../core/types';
import { current, isDraft } from 'immer';
import { clipArchitecture } from './architecture';

export const emptyVision = (n: number): VisionLayer => ({ fog: Array(n).fill(0), seen: { cells: Array(n).fill(''), objects: [], groups: [], groupRevs: {}, materialCells: {} } });
export const cloneLayer = (L: VisionLayer): VisionLayer => JSON.parse(JSON.stringify({ fog: L.fog, seen: L.seen }));

export function visionKey(w: World, pcId: string): string {
  const pc = w.party.find(p => p.id === pcId);
  if (!pc) return `missing:${pcId}`;
  if (w.visionMode === 'shared') return 'shared';
  if (w.visionMode === 'individual' || pc.visionGroupId === null) return `pc:${pcId}`;
  return pc.visionGroupId ? `group:${pc.visionGroupId}` : 'public';
}
export function visionMembers(w: World, pcId: string): string[] {
  if (!w.party.some(p => p.id === pcId)) return [];
  const key = visionKey(w, pcId);
  return w.party.filter(p => visionKey(w, p.id) === key).map(p => p.id);
}
export function effectiveLayer(w: World, m: GameMap, pcId: string): VisionLayer {
  if (!w.party.some(p => p.id === pcId)) return emptyVision(m.width * m.height);
  return w.visionMode === 'shared' ? m : m.views[pcId] ?? emptyVision(m.width * m.height);
}
export function knowledgeLayers(w: World, m: GameMap, pcIds?: string[]): VisionLayer[] {
  if (w.visionMode === 'shared') return [m];
  const ids = pcIds ? new Set(pcIds.flatMap(id => visionMembers(w, id))) : new Set(w.party.map(p => p.id));
  return [...ids].map(id => m.views[id] ??= emptyVision(m.width * m.height));
}
export function spatialKeys(m: GameMap, r: { x: number; y: number; w: number; h: number }): number[] {
  const keys: number[] = [];
  for (let y = Math.max(0, Math.floor(r.y * 3)); y < Math.min(m.height * 3, Math.ceil((r.y + r.h) * 3)); y++)
    for (let x = Math.max(0, Math.floor(r.x * 3)); x < Math.min(m.width * 3, Math.ceil((r.x + r.w) * 3)); x++) keys.push(y * m.width * 3 + x);
  return keys;
}
export function spatialFog(m: GameMap, L: VisionLayer, key: number): number {
  const x = key % (m.width * 3), y = Math.floor(key / (m.width * 3));
  return L.fog[Math.floor(y / 3) * m.width + Math.floor(x / 3)] ?? 0;
}

/** Merge knowledge only. Spatial observations include empty space, so seeing a demolition
 * supersedes old geometry even when the observer never knew that wall/object existed.
 * Legacy equal-version conflicts use content order: associative, deterministic and stable on remerge. */
export function mergeLayers(m: GameMap, layers: VisionLayer[]): VisionLayer {
  if (layers.length === 1) return cloneLayer(layers[0]);
  const out = emptyVision(m.width * m.height);
  out.seen.cellRevs = []; out.seen.observed = {}; out.seen.objectRevs = {}; out.seen.architectureRevs = {}; out.seen.groups = []; out.seen.groupRevs = {};
  const choose = <T,>(items: { rev: number; value: T; material?: Id }[]) => items.sort((a, b) => b.rev - a.rev || JSON.stringify(b.value).localeCompare(JSON.stringify(a.value)))[0];
  for (let i = 0; i < out.fog.length; i++) {
    out.fog[i] = layers.some(L => L.fog[i] === 1) ? 1 : layers.some(L => L.fog[i]) ? 2 : 0;
    const best = choose(layers.filter(L => L.fog[i]).map(L => ({ rev: L.seen.cellRevs?.[i] ?? 0, value: L.seen.cells[i], material: L.seen.materialCells?.[i] })));
    out.seen.cells[i] = best?.value ?? ''; out.seen.cellRevs[i] = best?.rev ?? 0;
    if (best?.material) out.seen.materialCells![i] = best.material; else delete out.seen.materialCells![i];
  }
  const fragments = layers.map(L => {
    const bins = new Map<number, NonNullable<typeof L.seen.architecture>>();
    for (const r of L.seen.architecture ?? []) for (const key of spatialKeys(m, r)) {
      const list = bins.get(key) ?? []; list.push(r); bins.set(key, list);
    }
    return bins;
  });
  const architecture = [];
  for (let key = 0; key < m.width * m.height * 9; key++) {
    const known = layers.flatMap((L, index) => spatialFog(m, L, key) ? [index] : []);
    if (!known.length) continue;
    const x = key % (m.width * 3), y = Math.floor(key / (m.width * 3));
    const pieces = (index: number) => (fragments[index].get(key) ?? []).flatMap(r => {
      const ax = Math.max(r.x, x / 3), ay = Math.max(r.y, y / 3), bx = Math.min(r.x + r.w, (x + 1) / 3), by = Math.min(r.y + r.h, (y + 1) / 3);
      return bx - ax > 1e-9 && by - ay > 1e-9 ? [{ x: ax, y: ay, w: bx - ax, h: by - ay, material: r.material }] : [];
    });
    const geometry = choose(known.map(index => ({ rev: layers[index].seen.architectureRevs?.[key] ?? layers[index].seen.observed?.[key] ?? 0, value: pieces(index) })));
    out.seen.observed[key] = Math.max(...known.map(index => layers[index].seen.observed?.[key] ?? 0));
    out.seen.architectureRevs[key] = geometry.rev;
    architecture.push(...geometry.value);
  }
  out.seen.architecture = architecture;
  const ids = new Set(layers.flatMap(L => L.seen.objects.map(o => o.id)));
  for (const id of ids) {
    const best = choose(layers.flatMap(L => L.seen.objects.filter(o => o.id === id).map(value => ({ rev: L.seen.objectRevs?.[id] ?? 0, value }))));
    const keys = spatialKeys(m, best.value);
    // Empty evidence at an old position cannot erase a newer sighting elsewhere.
    if (keys.some(key => (out.seen.observed?.[key] ?? 0) > best.rev)) continue;
    out.seen.objects.push({ ...best.value }); out.seen.objectRevs[id] = best.rev;
  }
  const groupIds = new Set(layers.flatMap((L) => (L.seen.groups ?? []).filter((g) => !g.objectId).map((g) => g.id)));
  for (const id of groupIds) {
    const candidates = layers.flatMap((L) => (L.seen.groups ?? []).filter((g) => g.id === id && !g.objectId).map((value) => ({
      rev: L.seen.groupRevs?.[id] ?? 0, value,
    })));
    if (!candidates.length) continue;
    const cells = [...new Set(candidates.flatMap((c) => c.value.cells))].filter((key) => {
      const x = key % (m.width * 3), y = Math.floor(key / (m.width * 3));
      return key >= 0 && key < m.width * m.height * 9 && (out.fog[Math.floor(y / 3) * m.width + Math.floor(x / 3)] ?? 0) > 0;
    }).sort((a, b) => a - b);
    if (!cells.length) continue;
    const best = choose(candidates);
    out.seen.groups.push({ ...best.value, cells });
    out.seen.groupRevs[id] = Math.max(...candidates.map((c) => c.rev));
  }
  return out;
}

/** 脏区的外接矩形（主格）。只用来快速排除和脏区无关的记忆条目。 */
function scopeRect(m: { width: number }, scope: Set<number>) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of scope) {
    const x = i % m.width, y = Math.floor(i / m.width);
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

const rectHits = (box: { x0: number; y0: number; x1: number; y1: number }, r: { x: number; y: number; w: number; h: number }) =>
  r.x <= box.x1 && r.x + r.w - 1 >= box.x0 && r.y <= box.y1 && r.y + r.h - 1 >= box.y0;

/**
 * 清掉已经不该存在的记忆。给了 scope 就只处理脏区：脏区外的雾没变，
 * 那里的记忆条目也不可能变成“全都没去过”。
 */
export function pruneMemory(m: GameMap, L: VisionLayer, scope?: Set<number>) {
  const source = isDraft(m) ? current(m) : m;
  const layer = isDraft(L) ? current(L) : L;
  const box = scope ? scopeRect(source, scope) : null;
  if (!box) L.seen.objects = layer.seen.objects.filter(o => spatialKeys(source, o).some(key => spatialFog(source, layer, key)));
  else {
    const kept = layer.seen.objects.filter((o) => !rectHits(box, o) || spatialKeys(source, o).some((key) => spatialFog(source, layer, key)));
    if (kept.length !== layer.seen.objects.length) L.seen.objects = kept;
  }
  if (!box) L.seen.groups = (layer.seen.groups ?? []).flatMap((g) => {
    const cells = g.cells.filter((key) => spatialFog(source, layer, key) > 0);
    return cells.length ? [{ ...g, cells }] : [];
  });
  else {
    const w3 = source.width * 3;
    const inBox = (key: number) => {
      const x = Math.floor((key % w3) / 3), y = Math.floor(Math.floor(key / w3) / 3);
      return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
    };
    L.seen.groups = (layer.seen.groups ?? []).flatMap((g) => {
      if (!g.cells.some(inBox)) return [g]; // 脏区外：原样留着
      const cells = g.cells.filter((key) => spatialFog(source, layer, key) > 0);
      return cells.length ? [{ ...g, cells }] : [];
    });
  }
  L.seen.architecture = [...clipArchitecture(source, layer, 1, layer.seen.architecture ?? []), ...clipArchitecture(source, layer, 2, layer.seen.architecture ?? [])];
  if (!box) { for (const key of Object.keys(layer.seen.observed ?? {})) if (!spatialFog(source, layer, +key)) delete L.seen.observed![+key]; }
  else {
    const w3 = source.width * 3;
    for (const i of scope!) {
      const cx = i % source.width, cy = Math.floor(i / source.width);
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
        const key = (cy * 3 + sy) * w3 + (cx * 3 + sx);
        if (layer.seen.observed?.[key] && !spatialFog(source, layer, key)) delete L.seen.observed![key];
      }
    }
  }
}
