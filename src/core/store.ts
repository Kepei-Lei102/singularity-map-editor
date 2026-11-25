import { architectureTransitionError } from '../scene/architecture';
import { freeze, produce, type Draft } from 'immer';
import { useSyncExternalStore } from 'react';
import type { SenseHint, SenseKind, SenseRoll } from '../rules/sense';
import type { GameMap, PendingCodeAttempt, PendingJudgment, World } from './types';
import { demoWorld, emptyWorld } from './defaults';
import { isPlayerEntry } from './deployment';
import { normalizeNpcHp } from '../rules/combat';
import { migrateWorld, narrowTerrainMemoryPlan, syncMemory } from '../scene/memory';
import type { CombatNotice } from './types';
import { setMediaIndex } from '../runtime/media';
import { withVision } from '../scene/perception';
import { markManualFog, partyVisionChanged, diffWorld, tokensVisionChanged } from '../scene/dirty';
import { planVision } from '../scene/visionPlan';
import { loadSlot, saveSlot } from './persist';
import { onSessionRenewed } from './session';
import { uid } from './util';

/** 浏览器允不允许本页保存数据。 */
export const storageOK = (() => {
  try { localStorage.setItem('ts-probe', '1'); localStorage.removeItem('ts-probe'); return true; } catch { return false; }
})();
const isPlayerWindow = isPlayerEntry(); // 玩家窗口只显示，不存档

function load(): World | null {
  if (isPlayerWindow) return null;
  try {
    const s = loadSlot('world');
    return s ? migrateWorld(JSON.parse(s) as World) : null;
  } catch {
    return null;
  }
}

// ---------- 世界（有撤销历史，自动保存） ----------

let world: World = isPlayerWindow ? emptyWorld() : load() ?? demoWorld();
world = produce(withVision(world, { ...world, maps: [] }), syncMemory);
setMediaIndex(world.media);
let past: World[] = [];
let future: World[] = [];
let batching = false;
let lastCoalesce: { key: string; at: number } | null = null;
const listeners = new Set<() => void>();
let saveTimer: number | undefined;
// 沙盒（试玩）：开始时记下世界和撤销记录的长度，结束时整个换回来
let sandbox: { world: World; past: World[]; future: World[] } | null = null;
let batchStart: World | null = null; // 拖动开始时的世界：拖动中第一次真的改了东西才把它记进撤销
let batchVisionBase: World | null = null; // 批量拖动期间整图视野/记忆只算一次，以这次开始时的世界为基准
let batchVisionDeferred = false;

// Outside undoable World snapshots: leaving an entity version permanently invalidates old advice.
const targetRevisions = new WeakMap<object, number>();
export const targetRevision = (target: object) => targetRevisions.get(target) ?? 0;
let revisionWorld = world;
function trackTargetChanges() {
  const nextMaps = new Map(world.maps.map(m => [m.id, m]));
  for (const before of revisionWorld.maps) {
    const next = nextMaps.get(before.id);
    for (const field of ['objects', 'tokens'] as const) {
      if (before[field] === next?.[field]) continue;
      const current = new Map<string, object>((next?.[field] ?? []).map(item => [item.id, item]));
      for (const item of before[field]) if (current.get(item.id) !== item)
        targetRevisions.set(item, targetRevision(item) + 1);
    }
  }
  revisionWorld = world;
}

function emit() {
  trackTargetChanges();
  setMediaIndex(world.media); // 媒体 ID → 存储名，跟着当前世界走
  listeners.forEach((l) => l());
  clearTimeout(saveTimer);
  if (sandbox) return; // 试玩期间不保存，免得把试玩状态存进去
  saveTimer = window.setTimeout(saveNow, 400);
}

/** 立刻把（真正的）世界存进这个标签页的自动保存槽。 */
export function saveNow() {
  clearTimeout(saveTimer);
  if (isPlayerWindow) return;
  if (!saveSlot('world', JSON.stringify(sandbox ? sandbox.world : world))) console.warn('自动保存失败：浏览器存储空间不够');
}
onSessionRenewed(saveNow); // 复制标签页后换了会话标识：在新槽里存一份

export const getWorld = () => world;
/** 这个标签页里所有还可能回到的世界：现在的、试玩前的、撤销 / 重做记录里的（清理媒体时一个都不能漏）。 */
export const reachableWorlds = (): World[] => [world, ...past, ...future, ...(sandbox ? [sandbox.world, ...sandbox.past, ...sandbox.future] : [])];
/**
 * 当前世界的"上下文编号"：换了工程（导入、恢复、新建、载入示例）或者进出试玩都会变。
 * 异步操作（导入、上传、播放）开始时记下它，完成时对不上就不再动世界——结果属于一个已经不在的上下文。
 */
let epoch = 0;
let projectEpoch = 0;
const projectListeners = new Set<() => void>();
export function onProjectReplaced(fn: () => void) { projectListeners.add(fn); return () => { projectListeners.delete(fn); }; }
export const projectContext = () => projectEpoch;
export const worldContext = () => `${epoch}${sandbox ? ':trial' : ''}`;
/** 真正的世界：试玩中是试玩开始前那份（发给玩家、保存都用它）。 */
export const getRealWorld = () => sandbox?.world ?? world;

/** 物件的状态每变一次，stateRev 加一（不管是谁改的）。流程图撤销靠它判断"之后有没有别人动过"。 */
function bumpStateRevs(prev: World, next: World) {
  const changed: [number, number][] = [];
  next.maps.forEach((m, mi) => {
    const pm = prev.maps.find((x) => x.id === m.id);
    if (!pm || pm.objects === m.objects) return;
    m.objects.forEach((o, oi) => { const po = pm.objects.find((x) => x.id === o.id); if (po && po.state !== o.state && (o.stateRev ?? 0) === (po.stateRev ?? 0)) changed.push([mi, oi]); });
  });
  if (!changed.length) return next;
  return produce(next, (d) => { for (const [mi, oi] of changed) { const o = d.maps[mi].objects[oi]; o.stateRev = (o.stateRev ?? 0) + 1; } });
}

function pushHistory(at: World = world) {
  past.push(at);
  if (past.length > 200) past.shift();
  future = [];
}

/**
 * 这次改动会不会影响「谁看见过什么」。不会就跳过整条记忆同步——
 * syncMemory 每个地图要扫 `宽×高×9` 个子格，还会按队员复制整层视野，
 * 以前连改个 NPC 名字、打个字都付这个代价。
 */

function memoryDirty(a: World, b: World): boolean {
  if (a.visionMode !== b.visionMode || partyVisionChanged(a, b) || a.terrains !== b.terrains) return true;
  if (a.maps.length !== b.maps.length) return true;
  for (const m of b.maps) {
    const o = a.maps.find((x) => x.id === m.id);
    if (!o) return true;
    // autoFog 关着的图，棋子移动不会改雾，也就不需要同步记忆；开着才要。
    const tokensDirty = m.autoFog && tokensVisionChanged(o.tokens, m.tokens);
    if (o.cells !== m.cells || o.fineCells !== m.fineCells || o.d100 !== m.d100 || o.objects !== m.objects || tokensDirty
      || o.architecture !== m.architecture || o.fog !== m.fog
      || o.views !== m.views || o.autoFog !== m.autoFog
      || o.materialCells !== m.materialCells || o.fineMaterials !== m.fineMaterials || o.groups !== m.groups) return true;
  }
  return false;
}


/** 批量拖到一半，手动改了 fog/views：先把之前欠的视野补上，再按非批量语义落这次手动雾。 */
function manualFogChanged(a: World, b: World): boolean {
  for (const m of b.maps) {
    const o = a.maps.find((x) => x.id === m.id);
    if (o && (o.fog !== m.fog || o.views !== m.views)) return true;
  }
  return false;
}

function markManualPending(next: World, pending: Set<string>) {
  for (const id of pending) {
    const m = next.maps.find((x) => x.id === id);
    if (m?.autoFog) markManualFog(m);
  }
}

/** 把批量里欠的视野/记忆从 batchVisionBase 补到当前 world，然后以补完的 world 为新基准。 */
function flushBatchVision() {
  if (!batching || !batchVisionBase || !batchVisionDeferred) return;
  const base = batchVisionBase;
  if (!Object.isFrozen(world)) freeze(world, true);
  const dirty = diffWorld(base, world);
  const plan = planVision(world, dirty);
  const manualPending = new Set<string>();
  const visioned = withVision(world, base, { plan, onManualPending: (id) => manualPending.add(id) });
  const memoryPlan = narrowTerrainMemoryPlan(base, visioned, plan, dirty);
  const next = produce(visioned, (d) => {
    if (memoryDirty(base, world)) syncMemory(d, memoryPlan);
  });
  markManualPending(next, manualPending);
  world = next;
  batchVisionBase = next;
  batchVisionDeferred = false;
}

function commitWorld(next: World, opts: { coalesce?: string; history?: boolean } = {}) {
  // 批量里先改地形、后手动画雾：若直接欠到松手，手动雾会被自动雾盖掉（和非批量顺序不一致）。
  // 先补上之前的视野，再以补完的世界重做这次手动雾修改。
  // 注意：next 已经是这次修改后的世界；这里只处理补算，不再重放 fn。
  // （手动雾 flush 需要重放 fn 的分支仍留在 update() 里，见下。）
  // 拖动中的整图视野/记忆先欠着：每次 pointermove 都全量重算 200×200 的 36 万子格，
  // 连续画一笔会按格子卡死。批量结束时从拖动起点的世界一次性补算，结果和不分批一样。
  // 只在「本来就要整图重算」时欠；纯棋子移动这类脏格很小的更新仍即时算。
  let deferred = !!batching && !!batchVisionBase && batchVisionDeferred;
  let manualPending = new Set<string>();
  if (!deferred) {
    const needMemory = memoryDirty(world, next);
    // 脏集只算一次：视野只写脏格，记忆也只同步脏格。
    const dirty = diffWorld(world, next);
    const plan = planVision(next, dirty);
    if (batching && batchVisionBase && (plan.full || plan.viewerScoped || (plan.memoryFullMaps?.size ?? 0) > 0 || (plan.materialOnlyMaps?.size ?? 0) > 0)) {
      deferred = true;
      batchVisionDeferred = true;
    } else {
      const visioned = withVision(next, world, { plan, onManualPending: (id) => manualPending.add(id) });
      const memoryPlan = narrowTerrainMemoryPlan(world, visioned, plan, dirty);
      next = produce(visioned, (d) => { if (needMemory) syncMemory(d, memoryPlan); });
    }
  }
  next = bumpStateRevs(world, next);
  // 被驱逐是「ME 归零」状态，ME 回到至少 1 点后自动解除；不论 ME 是怎么恢复的，
  // 都从这里统一收口，避免每个恢复入口各自记得清状态。
  let hasEndsStatus = false;
  for (const m of next.maps) for (const k of m.tokens) if (k.status?.endsWhenMePositive) { hasEndsStatus = true; break; }
  if (hasEndsStatus) {
    next = produce(next, (d) => {
      for (const m of d.maps) {
        for (const k of m.tokens) {
          if (!k.status?.endsWhenMePositive) continue;
          const pc = k.pcId ? d.party.find((x) => x.id === k.pcId) : undefined;
          if (pc && pc.me !== undefined && pc.me >= 1) {
            const label = k.status.label;
            delete k.status;
            d.log.push({ id: uid(), at: Date.now(), session: d.session, kind: 'note', text: `${k.name} ME 恢复到 ${pc.me}，解除${label}。` });
          }
        }
      }
    });
  }
  // syncMemory 在独立/分组模式会 clone fog 数组，withVision 里打的标记会落在旧数组上。
  // 标记必须跟着最终落盘的数组走，否则下一次视野脏动不会整图覆盖。
  for (const id of manualPending) {
    const m = next.maps.find((x) => x.id === id);
    if (m?.autoFog) markManualFog(m);
  }
  if (batching && batchStart) { pushHistory(batchStart); batchStart = null; } // 拖动里第一次真的改了东西，才记一步撤销
  else if (!batching && opts.history !== false) {
    const now = Date.now();
    const merge = opts.coalesce && lastCoalesce && lastCoalesce.key === opts.coalesce && now - lastCoalesce.at < 1000;
    if (!merge) pushHistory();
    lastCoalesce = opts.coalesce ? { key: opts.coalesce, at: now } : null;
  }
  world = next;
  emit();
}

/**
 * 修改世界。coalesce：同一个 key 在 1 秒内的连续修改合并成一步撤销（用于打字）。
 */
export function update(fn: (d: Draft<World>) => void, opts: { coalesce?: string; history?: boolean } = {}) {
  // NPC 血条每次改世界都归一：会话里直接 update 出来的 hpMax 0/负数、倒地缺 hp 不留在存档里。
  // 必须在同一个 produce 里做：produce 返回的对象是冻结的，出去再改会静默失败。
  let next = produce(world, (d) => { fn(d); normalizeNpcHp(d as unknown as World); });
  if (next === world) return;
  // 批量里先改地形、后手动画雾：若直接欠到松手，手动雾会被自动雾盖掉（和非批量顺序不一致）。
  // 先补上之前的视野，再以补完的世界重做这次手动雾修改。
  if (batching && batchVisionBase && batchVisionDeferred && manualFogChanged(world, next)) {
    flushBatchVision();
    next = produce(world, (d) => { fn(d); normalizeNpcHp(d as unknown as World); });
    if (next === world) return;
  }
  // Component edits (material/physical/openStates/state lists) obey the same close policy.
  for (const m of next.maps) {
    const before = world.maps.find(p => p.id === m.id);
    if (!before || before.objects === m.objects) continue;
    const error = architectureTransitionError(before, m);
    if (error) { toast(error); return; }
  }
  commitWorld(next, opts);
}

/** 材质专用快速路径：只浅拷贝 materialCells/fineMaterials 两个对象，不经 Immer 代理。 */
export function updateMaterialFast(mapId: string, mutate: (m: Draft<GameMap>) => void) {
  const idx = world.maps.findIndex((m) => m.id === mapId);
  if (idx < 0) return;
  const baseMap = world.maps[idx];
  const nextMap = {
    ...baseMap,
    materialCells: { ...(baseMap.materialCells ?? {}) },
    fineMaterials: { ...(baseMap.fineMaterials ?? {}) },
  } as GameMap;
  mutate(nextMap as unknown as Draft<GameMap>);
  const sameMap = (a?: Record<number, string>, b?: Record<number, string>) => {
    const aa = a ?? {}, bb = b ?? {};
    const keys = new Set([...Object.keys(aa), ...Object.keys(bb)]);
    for (const k of keys) if (aa[+k] !== bb[+k]) return false;
    return true;
  };
  if (sameMap(baseMap.materialCells, nextMap.materialCells) && sameMap(baseMap.fineMaterials, nextMap.fineMaterials)) return;
  const maps = world.maps.slice();
  maps[idx] = nextMap;
  const next = { ...world, maps };
  if (!(batching && batchVisionBase)) freeze(next, true);
  commitWorld(next);
}

/**
 * 地形/小格专用快速路径：只浅拷贝受影响的地图和 cells/fineCells 两个数组，
 * 不经过 Immer 对 200×200 的 36 万小格做整份代理。管线与 update() 完全共用。
 */
export function updateTerrainFast(mapId: string, mutate: (m: Draft<GameMap>) => void) {
  const idx = world.maps.findIndex((m) => m.id === mapId);
  if (idx < 0) return;
  const baseMap = world.maps[idx];
  // 只复制会改的两个数组；tokens/objects/views 等保持原引用。
  const nextMap = {
    ...baseMap,
    cells: baseMap.cells.slice(),
    fineCells: baseMap.fineCells.slice(),
  } as GameMap;
  mutate(nextMap as unknown as Draft<GameMap>);
  // 同一种地形再点一次不该多一步撤销、也不该白跑视野。
  let changed = false;
  for (let i = 0; i < baseMap.cells.length; i++) if (nextMap.cells[i] !== baseMap.cells[i]) { changed = true; break; }
  if (!changed) for (let i = 0; i < baseMap.fineCells.length; i++) if (nextMap.fineCells[i] !== baseMap.fineCells[i]) { changed = true; break; }
  if (!changed) return;
  const maps = world.maps.slice();
  maps[idx] = nextMap;
  const next = { ...world, maps };
  if (next === world) return;
  // 拖动画笔时这一帧的视野/记忆本来就欠着，不必为它会话冻结整张图；
  // 非批量单笔才冻结新对象图，避免 Immer 对未冻结的 36 万格世界退化成整份代理。
  if (!(batching && batchVisionBase)) freeze(next, true);
  commitWorld(next);
}

/** 拖动开始时调用：整次拖动只占一步撤销。只是点一下、没拖动，撤销和重做记录都不碰。 */
export function beginBatch() {
  if (batching) return;
  batchStart = world;
  batchVisionBase = world;
  batchVisionDeferred = false;
  batching = true;
  lastCoalesce = null;
}
export function endBatch() {
  if (!batching) return;
  batching = false;
  batchStart = null;
  const base = batchVisionBase;
  batchVisionBase = null;
  if (base && batchVisionDeferred && world !== base) {
    // 局部画笔的快速路径在拖动中故意不冻结，这里补一次，避免整份 Immer 代理。
    if (!Object.isFrozen(world)) freeze(world, true);
    const dirty = diffWorld(base, world);
    const plan = planVision(world, dirty);
    const manualPending = new Set<string>();
    const visioned = withVision(world, base, { plan, onManualPending: (id) => manualPending.add(id) });
    const memoryPlan = narrowTerrainMemoryPlan(base, visioned, plan, dirty);
    const next = produce(visioned, (d) => {
      if (memoryDirty(base, world)) syncMemory(d, memoryPlan);
    });
    markManualPending(next, manualPending);
    world = next;
    emit();
  }
  batchVisionDeferred = false;
}

export function undo() {
  // 试玩里不许撤销：世界会退回去，但事件账本和日志已经写死了，屏幕和日志会打架。
  if (sandbox) { toast('试玩里不能撤销（退出试玩后再改）'); return; }
  const prev = past.pop();
  if (!prev) return;
  // 欠视野的世界不能进 redo 栈：否则 redo 会把未补视野的快照当成 base，松手也不补。
  if (batching && batchVisionDeferred) flushBatchVision();
  future.push(world);
  world = prev;
  if (batching) {
    batchStart = world; // 拖动中途撤销：之后接着拖的部分算新的一步（从撤销后的样子开始）
    batchVisionBase = world; // 撤销快照自带视野，不能再拿被撤掉前的基础去补
    batchVisionDeferred = false;
  }
  lastCoalesce = null;
  emit();
}
export function redo() {
  if (sandbox) { toast('试玩里不能重做（退出试玩后再改）'); return; }
  const next = future.pop();
  if (!next) return;
  if (batching && batchVisionDeferred) flushBatchVision();
  past.push(world);
  world = next;
  if (batching) {
    batchStart = world;
    batchVisionBase = world;
    batchVisionDeferred = false;
  }
  lastCoalesce = null;
  emit();
}

export function replaceWorld(w: World) {
  epoch++; projectEpoch++;
  projectListeners.forEach(fn => fn());
  past = [];
  future = [];
  batching = false;
  batchStart = null;
  batchVisionBase = null;
  batchVisionDeferred = false;
  lastCoalesce = null; // 换了世界，上一个世界的"连续打字合并"不能延续
  world = produce(withVision(migrateWorld(w), { ...w, maps: [] }), syncMemory);
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useWorld = () => useSyncExternalStore(subscribe, getWorld);

// ---------- 界面状态（不进历史、不保存） ----------

export type Tool =
  | 'select' | 'pan' | 'paint' | 'fill' | 'erase' | 'object' | 'zone' | 'conn' | 'token'
  | 'wall' | 'glass' | 'archDoor' | 'archErase'
  | 'd100' | 'room' | 'fogReveal' | 'fogHide' | 'fogBlack'
  /** 高度：单格抬高。左键 +1，Shift +左键 −1，拖动连续。 */
  | 'heightBrush'
  /** 高度：拖矩形设整片高度。 */
  | 'heightRect'
  /** 分组贴图：往当前组的任意小格上涂/擦（视觉层，不改规则）。 */
  | 'groupPaint';

export type Selection =
  | { type: 'object'; mapId: string; id: string }
  | { type: 'token'; mapId: string; id: string }
  | { type: 'conn'; id: string }
  | { type: 'cell'; mapId: string; x: number; y: number }
  | null;

export type Mode = 'edit' | 'prep' | 'run';
export type Tab = 'inspect' | 'log' | 'party' | 'npc' | 'media';

export interface View { zoom: number; panX: number; panY: number }

export interface UIState {
  mode: 'edit' | 'prep' | 'run';
  mapId: string;
  tool: Tool;
  terrainId: string;
  materialId: string;
  paintLayer: 'terrain' | 'material'; // 画笔/矩形/橡皮写哪一层
  roomId: string; // 房间笔刷：'' = 擦掉房间
  /** 高度工具：框选出来的矩形，松手后留在这里，等侧栏输入数值再应用。 */
  heightRect?: { mapId: string; x0: number; y0: number; x1: number; y1: number } | null;
  /** 高度工具用的目标高度，侧栏输入框绑这个。 */
  heightValue?: number;
  brush: number;
  wallThickness: number;
  doorWidth: number;
  selection: Selection;
  /** 当前要画的贴图组（编辑地图用；不跨图持久化）。 */
  groupId: string | null;
  views: Record<string, View>;
  pendingConn: { mapId: string; x: number; y: number } | null;
  pick: { mapId: string; x: number; y: number } | null; // 最近一次点的格子（一格多物时列出来）
  unlock: boolean; // 备团/带团时临时解锁上一级的编辑（兜底保险）
  diskTarget: string | null; // 用命令行带文件启动时，⌘S 存回的路径
  trial: {
    mapId: string;
    /** paused：见证者暂停了这个玩家的操作（防止一个人把全场的骰子都掷了）。 */
    players: { tokenId: string; pcId: string; name: string; paused?: boolean }[];
    current: number;
    /** 这一整轮已经结束过回合的棋子；所有人都结束过才结算状态、进下一轮。 */
    ended?: Record<string, boolean>;
    combat: boolean; // 战斗模式：每回合 5 格；不开就是不限步数
    /** 每回合已经用掉的移动点数（按细分格记的老口径，保留给界面显示）。 */
    moved: Record<string, number>;
    /**
     * 这一回合还剩多少移动点数。回合开始时重置成角色的总移动点数。
     * 走一格扣当前跑法/姿态的单价；起身扣 150，翻身扣 75。
     */
    movePoints?: Record<string, number>;
    /** 蓄力进度：移动力够高的人每回合攒一点，攒满多一格。用完才重新蓄。 */
    charge?: Record<string, { progress: number; cells: number }>;
    /**
     * 下面这几个都按 tokenId 记：一场试玩里可能有两个人轮流动，
     * 「全队一份」会让 A 攻击完 B 也不能攻击（切角色串味）。
     */
    /** 这一回合按的跑法。没这一项＝正常走。 */
    runMode?: Record<string, 'jog' | 'run' | 'sprint' | null>;
    /** 这一回合已经拐了几次弯。奔跑只准拐一次，爆跑一次都不准。 */
    runTurns?: Record<string, number>;
    turned?: Record<string, boolean>; // 本回合已经原地转身过的棋子（缠斗限制用）
    acted?: Record<string, boolean>; // 这一回合的行动点已经用掉（攻击/技能）
    /** 这次攻击用锐器（默认钝器）。只有身上带锐器的角色才勾得动。 */
    sharpAttack?: Record<string, boolean>;
    /** 借机攻击提示：这一步触发了，等主持人决定打不打。 */
    opportunity?: { moverTokenId: string; enemies: string[]; from: { x: number; y: number }; to: { x: number; y: number } } | null;
    /** 刚发生的大事（攻击、伤害、濒死）：单独一张大卡片显示，不塞进底部小字。 */
    /** 刚发生的大事（攻击、伤害、濒死）：这里跟 `CombatNotice` 是同一个形状，少一个「我是哪一方」。 */
    event?: Omit<CombatNotice, 'id' | 'role'> | null;
    /** 最近一次感知判定的结果。见证者据此决定给什么信息。 */
    sense?: { kind: SenseKind; roll: SenseRoll; hints: SenseHint[]; at: number } | null;
    turn: number;
    msg: string;
    markSymbol: string;
    markText: string;
    markMode: boolean; // 放标记状态：G 键或按钮进入，点一下地图放下
  } | null; // 试玩
  /** 开出来等玩家掷的判定；同一时间只开一个。 */
  pendingJudgment: PendingJudgment | null;
  /** 开出来等玩家输密码的电子锁；同一时间只开一个。 */
  pendingCode: PendingCodeAttempt | null;
  /** 玩家窗口掷完回传的结果，等见证者确认后广播。 */
  /** 前面是坑，等玩家再按一次同方向确认起跳。 */
  pendingGap: { tokenId: string; dx: number; dy: number } | null;
  /**
   * 玩家掷完的结果。judgmentId 标明它属于哪一笔判定——没有这个字段的时候，
   * 取消一笔再开一笔，上一颗骰子会被当成新判定的结果。
   * value 是采信的那一颗；优势/劣势掷两颗时 values 记着两颗（单骰就只有一颗）。
   */
  judgmentResult: { judgmentId: string; title: string; sides: number; value: number; values?: number[]; tens: number | null; units: number | null; material: string; seed: number; rollId: string; byStandIn: boolean } | null;
  flowId: string | null;
  connKind: 'stairs' | 'portal' | 'door' | 'other';
  tokenPcId: string | null;
  knowledgeTarget: string; // 空字符串=全队，否则为角色有效组
  tab: Tab;
  showFogInEdit: boolean;
  showNumbers: boolean;
  showRulers: boolean;
  fine: boolean; // 小格画笔：落点按 1/3 格吸附
  showSubgrid: boolean;
  toast: string | null;
  focus?: import('./types').Focus | null; // 统一暂停：战斗/技能/对话
  cast?: import('./types').SkillCast | null; // 技能发动状态机
  privateNote: { to: string; title: string; text: string } | null;
  nowPlaying: { mediaId: string; label: string; broadcast: boolean } | null;
}

let ui: UIState = {
  mode: 'edit',
  mapId: world.maps[0]?.id ?? '',
  tool: 'select',
  terrainId: 'floor',
  materialId: 'wood',
  paintLayer: 'terrain',
  roomId: '',
  brush: 1,
  wallThickness: 100,
  doorWidth: 3,
  selection: null,
  groupId: null,
  views: {},
  pendingConn: null,
  pendingJudgment: null,
  pendingCode: null,
  pendingGap: null,
  judgmentResult: null,
  pick: null,
  trial: null,
  diskTarget: null,
  unlock: false,
  flowId: null,
  connKind: 'stairs',
  tokenPcId: null,
  knowledgeTarget: '',
  tab: 'inspect',
  showFogInEdit: false,
  fine: false,
  focus: null,
  cast: null,
  showNumbers: false,
  showRulers: true,
  showSubgrid: (() => { try { return localStorage.getItem('ts-map-show-subgrid') === 'true'; } catch { return false; } })(),
  toast: null,
  privateNote: null,
  nowPlaying: null,
};
const uiListeners = new Set<() => void>();
export const getUI = () => ui;
export function setUI(patch: Partial<UIState> | ((s: UIState) => Partial<UIState>)) {
  ui = { ...ui, ...(typeof patch === 'function' ? patch(ui) : patch) };
  try { localStorage.setItem('ts-map-show-subgrid', String(ui.showSubgrid)); } catch { /* 显示偏好存不了时仍可使用 */ }
  uiListeners.forEach((l) => l());
}
const uiSubscribe = (l: () => void) => {
  uiListeners.add(l);
  return () => uiListeners.delete(l);
};
export const useUI = () => useSyncExternalStore(uiSubscribe, getUI);

let toastTimer: number | undefined;
export function toast(msg: string) {
  setUI({ toast: msg });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setUI({ toast: null }), 3000);
}

// 权限：每一级默认只能改自己这一级，上一级只读；unlock 一键放开。
export const canEditMap = (s: UIState) => s.mode === 'edit' || s.unlock;
export const canEditLines = (s: UIState) => s.mode === 'prep' || (s.mode === 'run' && s.unlock);

export function beginSandbox() {
  endBatch(); // 万一还有没收尾的拖动
  if (!sandbox) { sandbox = { world, past: [...past], future: [...future] }; epoch++; }
}
export function endSandbox() {
  if (!sandbox) return;
  world = sandbox.world;
  past = sandbox.past; // 完整还回试玩前的撤销/重做记录（试玩中被挤掉的、被撤销掉的都回来）
  future = sandbox.future;
  sandbox = null;
  epoch++;
  batching = false;
  batchStart = null;
  batchVisionBase = null;
  batchVisionDeferred = false;
  lastCoalesce = null;
  emit();
}
