import { objectEnabled } from './objectData.js';
import { isArchitectureObject, clipArchitecture, fogAt, tokenPosition } from './architecture';
import { anyVisible } from './memory';
import type { Endpoint, GameMap, PlayerClue, VisionLayer, World } from './types';
import { visibleMarks } from './perception';
import { numbering } from './render';
import { getRealWorld, getUI, saveNow } from './store';
import { SESSION, rand, renewSession } from './session';
import { effectiveLayer, emptyVision } from './vision';
import { onProjectReplaced, projectContext } from './store';

// 主持人窗口 ↔ 玩家窗口。玩家窗口用来共享屏幕给玩家（第一阶段还没有联网，靠共享屏幕）。
// world / 播放仅通过已绑定窗口的 postMessage 定向发送。
// 公共 BroadcastChannel 只传会话占用与存活，不传 world、角色或绑定凭据。

export type SyncBody =
  | { type: 'world'; world: World }
  | { type: 'hello'; binding?: string }
  | { type: 'clear' }
  | { type: 'play'; mediaId: string; label: string; mime: string; blob?: Blob }
  | { type: 'stop' }
  | { type: 'claim' } // 编辑器启动时：这个会话标识有人在用吗？
  | { type: 'taken' } // 回答：在用（复制标签页时会碰上），换一个
  | { type: 'alive' }; // 编辑器每两秒报一声"我还在"：玩家窗口靠它判断原来那个编辑器是不是已经关了 / 刷新了
/** from：发送方的会话；to：只给某个会话（玩家窗口打招呼时用）。 */
/** inst / born：发送的是哪个页面实例、什么时候打开的（同一个会话标识出现在两个实例上时，后打开的让）。 */
export type SyncMsg = SyncBody & { __ts: 'ts-map'; seq: string; from: string; to?: string; inst: string; born: number };

export { SESSION };
const INST = rand(); // 这个页面实例（刷新就是新的实例，但会话标识不变）
const BORN = Date.now();
let channel: BroadcastChannel | null = null;
try { channel = new BroadcastChannel('ts-map-sync'); } catch { /* 不支持就只走 postMessage */ }

// Binding is held only by the host; the URL carries an opaque reconnect capability, never a selectable pcId.
const players = new Map<string, { win: Window | null; pcId: string; context: number }>();
const bindingsKey = () => `ts-player-bindings-${SESSION}`;
try {
  const saved = JSON.parse(sessionStorage.getItem(bindingsKey()) ?? '{}') as Record<string, string>;
  for (const [binding, pcId] of Object.entries(saved)) if (typeof pcId === 'string') players.set(binding, { win: null, pcId, context: projectContext() });
} catch { /* no reconnect state */ }
function saveBindings() {
  try { sessionStorage.setItem(bindingsKey(), JSON.stringify(Object.fromEntries([...players].map(([key, p]) => [key, p.pcId])))); } catch { /* unavailable */ }
}
export function openPlayerWindow(pcId?: string) {
  const w = getRealWorld(), id = pcId ?? w.party[0]?.id;
  if (!id || !w.party.some(p => p.id === id)) return;
  const binding = rand();
  const win = window.open(`?view=player&session=${SESSION}&binding=${binding}`, `ts-player-${binding}`, 'width=1280,height=800');
  if (win) { players.set(binding, { win, pcId: id, context: projectContext() }); saveBindings(); }
}

const isMsg = (d: unknown): d is SyncMsg => !!d && typeof d === 'object' && (d as SyncMsg).__ts === 'ts-map' && typeof (d as SyncMsg).from === 'string' && typeof (d as SyncMsg).inst === 'string' && typeof (d as SyncMsg).born === 'number';

/**
 * 发给玩家窗口的"玩家版"世界：主持人才能看的东西在发出去之前就删掉，而不只是不画。
 * 只留推给玩家的那一张图，而且只留"有人看得见"或"有人记得"的部分：
 * - 地形：现在有人看得见的格子才带实时地形；灰区靠各人的记忆（seen）画，黑区什么都没有；地形定义也只带用得上的；
 * - 物件：没隐藏、现在有人看得见的才带，备注、挂的媒体、线索删掉，其他状态的名字也删掉（只留当前这个）；
 *   记忆里的物件只留至少还有一格在灰区或看得见的（抹黑了的就不带）；
 * - 棋子：绑定角色自己始终保留，其他角色仅当前可见时保留；
 * - 连接点：没隐藏、这一头有人看得见的才带；另一头只在那张图去过时留下图的 ID，坐标一律不带；
 * - 线索：全队公开过的单独列在 clues 里（只带揭示到的那一档）；
 * - 标记：谁能看到（听得见）在完整的世界里算好，写进 audience（玩家窗口没有完整地形，自己算会算错）；
 * - 房间、D100、出生点、备注、流程图、记录、NPC、媒体列表都不带。
 * 编号（O/Z/T/C）在删之前按完整的世界算好放进 labels，所以玩家和主持人看到的编号一样。
 */
export function playerWorld(w: World, mapId: string | null = w.playerMapId, pcId?: string): World {
  const valid = pcId ? w.party.some(p => p.id === pcId) : w.visionMode === 'shared';
  const layer = (m: GameMap) => !valid ? emptyVision(m.width * m.height) : pcId ? effectiveLayer(w, m, pcId) : m;
  const src = w.maps.find((m) => m.id === mapId);
  const pm = src && playerMap(src, layer(src), pcId);
  const known = (id: string) => { const m = w.maps.find((x) => x.id === id); return !!m && layer(m).fog.some(Boolean); };
  const hidden = { mapId: '', x: 0, y: 0 };
  const connections = !src ? [] : w.connections.flatMap((c) => {
    if (c.hidden) return [];
    const show = (e: Endpoint) => e.mapId === src.id && fogAt(src, layer(src), e.x + .5, e.y + .5) === 1;
    if (!show(c.a) && !show(c.b)) return [];
    const far = (e: Endpoint) => (show(e) ? e : e.mapId !== src.id && known(e.mapId) ? { mapId: e.mapId, x: 0, y: 0 } : hidden);
    return [{ ...c, a: far(c.a), b: far(c.b) }];
  });
  // 编号表也只带玩家碰得到的东西（发出去的、记得的），不然从编号的空缺能数出有几个隐藏物件
  const keep = new Set<string>([
    ...(pm ? [...pm.objects, ...pm.tokens, ...pm.seen.objects, ...Object.values(pm.views).flatMap((L) => L.seen.objects)].map((x) => x.id) : []),
    ...connections.map((c) => c.id),
  ]);
  const labels: Record<string, string> = {};
  if (src) numbering(w, src).forEach((n) => { if (keep.has(n.id)) labels[n.id] = n.label; });
  const usedTerrains = new Set(pm ? [...pm.cells, ...pm.seen.cells, ...Object.values(pm.views).flatMap((L) => L.seen.cells)] : []);
  const clues: PlayerClue[] = valid ? w.maps.flatMap(m => m.objects.flatMap(o => o.secrets.flatMap(s => {
    const r = s.revealed;
    const manual = r && (r.scope === 'party' || pcId && (r.recipients ? r.recipients.includes(pcId) : r.to === w.party.find(p => p.id === pcId)?.name)) ? r : undefined;
    const known = manual ?? (pcId ? s.discoveries?.[pcId] : undefined);
    return known ? [{ id: s.id, object: o.name, label: s.label, kind: s.kind, check: s.check, tier: known.tier, text: s.tiers[known.tier], at: known.at }] : [];
  }))) : [];
  const marks = valid && pcId ? visibleMarks(w, mapId ?? '', pcId).map(k => ({ ...k, audience: [pcId] })) : valid ? w.marks.filter(k => k.mapId === mapId) : [];
  return {
    ...w,
    visionGroups: undefined, observationSeq: undefined, viewerId: pcId,
    party: pcId ? w.party.filter(p => p.id === pcId).map(p => ({ id: p.id, name: p.name, tags: [], color: p.color })) : [],
    terrains: w.terrains.filter((t) => usedTerrains.has(t.id)),
    flows: [], log: [], npcs: [], media: [],
    labels, clues, marks, connections,
    maps: pm ? [pm] : [],
  };
}

/** Only the bound role's live cells and memory leave the host. */
export function playerMap(m: GameMap, L: VisionLayer, pcId?: string): GameMap {
  const seen = {
    cells: L.seen.cells.map((c, i) => L.fog[i] ? c : ''),
    objects: L.seen.objects.filter(r => {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (L.fog[y * m.width + x]) return true;
      return false;
    }),
    architecture: [...clipArchitecture(m, L, 1, L.seen.architecture ?? []), ...clipArchitecture(m, L, 2, L.seen.architecture ?? [])],
    subCells: Object.fromEntries(Object.entries(L.seen.subCells ?? {}).filter(([key]) => L.subFog?.[+key])),
  };
  return {
    id: m.id, name: m.name, layer: m.layer, floor: m.floor, width: m.width, height: m.height,
    fog: [...L.fog], subFog: { ...L.subFog }, seen, views: {}, autoFog: false,
    architectureFragments: clipArchitecture(m, L),
    subdivisions: m.subdivisions?.filter(i => L.fog[i]),
    cells: m.cells.map((c, i) => L.fog[i] === 1 ? c : ''),
    d100: m.d100.map(() => 0), rooms: [], roomCells: m.roomCells.map(() => ''), notes: '', spawn: null,
    tokens: m.tokens.filter(t => { const p = tokenPosition(t); return t.pcId === pcId || fogAt(m, L, p.x, p.y) === 1; }),
    objects: m.objects.filter(o => objectEnabled(m, o) && o.kind === 'object' && !isArchitectureObject(o) && !o.hidden && anyVisible({ ...m, ...L }, o)).map(o => ({
      id: o.id, kind: o.kind, name: o.name, x: o.x, y: o.y, w: o.w, h: o.h, height: o.height, color: o.color, icon: o.icon,
      state: o.state, states: o.states.map((s, k) => k === o.state ? s : ''), notes: '', hidden: false, media: [], secrets: [],
    })),
  };
}

onProjectReplaced(() => {
  for (const p of players.values()) if (p.win && !p.win.closed) {
    try { p.win.postMessage({ type: 'clear', __ts: 'ts-map', seq: rand(), from: SESSION, inst: INST, born: BORN }, target()); } catch { /* closed */ }
  }
  players.clear(); saveBindings();
});

// 只发给自己的同源窗口（双击 html 用 file:// 打开时没有正经的 origin，只能用 '*'）
const target = () => (location.origin && location.origin !== 'null' ? location.origin : '*');

let quietUntil = 0; // 编辑器刚启动、还在确认会话标识没撞车时，先不往外推

export function send(body: SyncBody, to?: string) {
  if ((body.type === 'world' || body.type === 'play' || body.type === 'stop') && Date.now() < quietUntil) {
    window.setTimeout(() => send(body, to), quietUntil - Date.now() + 5);
    return;
  }
  // 试玩是主持人自己的测试：试玩期间不往玩家窗口推播放；世界一律推真正的那份（试玩前的）
  if ((body.type === 'play' || body.type === 'stop') && getUI().trial) return;
  const msg = (out: SyncBody): SyncMsg => ({ ...out, __ts: 'ts-map', seq: rand(), from: SESSION, inst: INST, born: BORN, ...(to ? { to } : {}) });
  if (body.type === 'world' || body.type === 'play' || body.type === 'stop' || body.type === 'clear') {
    const w = getRealWorld();
    for (const [binding, p] of players) {
      if (!p.win) { if (p.context !== projectContext() || !w.party.some(pc => pc.id === p.pcId)) { players.delete(binding); saveBindings(); } continue; }
      if (p.win.closed) { players.delete(binding); saveBindings(); continue; }
      // A new project requires a fresh host binding. Trial leaves the real project untouched.
      const context = projectContext();
      const valid = p.context === context && w.party.some(pc => pc.id === p.pcId);
      const out: SyncBody = !valid ? { type: 'clear' } : body.type === 'world' ? { type: 'world', world: playerWorld(w, w.playerMapId, p.pcId) } : body;
      try { p.win.postMessage(msg(out), target()); } catch { /* closed */ }
      if (!valid) { players.delete(binding); saveBindings(); }
    }
    return;
  }
  const out = msg(body);
  if (body.type === 'hello') {
    if (window.opener && !window.opener.closed) window.opener.postMessage(out, target());
    return;
  }
  try { channel?.postMessage(out); } catch { /* unavailable */ }
}

/** 订阅消息（两条路都听，按编号去重）。 */
export function listen(fn: (m: SyncMsg, source: MessageEventSource | null) => void) {
  const seen = new Set<string>();
  const handle = (e: MessageEvent) => {
    if (!isMsg(e.data) || seen.has(e.data.seq)) return;
    if (e.origin && e.origin !== 'null' && location.origin !== 'null' && e.origin !== location.origin) return; // 只听自己这边的窗口
    seen.add(e.data.seq);
    if (seen.size > 500) seen.clear();
    fn(e.data, e.source);
  };
  channel?.addEventListener('message', handle);
  window.addEventListener('message', handle);
  return () => {
    channel?.removeEventListener('message', handle);
    window.removeEventListener('message', handle);
  };
}

/**
 * 编辑器这边：
 * - 启动时先问一句会话标识有没有人在用（复制标签页），有就换新的；
 * - 别的编辑器来问、而且问的正是自己的标识，就回答"在用"；
 * - 只回应找自己的玩家窗口（没指定找谁的也回应），顺便记下它，之后直接 postMessage。
 */
export function listenAsEditor(onHello: () => void) {
  const off = listen((m, source) => {
    // 另一个编辑器实例在用同一个会话标识（复制了标签页）：不管消息来得多晚，都按"后打开的让"处理
    if (m.type !== 'hello' && m.from === SESSION && m.inst !== INST) {
      const iAmNewer = m.born < BORN || (m.born === BORN && m.inst < INST);
      if (iAmNewer) renewSession();
      else { send({ type: 'taken' }); onHello(); saveNow(); } // 我是原来那个：叫对方换号，重推一次世界（万一玩家窗口刚才收到了对方的），并重存一次自己的槽（万一对方存进来过）
      return;
    }
    if (m.type === 'claim' || m.type === 'taken' || m.type === 'alive') return;
    if (m.type !== 'hello' || (m.to && m.to !== SESSION)) return;
    const p = m.binding && players.get(m.binding);
    if (!p || !source || !('postMessage' in source) || p.win && source !== p.win) return;
    p.win = source as Window;
    onHello();
  });
  if (channel) { quietUntil = Date.now() + 250; send({ type: 'claim' }); }
  const beat = window.setInterval(() => send({ type: 'alive' }), 2000);
  return () => { off(); clearInterval(beat); };
}

/**
 * 玩家窗口这边：只接收绑定的那个编辑器的世界和播放。
 * 网址带会话和主持人创建的绑定凭据；不提供玩家端换角色或全队总览。
 * 一段时间没收到消息就再打个招呼（编辑器刷新过、只能走 postMessage 时靠这个重新连上）。
 */
export function listenAsPlayer(fn: (m: SyncMsg) => void) {
  const url = new URL(location.href);
  const bound = url.searchParams.get('session');
  const binding = url.searchParams.get('binding');
  // 只认一个编辑器实例：同一个会话标识出现第二个实例（复制了标签页、还没来得及换号）时不理它；
  // 只有原来那个实例安静了一阵（关了、刷新了），才改认新的实例
  let inst: string | null = null;
  let lastHeard = 0;
  const QUIET = 5000;
  const off = listen((m, source) => {
    if (m.type !== 'world' && m.type !== 'play' && m.type !== 'stop' && m.type !== 'clear' && m.type !== 'alive') return;
    if (!bound || !binding) return;
    if (m.type !== 'alive' && (!source || source !== window.opener)) return;
    if (m.from !== bound) return;
    if (inst && m.inst !== inst) {
      if (Date.now() - lastHeard < QUIET) return; // 原来那个还活着：这是复制出来的，不认
      if (m.type !== 'world' && m.type !== 'clear') { send({ type: 'hello', binding: binding ?? undefined }, bound); return; } // 换认新实例：先请它推一整份世界，从世界开始认
    }
    inst = m.inst;
    lastHeard = Date.now();
    if (m.type !== 'alive') fn(m);
  });
  send({ type: 'hello', binding: binding ?? undefined }, bound ?? undefined);
  const beat = window.setInterval(() => {
    if (lastHeard && Date.now() - lastHeard > 10000) fn({ type: 'clear', __ts: 'ts-map', seq: rand(), from: bound ?? '', inst: INST, born: BORN });
    if (Date.now() - lastHeard > 10000 || !inst) send({ type: 'hello', binding: binding ?? undefined }, bound ?? undefined);
  }, 5000);
  return () => { off(); clearInterval(beat); };
}

let timer: number | undefined;
export function broadcastWorld(w: World) {
  clearTimeout(timer);
  timer = window.setTimeout(() => send({ type: 'world', world: w }), 60);
}
