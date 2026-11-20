// 一次改动的脏集：这次到底动了哪些棋子、哪些地图内容。
//
// 只用稳定 id（地图 id、棋子 id、坐标），不记对象引用：试玩沙盒、撤销、导入都会整对象替换，
// 按引用记的脏集一换就全错。
import type { GameMap, Point, Token, World } from '../core/types';

export interface Dirty {
  mapId: string;
  /** 移动/转身/换姿态的棋子；from 与 to 相同表示原地变化（转身、蹲下）。 */
  moved: { from: Point; to: Point }[];
  /** 地形、建筑、物件高度这类会影响任意视线的改动。 */
  structure: boolean;
  /** 只影响视野的结构改动；memory-only 的材质/贴图组/高度改动不会让它变真。 */
  visionStructure?: boolean;
  /** 换图、首次同步、导入：整份重算。 */
  full: boolean;
}

const samePoint = (a?: Point | null, b?: Point | null) =>
  (a?.x ?? null) === (b?.x ?? null) && (a?.y ?? null) === (b?.y ?? null);

// 手动改过 fog/views 的图：这次 update 先保留手动结果，下一次有视野脏动的 update
// 再按自动迷雾整图覆盖。和整图重算的旧行为一致，也不会让手动改的那一格永远漏算。
const manualFog = new WeakSet<object>();
function fogArrays(m: GameMap): object[] {
  return [m.fog, ...Object.values(m.views ?? {}).map((v) => v.fog)];
}
export function markManualFog(m: GameMap): void {
  for (const a of fogArrays(m)) manualFog.add(a);
}
export function isManualFog(m: GameMap): boolean {
  return fogArrays(m).some((a) => manualFog.has(a));
}
function tokenMoved(a: Token, b: Token): boolean {
  return a.x !== b.x || a.y !== b.y || !samePoint(a.subcell, b.subcell)
    || a.facing !== b.facing || a.stance !== b.stance || a.pcId !== b.pcId;
}

/** 队伍里只有这几项会影响「谁看得见什么」：成员身份、视野组、眼睛高度。 */
export function partyVisionChanged(a: World, b: World): boolean {
  if (a.visionMode !== b.visionMode || a.visionGroups !== b.visionGroups) return true;
  if (a.party.length !== b.party.length) return true;
  for (let i = 0; i < a.party.length; i++) {
    const x = a.party[i], y = b.party[i];
    if (!y || x.id !== y.id || x.visionGroupId !== y.visionGroupId || x.sex !== y.sex || x.heightCm !== y.heightCm) return true;
  }
  return false;
}

/** 棋子改动里只有位置/朝向/姿态/归属会影响视野；改名、HP、状态标签不该触发重算。 */
export function tokensVisionChanged(a: Token[], b: Token[]): boolean {
  if (a.length !== b.length) return true;
  const before = new Map(a.map((t) => [t.id, t]));
  for (const t of b) {
    const o = before.get(t.id);
    if (!o || tokenMoved(o, t)) return true;
  }
  return false;
}

/** 物件里会改视线的字段：位置、尺寸、高度、状态、开关、精细几何。名称/颜色/备注不算。 */
function objectVisionChanged(a: GameMap['objects'][number], b: GameMap['objects'][number]): boolean {
  return a.id !== b.id || a.kind !== b.kind || a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h
    || a.height !== b.height || a.state !== b.state || a.enabled !== b.enabled || a.hidden !== b.hidden
    || a.blocksWhen !== b.blocksWhen || a.physical !== b.physical || a.geometry !== b.geometry || a.opening !== b.opening;
}

export function objectsVisionChanged(a: GameMap['objects'], b: GameMap['objects']): boolean {
  if (a.length !== b.length) return true;
  const before = new Map(a.map((o) => [o.id, o]));
  for (const o of b) {
    const old = before.get(o.id);
    if (!old || objectVisionChanged(old, o)) return true;
  }
  return false;
}

/** 只有这些地图字段会改视线；材质、房间、贴图组、高度不改视野。 */
export function mapVisionChanged(a: GameMap, b: GameMap): boolean {
  return a.cells !== b.cells || a.fineCells !== b.fineCells || a.d100 !== b.d100
    || objectsVisionChanged(a.objects, b.objects) || a.architecture !== b.architecture;
}

function mapStructureChanged(a: GameMap, b: GameMap): boolean {
  // 除了地形/建筑，雾和记忆层被外部改过（手动揭示、导入）也要走全量，否则记忆会漏同步。
  return a.cells !== b.cells || a.fineCells !== b.fineCells || a.d100 !== b.d100
    || a.objects !== b.objects || a.heights !== b.heights || a.architecture !== b.architecture
    || a.materialCells !== b.materialCells || a.fineMaterials !== b.fineMaterials
    || a.rooms !== b.rooms || a.roomCells !== b.roomCells
    || a.groups !== b.groups || a.fog !== b.fog || a.views !== b.views || a.autoFog !== b.autoFog;
}

/** prev → next 的脏集。地图按 id 对齐，新增的地图标 full。 */
export function diffWorld(prev: World, next: World): Dirty[] {
  // 这几个一换，所有地图的视野都可能变：地形系数、队员身份/视野组/模式。
  // 队员名字、HP 这类字段变了不算——它们不影响任何一条视线。
  const globalVisionFull = prev.terrains !== next.terrains || partyVisionChanged(prev, next);

  const out: Dirty[] = [];
  for (const m of next.maps) {
    const before = prev.maps.find((x) => x.id === m.id);
    if (!before || globalVisionFull) { out.push({ mapId: m.id, moved: [], structure: true, visionStructure: true, full: true }); continue; }
    const moved: Dirty['moved'] = [];
    const byId = new Map(before.tokens.map((t) => [t.id, t]));
    for (const t of m.tokens) {
      const old = byId.get(t.id);
      if (!old) continue; // 新棋子：由下面 structure 兜底走全图
      if (tokenMoved(old, t)) moved.push({ from: { x: old.x, y: old.y }, to: { x: t.x, y: t.y } });
    }
    const added = m.tokens.length !== before.tokens.length || before.tokens.some((t) => !m.tokens.some((x) => x.id === t.id));
    // 自动迷雾从关到开：之前是手动态，地图 fog 没被自动规则算过，这次必须整图补上。
    const autoFogOn = !before.autoFog && m.autoFog;
    const structure = added || isManualFog(before) || autoFogOn || mapStructureChanged(before, m);
    const visionStructure = added || isManualFog(before) || autoFogOn || mapVisionChanged(before, m);
    out.push({ mapId: m.id, moved, structure, visionStructure, full: false });
  }
  return out;
}
