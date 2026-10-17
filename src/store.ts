import { produce, type Draft } from 'immer';
import { useSyncExternalStore } from 'react';
import type { World } from './types';
import { demoWorld } from './defaults';
import { migrateWorld, syncMemory } from './memory';
import { withVision } from './perception';

const SAVE_KEY = 'ts-map-world-v1';

/** 浏览器允不允许本页保存数据。 */
export const storageOK = (() => {
  try { localStorage.setItem('ts-probe', '1'); localStorage.removeItem('ts-probe'); return true; } catch { return false; }
})();

function load(): World | null {
  try {
    const s = localStorage.getItem(SAVE_KEY);
    return s ? migrateWorld(JSON.parse(s) as World) : null;
  } catch {
    return null;
  }
}

// ---------- 世界（有撤销历史，自动保存） ----------

let world: World = load() ?? demoWorld();
world = produce(withVision(world, { ...world, maps: [] }), syncMemory);
let past: World[] = [];
let future: World[] = [];
let batching = false;
let lastCoalesce: { key: string; at: number } | null = null;
const listeners = new Set<() => void>();
let saveTimer: number | undefined;
// 沙盒（试玩）：开始时记下世界和撤销记录的长度，结束时整个换回来
let sandbox: { world: World; past: World[]; future: World[] } | null = null;
let batchFuture: World[] | null = null; // 拖动开始前的重做记录：拖动没改东西就还回去

function emit() {
  listeners.forEach((l) => l());
  clearTimeout(saveTimer);
  if (sandbox) return; // 试玩期间不保存，免得把试玩状态存进去
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(world));
    } catch (e) {
      console.warn('自动保存失败', e);
    }
  }, 400);
}

export const getWorld = () => world;

function pushHistory() {
  past.push(world);
  if (past.length > 200) past.shift();
  future = [];
}

/**
 * 修改世界。coalesce：同一个 key 在 1 秒内的连续修改合并成一步撤销（用于打字）。
 */
export function update(fn: (d: Draft<World>) => void, opts: { coalesce?: string; history?: boolean } = {}) {
  let next = produce(world, fn);
  if (next === world) return;
  next = produce(withVision(next, world), syncMemory);
  if (!batching && opts.history !== false) {
    const now = Date.now();
    const merge = opts.coalesce && lastCoalesce && lastCoalesce.key === opts.coalesce && now - lastCoalesce.at < 1000;
    if (!merge) pushHistory();
    lastCoalesce = opts.coalesce ? { key: opts.coalesce, at: now } : null;
  }
  world = next;
  emit();
}

/** 拖动开始时调用：整次拖动只占一步撤销。 */
export function beginBatch() {
  if (batching) return;
  batchFuture = future;
  pushHistory();
  batching = true;
  lastCoalesce = null;
}
export function endBatch() {
  if (!batching) return;
  batching = false;
  if (past[past.length - 1] === world) { past.pop(); if (batchFuture) future = batchFuture; } // 只是点了一下，没拖：撤销和重做都原样
  batchFuture = null;
}

export function undo() {
  const prev = past.pop();
  if (!prev) return;
  future.push(world);
  world = prev;
  lastCoalesce = null;
  emit();
}
export function redo() {
  const next = future.pop();
  if (!next) return;
  past.push(world);
  world = next;
  lastCoalesce = null;
  emit();
}

export function replaceWorld(w: World) {
  past = [];
  future = [];
  world = w;
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useWorld = () => useSyncExternalStore(subscribe, getWorld);

// ---------- 界面状态（不进历史、不保存） ----------

export type Tool =
  | 'select' | 'paint' | 'fill' | 'erase' | 'object' | 'zone' | 'conn' | 'token'
  | 'd100' | 'room' | 'fogReveal' | 'fogHide' | 'fogBlack';

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
  roomId: string; // 房间笔刷：'' = 擦掉房间
  brush: number;
  selection: Selection;
  views: Record<string, View>;
  pendingConn: { mapId: string; x: number; y: number } | null;
  pick: { mapId: string; x: number; y: number } | null; // 最近一次点的格子（一格多物时列出来）
  unlock: boolean; // 备团/带团时临时解锁上一级的编辑（兜底保险）
  diskTarget: string | null; // 用命令行带文件启动时，⌘S 存回的路径
  trial: {
    mapId: string;
    players: { tokenId: string; pcId: string; name: string }[];
    current: number;
    combat: boolean; // 战斗模式：每回合 5 格；不开就是不限步数
    moved: Record<string, number>;
    turn: number;
    msg: string;
    markSymbol: string;
    markText: string;
    markMode: boolean; // 放标记状态：G 键或按钮进入，点一下地图放下
  } | null; // 试玩
  flowId: string | null;
  connKind: 'stairs' | 'portal' | 'door' | 'other';
  tokenPcId: string | null;
  tab: Tab;
  showFogInEdit: boolean;
  showNumbers: boolean;
  showRulers: boolean;
  toast: string | null;
  privateNote: { to: string; title: string; text: string } | null;
  nowPlaying: { mediaId: string; label: string; broadcast: boolean } | null;
}

let ui: UIState = {
  mode: 'edit',
  mapId: world.maps[0]?.id ?? '',
  tool: 'select',
  terrainId: 'floor',
  roomId: '',
  brush: 1,
  selection: null,
  views: {},
  pendingConn: null,
  pick: null,
  trial: null,
  diskTarget: null,
  unlock: false,
  flowId: null,
  connKind: 'stairs',
  tokenPcId: null,
  tab: 'inspect',
  showFogInEdit: false,
  showNumbers: false,
  showRulers: true,
  toast: null,
  privateNote: null,
  nowPlaying: null,
};
const uiListeners = new Set<() => void>();
export const getUI = () => ui;
export function setUI(patch: Partial<UIState> | ((s: UIState) => Partial<UIState>)) {
  ui = { ...ui, ...(typeof patch === 'function' ? patch(ui) : patch) };
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
  if (!sandbox) sandbox = { world, past: [...past], future: [...future] };
}
export function endSandbox() {
  if (!sandbox) return;
  world = sandbox.world;
  past = sandbox.past; // 完整还回试玩前的撤销/重做记录（试玩中被挤掉的、被撤销掉的都回来）
  future = sandbox.future;
  sandbox = null;
  lastCoalesce = null;
  emit();
}
