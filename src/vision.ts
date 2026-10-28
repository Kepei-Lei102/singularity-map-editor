import type { GameMap, VisionLayer, World } from './types';
import { clipArchitecture, isSubdivided } from './architecture';

export const emptyVision = (n: number): VisionLayer => ({ fog: Array(n).fill(0), seen: { cells: Array(n).fill(''), objects: [] } });
export const cloneLayer = (L: VisionLayer): VisionLayer => JSON.parse(JSON.stringify({ fog: L.fog, subFog: L.subFog, seen: L.seen }));

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
  return isSubdivided(m, Math.floor(x / 3), Math.floor(y / 3)) ? L.subFog?.[key] ?? 0 : L.fog[Math.floor(y / 3) * m.width + Math.floor(x / 3)] ?? 0;
}

/** Merge knowledge only. Spatial observations include empty space, so seeing a demolition
 * supersedes old geometry even when the observer never knew that wall/object existed.
 * Legacy equal-version conflicts use content order: associative, deterministic and stable on remerge. */
export function mergeLayers(m: GameMap, layers: VisionLayer[]): VisionLayer {
  if (layers.length === 1) return cloneLayer(layers[0]);
  const out = emptyVision(m.width * m.height);
  out.subFog = {}; out.seen.subCells = {}; out.seen.cellRevs = []; out.seen.observed = {}; out.seen.objectRevs = {}; out.seen.subRevs = {}; out.seen.architectureRevs = {};
  const choose = <T,>(items: { rev: number; value: T }[]) => items.sort((a, b) => b.rev - a.rev || JSON.stringify(b.value).localeCompare(JSON.stringify(a.value)))[0];
  for (let i = 0; i < out.fog.length; i++) {
    out.fog[i] = layers.some(L => L.fog[i] === 1) ? 1 : layers.some(L => L.fog[i]) ? 2 : 0;
    const best = choose(layers.filter(L => L.fog[i]).map(L => ({ rev: L.seen.cellRevs?.[i] ?? 0, value: L.seen.cells[i] })));
    out.seen.cells[i] = best?.value ?? ''; out.seen.cellRevs[i] = best?.rev ?? 0;
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
    const terrain = choose(known.map(index => ({ rev: layers[index].seen.subRevs?.[key] ?? layers[index].seen.observed?.[key] ?? 0, value: layers[index].seen.subCells?.[key] ?? layers[index].seen.cells[Math.floor(y / 3) * m.width + Math.floor(x / 3)] })));
    const geometry = choose(known.map(index => ({ rev: layers[index].seen.architectureRevs?.[key] ?? layers[index].seen.observed?.[key] ?? 0, value: pieces(index) })));
    out.seen.observed[key] = Math.max(...known.map(index => layers[index].seen.observed?.[key] ?? 0));
    out.seen.architectureRevs[key] = geometry.rev;
    if (isSubdivided(m, Math.floor(x / 3), Math.floor(y / 3))) {
      out.subFog[key] = layers.some(L => spatialFog(m, L, key) === 1) ? 1 : 2;
      out.seen.subCells[key] = terrain.value; out.seen.subRevs[key] = terrain.rev;
    }
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
  return out;
}

export function pruneMemory(m: GameMap, L: VisionLayer) {
  L.seen.objects = L.seen.objects.filter(o => spatialKeys(m, o).some(key => spatialFog(m, L, key)));
  L.seen.architecture = [...clipArchitecture(m, L, 1, L.seen.architecture ?? []), ...clipArchitecture(m, L, 2, L.seen.architecture ?? [])];
  for (const key of Object.keys(L.seen.observed ?? {})) if (!spatialFog(m, L, +key)) delete L.seen.observed![+key];
}
