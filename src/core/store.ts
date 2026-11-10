import { architectureTransitionError } from '../scene/architecture';
import { produce, type Draft } from 'immer';
import { useSyncExternalStore } from 'react';
import type { SenseHint, SenseKind, SenseRoll } from '../rules/sense';
import type { PendingJudgment, World } from './types';
import { demoWorld, emptyWorld } from './defaults';
import { isPlayerEntry } from './deployment';
import { migrateWorld, syncMemory } from '../scene/memory';
import { setMediaIndex } from '../runtime/media';
import { withVision } from '../scene/perception';
import { loadSlot, saveSlot } from './persist';
import { onSessionRenewed } from './session';

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
world = produce(withVision(world, { ...world, maps: [] }, 'rulebook'), syncMemory);
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
 * 修改世界。coalesce：同一个 key 在 1 秒内的连续修改合并成一步撤销（用于打字）。
 */
export function update(fn: (d: Draft<World>) => void, opts: { coalesce?: string; history?: boolean } = {}) {
  let next = produce(world, fn);
  if (next === world) return;
  // Component edits (material/physical/openStates/state lists) obey the same close policy.
  for (const m of next.maps) {
    const before = world.maps.find(p => p.id === m.id);
    if (!before || before.objects === m.objects) continue;
    const error = architectureTransitionError(before, m);
    if (error) { toast(error); return; }
  }
  next = produce(withVision(next, world, ui.visionAlgo), syncMemory);
  next = bumpStateRevs(world, next);
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

/** 拖动开始时调用：整次拖动只占一步撤销。只是点一下、没拖动，撤销和重做记录都不碰。 */
export function beginBatch() {
  if (batching) return;
  batchStart = world;
  batching = true;
  lastCoalesce = null;
}
export function endBatch() {
  batching = false;
  batchStart = null;
}

export function undo() {
  const prev = past.pop();
  if (!prev) return;
  future.push(world);
  world = prev;
  if (batching) batchStart = world; // 拖动中途撤销：之后接着拖的部分算新的一步（从撤销后的样子开始）
  lastCoalesce = null;
  emit();
}
export function redo() {
  const next = future.pop();
  if (!next) return;
  past.push(world);
  world = next;
  if (batching) batchStart = world;
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
  lastCoalesce = null; // 换了世界，上一个世界的"连续打字合并"不能延续
  world = produce(withVision(migrateWorld(w), { ...w, maps: [] }, ui.visionAlgo), syncMemory);
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
  | 'subdivide' | 'unsubdivide' | 'wall' | 'glass' | 'archDoor' | 'archErase'
  | 'd100' | 'room' | 'fogReveal' | 'fogHide' | 'fogBlack'
  /** 高度：单格抬高。左键 +1，Shift +左键 −1，拖动连续。 */
  | 'heightBrush'
  /** 高度：拖矩形设整片高度。 */
  | 'heightRect';

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
    /** 这一回合按的跑法。没写＝正常走。 */
    runMode?: 'jog' | 'run' | 'sprint' | null;
    /** 这一回合已经拐了几次弯。奔跑只准拐一次，爆跑一次都不准。 */
    runTurns?: number;
    turned?: Record<string, boolean>; // 本回合已经原地转身过的棋子（缠斗限制用）
    acted?: boolean; // 这一回合的行动点已经用掉（攻击/技能）
    /** 这次攻击用锐器（默认钝器）。只有身上带锐器的角色才勾得动。 */
    sharpAttack?: boolean;
    /** 借机攻击提示：这一步触发了，等主持人决定打不打。 */
    opportunity?: { moverTokenId: string; enemies: string[]; from: { x: number; y: number }; to: { x: number; y: number } } | null;
    /** 刚发生的大事（攻击、伤害、濒死）：单独一张大卡片显示，不塞进底部小字。 */
    event?: {
      kind: 'hit' | 'miss';
      attackerPcId: string | null;
      attackerName: string;
      targetPcId: string | null;
      targetName: string;
      roll: number; // D100，100 表示 00
      crit: boolean; // 特大成功
      damage: number;
      hpBefore: number | null;
      hpAfter: number | null;
      hpMax: number | null;
      /** 倒地走向：钝器打晕是「昏厥」，锐器是「濒死」。 */
      downed?: 'down' | 'dying' | null;
      note?: string;
      at: number;
    } | null;
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
  /** 玩家窗口掷完回传的结果，等见证者确认后广播。 */
  /** 前面是坑，等玩家再按一次同方向确认起跳。 */
  pendingGap: { tokenId: string; dx: number; dy: number } | null;
  judgmentResult: { id: string; title: string; sides: number; value: number; tens: number | null; units: number | null; material: string; seed: number; rollId: string; byStandIn: boolean } | null;
  flowId: string | null;
  connKind: 'stairs' | 'portal' | 'door' | 'other';
  tokenPcId: string | null;
  knowledgeTarget: string; // 空字符串=全队，否则为角色有效组
  tab: Tab;
  showFogInEdit: boolean;
  visionAlgo: 'legacy' | 'rulebook'; // 视野算法：规则书（默认）或老口径，留作对照用
  showNumbers: boolean;
  showRulers: boolean;
  fine: boolean; // 小格画笔：落点按 1/3 格吸附，落点自动细分
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
  views: {},
  pendingConn: null,
  pendingJudgment: null,
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
  visionAlgo: 'rulebook',
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
  lastCoalesce = null;
  emit();
}
