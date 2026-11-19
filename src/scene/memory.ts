import { identityKnowledge } from './identity';
import { materialAtCell } from './material';
import { objectEnabled } from '../core/objectData.js';
import { clipArchitecture, isArchitectureObject, migrateArchitecture } from './architecture';
import { repairWorld } from '../core/schema.js';
import { current, isDraft, type Draft } from 'immer';
import { buildFineCells, groupBounds, objectFootprintCells } from '../core/grid';
import type { CellGroup, GameMap, Id, MapObject, SeenObject, TextureSpec, VisionLayer, World } from '../core/types';
import { linesToFlow } from '../rules/flow';
import { DEFAULT_MATERIALS } from '../core/defaults';
import { cloneLayer, emptyVision, mergeLayers, pruneMemory, spatialFog, visionKey } from './vision';
import type { VisionPlan } from './visionPlan';

// 星际争霸式迷雾：fog 0 没去过 / 1 看得见 / 2 记忆。
// 规则只有一条：看得见的地方，记忆 = 现实；看不见的地方，记忆停在上一次看见时。

type Rect = { x: number; y: number; w: number; h: number };

/** 脏区：主格索引集合；undefined 表示全图。 */
type CellScope = Set<number> | undefined;

export function anyVisible(m: { width: number; height: number; fog: number[] }, r: Rect) {
  for (let y = Math.max(0, r.y); y < Math.min(m.height, r.y + r.h); y++)
    for (let x = Math.max(0, r.x); x < Math.min(m.width, r.x + r.w); x++) {
      if (m.fog[y * m.width + x] === 1) return true;
    }
  return false;
}

export const emptyLayer = emptyVision;

/** 记忆里物件的外观版本：没有图就是 none；fit/opacity 归一后再比，避免 1 和 0.999999 算两版。 */
export function textureKeyOf(t?: TextureSpec) {
  return t ? `${t.mediaId}~${t.fit ?? 'fill'}~${Math.round((t.opacity ?? 1) * 1000) / 1000}` : 'none';
}

function cloneTexture(t?: TextureSpec): TextureSpec | undefined {
  return t ? { mediaId: t.mediaId, fit: t.fit, opacity: t.opacity } : undefined;
}

/** 物件自带贴图的实时图，来自唯一的物件贴图组；一次建表，别每个物件扫一遍组。 */
function objectTexturesOf(m: GameMap): Map<string, TextureSpec> {
  const out = new Map<string, TextureSpec>();
  // schema 禁止一个物件两组；万一旧数据重复，按第一组，保持原来线性 find 的语义。
  for (const g of m.groups ?? []) if (g.objectId && g.texture && !out.has(g.objectId)) out.set(g.objectId, g.texture);
  return out;
}

export function snapshot(o: MapObject | Draft<MapObject>, texture?: TextureSpec): SeenObject {
  const ghost = !!o.blocksWhen && !o.blocksWhen.includes(o.state);
  const tex = cloneTexture(texture);
  return {
    id: o.id, name: o.name, icon: o.icon, color: o.color, x: o.x, y: o.y, w: o.w, h: o.h, anchor: o.anchor, height: o.height,
    identity: identityKnowledge(o),
    stateLabel: o.states.length > 1 ? o.states[o.state] ?? '' : null,
    ...(tex ? { texture: tex } : {}),
    ...(ghost ? { ghost: true } : {}),
  };
}

export function sameSeen(a: SeenObject, b: SeenObject) {
  return a.name === b.name && a.icon === b.icon && a.color === b.color && a.x === b.x && a.y === b.y &&
    (a.anchor?.x ?? 0) === (b.anchor?.x ?? 0) && (a.anchor?.y ?? 0) === (b.anchor?.y ?? 0) &&
    a.w === b.w && a.h === b.h && a.height === b.height && a.stateLabel === b.stateLabel && JSON.stringify(a.identity) === JSON.stringify(b.identity) &&
    textureKeyOf(a.texture) === textureKeyOf(b.texture) && !!a.ghost === !!b.ghost;
}

/** 物件贴图组是物件外观的派生数据：格子永远等于物件当前脚印。放在 syncMemory 里统一校正，
 *  这样拖动、改尺寸、房间复位、滑块移动、扩缩图、复制地图、导入都走同一条路。 */
function syncObjectGroups(m: Draft<GameMap>) {
  if (!m.groups?.length) return;
  const objects = new Map(m.objects.map((o) => [o.id, o]));
  for (const g of m.groups) {
    if (!g.objectId) continue;
    const o = objects.get(g.objectId);
    if (!o) continue;
    const cells = objectFootprintCells(m.width, m.height, o);
    if (cells.length !== g.cells.length || cells.some((v, i) => v !== g.cells[i])) g.cells = cells;
    const bounds = groupBounds(m.width, cells, m.height);
    if (bounds) {
      if (!g.bounds || g.bounds.x0 !== bounds.x0 || g.bounds.y0 !== bounds.y0 || g.bounds.x1 !== bounds.x1 || g.bounds.y1 !== bounds.y1) g.bounds = bounds;
    } else if (g.bounds) delete g.bounds;
  }
}

/** 脏区的外接矩形；只用来快速排除不相关的物件和贴图组。 */
function scopeBBox(m: { width: number }, scope: Set<number>) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of scope) {
    const x = i % m.width, y = Math.floor(i / m.width);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

function touchesRect(bbox: { x0: number; y0: number; x1: number; y1: number }, r: Rect): boolean {
  return r.x <= bbox.x1 && r.x + r.w - 1 >= bbox.x0 && r.y <= bbox.y1 && r.y + r.h - 1 >= bbox.y0;
}

/** 贴图组记的是 1/3 格子键，换算成主格再和脏区比。 */
function touchesGroup(box: { x0: number; y0: number; x1: number; y1: number }, width3: number, cells: number[]): boolean {
  for (const key of cells) {
    const x = Math.floor((key % width3) / 3), y = Math.floor(Math.floor(key / width3) / 3);
    if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) return true;
  }
  return false;
}

/** 把一份迷雾里"看得见"的部分同步进它的记忆。给了 scope 就只处理这些主格。 */
function syncLayer(m: Draft<GameMap>, L: Draft<VisionLayer>, rev: number, scope?: CellScope) {
  // Read geometry/fog from one plain snapshot; scanning subcells through Immer proxies
  // repeats thousands of trapped subdivision lookups on every movement.
  const source = isDraft(m) ? current(m) : m;
  const layer = isDraft(L) ? current(L) : L;
  L.seen.cellRevs ??= Array(m.width * m.height).fill(0); L.seen.observed ??= {}; L.seen.objectRevs ??= {}; L.seen.architectureRevs ??= {};
  const width3 = m.width * 3;
  if (scope) {
    for (const i of scope) {
      const cx = i % m.width, cy = Math.floor(i / m.width);
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
        const key = (cy * 3 + sy) * width3 + (cx * 3 + sx);
        if (spatialFog(source, layer, key) === 1) { L.seen.observed[key] = rev; L.seen.architectureRevs[key] = rev; }
      }
    }
  } else {
    for (let key = 0; key < source.width * source.height * 9; key++) if (spatialFog(source, layer, key) === 1) { L.seen.observed[key] = rev; L.seen.architectureRevs[key] = rev; }
  }
  const n = m.width * m.height;
  const cellRevs = (L.seen.cellRevs ??= Array(n).fill(0));
  const materialCells = (L.seen.materialCells ??= {});
  const writeCell = (i: number) => {
    if (L.fog[i] !== 1) return;
    L.seen.cells[i] = m.cells[i]; cellRevs[i] = rev;
    const mid = materialAtCell(m, i);
    if (mid) materialCells[i] = mid; else delete materialCells[i];
  };
  if (scope) for (const i of scope) writeCell(i);
  else for (let i = 0; i < n; i++) writeCell(i);
  // 建筑记忆按整层重算：它只跟建筑段数有关，跟格数无关。
  const historical = clipArchitecture(source, layer, 2, layer.seen.architecture ?? []);
  L.seen.architecture = [...historical, ...clipArchitecture(source, layer)];
  const bbox = scope ? scopeBBox(source, scope) : null;
  const box = { ...source, fog: layer.fog };
  const live = source.objects.filter((o) => objectEnabled(source, o) && o.kind === 'object' && !isArchitectureObject(o) && !o.hidden
    && (!bbox || touchesRect(bbox, o)) && anyVisible(box, o));
  const liveIds = new Set(live.map((o) => o.id));
  const textures = objectTexturesOf(source);
  // 记忆里的东西，原地方现在看得见了、但它已经不在那（被搬走/删掉/藏起来）→ 忘掉。
  // 脏区外的记忆不受影响，直接留着。
  const kept = L.seen.objects.filter((r) => liveIds.has(r.id) || !anyVisible(box, r) || (bbox !== null && !touchesRect(bbox, r)));
  if (kept.length !== L.seen.objects.length) L.seen.objects = kept;
  for (const o of live) {
    const snap = snapshot(o, textures.get(o.id));
    L.seen.objectRevs[o.id] = rev;
    const i = L.seen.objects.findIndex((r) => r.id === o.id);
    if (i < 0) L.seen.objects.push(snap);
    else if (!sameSeen(L.seen.objects[i], snap)) L.seen.objects[i] = snap;
  }
  // 贴图组记忆：同一块地按贴图版本分开记。看得见的格子跟现在的贴图，
  // 看不见的格子留在它上次被看见时的那一版；换图只影响看得见的部分。
  // 物件贴图（objectId）是物件外观，等物件外观那一步再接记忆；这里只记地面/贴花。
  const textureKeyOf = (g: CellGroup) => g.texture ? `${g.texture.mediaId}~${g.texture.fit ?? 'fill'}~${Math.round((g.texture.opacity ?? 1) * 1000) / 1000}` : 'none';
  const memorySourceOf = (g: CellGroup) => g.sourceId ?? g.id;
  const liveGroups = (source.groups ?? []).filter((g) => !g.objectId);
  const visibleCellsOf = (g: CellGroup) => new Set(g.cells.filter((key) => spatialFog(source, layer, key) === 1));
  const nextGroups = new Map<string, CellGroup>();
  const nextRevs = new Map<string, number>();
  const oldRevs = L.seen.groupRevs ?? {};
  // 旧记忆组：只留灰格，按原版本保留；同时把旧工程的旧 id 归一成「原组~版本」。
  for (const old of (L.seen.groups ?? []).filter((g) => !g.objectId)) {
    const sourceId = memorySourceOf(old);
    const textureKey = textureKeyOf(old);
    const id = `${sourceId}~${textureKey}`;
    if (bbox && !touchesGroup(bbox, width3, old.cells)) {
      // 脏区外的组：格子的雾没变，原样保留（只做 id 归一，和全量口径一致）。
      nextGroups.set(id, { ...old, id, sourceId, textureKey });
      nextRevs.set(id, Math.max(nextRevs.get(id) ?? 0, oldRevs[id] ?? 0, oldRevs[old.id] ?? 0));
      continue;
    }
    const cells = old.cells.filter((key) => spatialFog(source, layer, key) === 2).sort((a, b) => a - b);
    if (!cells.length) continue;
    const before = nextGroups.get(id);
    const next: CellGroup = before
      ? { ...before, cells: [...new Set([...before.cells, ...cells])].sort((a, b) => a - b) }
      : { id, name: old.name, cells, ...(old.texture ? { texture: old.texture } : {}), ...(old.z !== undefined ? { z: old.z } : {}), sourceId, textureKey };
    nextGroups.set(id, next);
    nextRevs.set(id, Math.max(nextRevs.get(id) ?? 0, oldRevs[id] ?? 0, oldRevs[old.id] ?? 0));
  }
  // 当前可见的格子：按当前的贴图版本单独记一份；同一个版本和旧灰格并起来。
  for (const live of liveGroups) {
    if (bbox && !touchesGroup(bbox, width3, live.cells)) continue;
    const cells = [...new Set(visibleCellsOf(live))].sort((a, b) => a - b);
    if (!cells.length) continue;
    const textureKey = textureKeyOf(live);
    if (textureKey === 'none') continue; // 没贴图的可见格不需要一份“空记忆组”
    const id = `${live.id}~${textureKey}`;
    const before = nextGroups.get(id);
    const merged = before ? [...new Set([...before.cells, ...cells])].sort((a, b) => a - b) : cells;
    const next: CellGroup = { id, name: live.name, cells: merged, z: live.z, texture: live.texture, sourceId: live.id, textureKey };
    nextGroups.set(id, next);
    nextRevs.set(id, rev);
  }
  L.seen.groups = [...nextGroups.values()];
  L.seen.groupRevs = Object.fromEntries([...nextRevs].filter(([id]) => nextGroups.has(id)));
}

/** 每次修改世界后执行：全队那份和每个人自己那份，都把"看得见"的部分同步进记忆。 */
export function syncMemory(d: Draft<World>, plan?: VisionPlan) {
  const rev = d.observationSeq = (d.observationSeq ?? 0) + 1;
  for (const m of d.maps) {
    migrateArchitecture(m);
    syncObjectGroups(m);
    const scope: CellScope = plan && !plan.full ? plan.maps.get(m.id) ?? undefined : undefined;
    if (scope && scope.size === 0) continue; // 这张图没变
    if (d.visionMode === 'shared') {
      syncLayer(m, m, rev, scope);
      pruneMemory(m, m, scope);
      for (const p of d.party) m.views[p.id] = cloneLayer(m);
    } else {
      const done = new Set<string>();
      for (const p of d.party) {
        const key = visionKey(d, p.id); if (done.has(key)) continue; done.add(key);
        const L = m.views[p.id]; syncLayer(m, L, rev, scope); pruneMemory(m, L, scope);
        for (const peer of d.party.filter(x => visionKey(d, x.id) === key)) m.views[peer.id] = cloneLayer(L);
      }
      Object.assign(m, mergeLayers(m, d.party.map(p => m.views[p.id])));
    }
    // 辨识改变知识归属，不刷新灰区中物件的位置或状态。
    const source = isDraft(m) ? current(m) : m;
    const identities = new Map(source.objects.map(o => [o.id, identityKnowledge(o)]));
    for (const L of [m, ...Object.values(m.views)]) L.seen.objects = L.seen.objects.map(r => {
      const identity = identities.get(r.id);
      return identity && JSON.stringify(r.identity) !== JSON.stringify(identity) ? { ...r, identity } : r;
    });
  }
}

/** 旧存档（只有 0/1 迷雾）补上记忆字段。 */
export function migrateWorld(w: World): World {
  const v1 = (w as { version?: number }).version === 1;
  for (const m of w.maps) {
    migrateArchitecture(m);
    // v1（粗格 + 稀疏子格覆盖）→ v2（完整小格数组）。
    if (!m.fineCells) {
      m.fineCells = buildFineCells(m.width, m.height, m.cells ?? []);
      // 旧版的子格只对当时列在 subdivisions 里的主格有效；取消细分后遗留的孤儿键
      // 不能重新长回来。这里按父格过滤，坏 key/出界 key 直接丢。
      const legacySubs = (m as { subdivisions?: number[] }).subdivisions;
      const subs = new Set(Array.isArray(legacySubs) ? legacySubs : []);
      const legacy = (m as { subCells?: Record<number, string> }).subCells;
      if (legacy) {
        const fw = m.width * 3, limit = fw * m.height * 3;
        for (const [rawKey, value] of Object.entries(legacy)) {
          const key = +rawKey;
          if (!Number.isInteger(key) || key < 0 || key >= limit) continue;
          const x3 = key % fw, y3 = Math.floor(key / fw);
          if (!subs.has(Math.floor(y3 / 3) * m.width + Math.floor(x3 / 3))) continue;
          m.fineCells[key] = value;
        }
      }
    }
    if (!m.fineMaterials) {
      const legacy = (m as { materialSubCells?: Record<number, Id> }).materialSubCells;
      if (legacy) {
        const legacySubs = (m as { subdivisions?: number[] }).subdivisions;
        const subs = new Set(Array.isArray(legacySubs) ? legacySubs : []);
        const fw = m.width * 3, limit = fw * m.height * 3;
        const kept: Record<number, Id> = {};
        for (const [rawKey, value] of Object.entries(legacy)) {
          const key = +rawKey;
          if (!Number.isInteger(key) || key < 0 || key >= limit) continue;
          const x3 = key % fw, y3 = Math.floor(key / fw);
          if (!subs.has(Math.floor(y3 / 3) * m.width + Math.floor(x3 / 3))) continue;
          kept[key] = value;
        }
        if (Object.keys(kept).length) m.fineMaterials = kept;
      }
    }
    if (!m.seen) m.seen = { cells: m.cells.map((c, i) => (m.fog[i] === 1 ? c : '')), objects: [], groups: [] };
    m.seen.groups ??= [];
    m.seen.groupRevs ??= {};
    m.groups ??= [];
    m.autoFog ??= true;
    m.rooms ??= [];
    m.roomCells ??= new Array(m.width * m.height).fill('');
    m.views ??= {};
    m.spawn ??= null;
    // 旧版的 observed / architectureRevs 也按小格 key 记；父格已取消细分的孤儿键
    // 要跟地形/材质一起清掉，否则历史墙裁剪还会读到。
    const legacySubs = (m as { subdivisions?: number[] }).subdivisions;
    if (v1 || legacySubs !== undefined) {
      const subs = new Set(legacySubs);
      const fw = m.width * 3, limit = fw * m.height * 3;
      const dropOrphans = (data?: Record<number, number>) => {
        if (!data || typeof data !== 'object') return;
        for (const rawKey of Object.keys(data)) {
          const key = +rawKey;
          if (!Number.isInteger(key) || key < 0 || key >= limit || String(key) !== rawKey) {
            delete (data as Record<string, unknown>)[rawKey];
            continue;
          }
          const parent = Math.floor(Math.floor(key / fw) / 3) * m.width + Math.floor((key % fw) / 3);
          if (!subs.has(parent)) delete data[key];
        }
      };
      for (const L of [m.seen, ...Object.values(m.views).map((v) => v.seen)]) {
        if (!L || typeof L !== 'object') continue;
        dropOrphans((L as { observed?: Record<number, number> }).observed);
        dropOrphans((L as { architectureRevs?: Record<number, number> }).architectureRevs);
      }
    }
    delete (m as { subdivisions?: unknown }).subdivisions;
    delete (m as { subCells?: unknown }).subCells;
    delete (m as { materialSubCells?: unknown }).materialSubCells;
    delete (m as { subFog?: unknown }).subFog;
    for (const L of [m.seen, ...Object.values(m.views).map((v) => v.seen)]) {
      delete (L as { subCells?: unknown }).subCells;
      delete (L as { materialSubCells?: unknown }).materialSubCells;
      delete (L as { subRevs?: unknown }).subRevs;
    }
    for (const L of Object.values(m.views)) delete (L as { subFog?: unknown }).subFog;
    for (const L of Object.values(m.views)) { if (L?.seen) { L.seen.groups ??= []; L.seen.groupRevs ??= {}; } }
    for (const o of m.objects) for (const s of o.secrets) { s.kind ??= 'roll'; s.range ??= 1; }
  }
  if (v1) w.version = 2;
  w.version = 2;
  w.materials ??= structuredClone(DEFAULT_MATERIALS);
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
    for (const field of [L.seen.observed, L.seen.objectRevs, L.seen.architectureRevs])
      for (const value of Object.values(field ?? {})) maxRev = Math.max(maxRev, value);
  }
  w.observationSeq = maxRev;
  // Legacy names can bind only when unambiguous; otherwise the host must reveal again.
  for (const m of w.maps) for (const o of m.objects) for (const s of o.secrets)
    if (s.revealed?.scope === 'private' && !s.revealed.recipients) {
      const matches = w.party.filter(p => p.name === s.revealed!.to);
      s.revealed.recipients = matches.length === 1 ? [matches[0].id] : [];
    }
  repairWorld(w); // 旧版输入框允许过的超范围数值夹回来
  delete (w as { clock?: number }).clock; // 旧版的世界时钟，已改成直接读真实时间
  if (!w.flows) w.flows = [linesToFlow(w.lines ?? [])];
  delete w.lines;
  return w;
}

/** 主持人用：玩家记得的样子和现在不一样的物件。 */
export function staleMemories(m: GameMap) {
  const textures = objectTexturesOf(m);
  return m.seen.objects.filter((r) => {
    if (anyVisible(m, r)) return false;
    const o = m.objects.find((x) => x.id === r.id);
    return !o || !objectEnabled(m, o) || o.hidden || !sameSeen(r, snapshot(o, textures.get(o.id)));
  });
}
