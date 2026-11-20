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
  // 这几个一换，所有地图的视野都可能变：地形系数、队员、视野分组/模式。
  const globalFull = prev.terrains !== next.terrains || prev.party !== next.party
    || prev.visionGroups !== next.visionGroups || prev.visionMode !== next.visionMode;

  const out: Dirty[] = [];
  for (const m of next.maps) {
    const before = prev.maps.find((x) => x.id === m.id);
    if (!before || globalFull) { out.push({ mapId: m.id, moved: [], structure: true, full: true }); continue; }
    const moved: Dirty['moved'] = [];
    const byId = new Map(before.tokens.map((t) => [t.id, t]));
    for (const t of m.tokens) {
      const old = byId.get(t.id);
      if (!old) continue; // 新棋子：由下面 structure 兜底走全图
      if (tokenMoved(old, t)) moved.push({ from: { x: old.x, y: old.y }, to: { x: t.x, y: t.y } });
    }
    const added = m.tokens.length !== before.tokens.length || before.tokens.some((t) => !m.tokens.some((x) => x.id === t.id));
    const structure = added || isManualFog(before) || mapStructureChanged(before, m);
    out.push({ mapId: m.id, moved, structure, full: structure });
  }
  return out;
}
