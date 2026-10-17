import type { GameMap, World } from './types';
import { numbering } from './render';
import { getRealWorld, getUI } from './store';

// 主持人窗口 ↔ 玩家窗口。玩家窗口用来共享屏幕给玩家（第一阶段还没有联网，靠共享屏幕）。
// 两条路同时走：
//   1. window.postMessage 直接发给"打开玩家窗口"开出来的那个窗口（双击 html 用 file:// 打开时也能通）；
//   2. BroadcastChannel（玩家窗口是手动开的、或者刷新过时兜底）。
// 每条消息带编号，接收方去重。

export type SyncBody =
  | { type: 'world'; world: World }
  | { type: 'hello' }
  | { type: 'play'; mediaId: string; label: string; mime: string; blob?: Blob }
  | { type: 'stop' };
/** from：发送方的会话；to：只给某个会话（玩家窗口打招呼时用）。 */
export type SyncMsg = SyncBody & { __ts: 'ts-map'; seq: string; from: string; to?: string };

const rand = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
/**
 * 这个编辑器窗口的会话标识。同时开着两个编辑器（两场团）时，玩家窗口只认打开它的那一个。
 * 存在 sessionStorage：刷新页面不变（玩家窗口不用重开），换一个标签页就是新的。
 */
export const SESSION = (() => {
  try {
    let s = sessionStorage.getItem('ts-sync-session');
    if (!s) { s = rand(); sessionStorage.setItem('ts-sync-session', s); }
    return s;
  } catch { return rand(); }
})();

let channel: BroadcastChannel | null = null;
try { channel = new BroadcastChannel('ts-map-sync'); } catch { /* 不支持就只走 postMessage */ }

let playerWin: Window | null = null;
export function openPlayerWindow() {
  playerWin = window.open(`?view=player&session=${SESSION}`, `ts-player-${SESSION}`, 'width=1280,height=800');
}

const isMsg = (d: unknown): d is SyncMsg => !!d && typeof d === 'object' && (d as SyncMsg).__ts === 'ts-map' && typeof (d as SyncMsg).from === 'string';

/**
 * 发给玩家窗口的"玩家版"世界：主持人才能看的东西在发出去之前就删掉，而不只是不画。
 * 只留推给玩家的那一张图，而且只留"有人看得见"或"有人记得"的部分：
 * - 地形：现在有人看得见的格子才带实时地形；灰区靠各人的记忆（seen）画，黑区什么都没有；
 * - 物件：没隐藏、现在有人看得见的才带，备注、挂的媒体、没公开的线索删掉，其他状态的名字也删掉（只留当前这个）；
 * - 棋子：玩家角色的都带，其余的只在有人看得见时带；连接点：没隐藏、端点有人看得见的才带；
 * - 房间、D100、出生点、备注、流程图、记录、NPC、媒体列表都不带。
 * 编号（O/Z/T/C）在删之前按完整的世界算好放进 labels，所以玩家和主持人看到的编号一样。
 */
export function playerWorld(w: World, mapId: string | null = w.playerMapId): World {
  const src = w.maps.find((m) => m.id === mapId);
  const pm = src && playerMap(src);
  const connections = src ? w.connections.filter((c) => {
    if (c.hidden) return false;
    return [c.a, c.b].some((e) => e.mapId === src.id && liveAt(src, e.y * src.width + e.x));
  }) : [];
  // 编号表也只带玩家碰得到的东西（发出去的、记得的），不然从编号的空缺能数出有几个隐藏物件
  const keep = new Set<string>([
    ...(pm ? [...pm.objects, ...pm.tokens, ...pm.seen.objects, ...Object.values(pm.views).flatMap((L) => L.seen.objects)].map((x) => x.id) : []),
    ...connections.map((c) => c.id),
  ]);
  const labels: Record<string, string> = {};
  if (src) numbering(w, src).forEach((n) => { if (keep.has(n.id)) labels[n.id] = n.label; });
  return {
    ...w,
    flows: [], log: [], npcs: [], media: [],
    labels,
    marks: w.marks.filter((k) => k.mapId === mapId),
    connections,
    maps: pm ? [pm] : [],
  };
}

/** 这一格现在有没有人看得见（共享那份，或者任何一个人自己那份）。 */
function liveAt(m: GameMap, i: number) {
  return m.fog[i] === 1 || Object.values(m.views ?? {}).some((L) => L.fog[i] === 1);
}

function playerMap(m: GameMap): GameMap {
  const live = m.fog.map((_, i) => liveAt(m, i));
  const seenRect = (r: { x: number; y: number; w: number; h: number }) => {
    for (let y = Math.max(0, r.y); y < Math.min(m.height, r.y + r.h); y++)
      for (let x = Math.max(0, r.x); x < Math.min(m.width, r.x + r.w); x++) if (live[y * m.width + x]) return true;
    return false;
  };
  return {
    ...m,
    notes: '',
    spawn: null,
    cells: m.cells.map((c, i) => (live[i] ? c : '')),
    d100: m.d100.map(() => 0),
    rooms: [],
    roomCells: m.roomCells.map(() => ''),
    tokens: m.tokens.filter((t) => t.pcId || live[t.y * m.width + t.x]),
    objects: m.objects.filter((o) => o.kind === 'object' && !o.hidden && seenRect(o)).map((o) => ({
      ...o,
      notes: '',
      media: [],
      states: o.states.map((s, k) => (k === o.state ? s : '')),
      secrets: o.secrets.filter((s) => s.revealed?.scope === 'party').map((s) => ({
        ...s,
        tiers: { crit: '', success: '', fail: '', fumble: '', [s.revealed!.tier]: s.tiers[s.revealed!.tier] },
      })),
    })),
  };
}

// 只发给自己的同源窗口（双击 html 用 file:// 打开时没有正经的 origin，只能用 '*'）
const target = () => (location.origin && location.origin !== 'null' ? location.origin : '*');

export function send(body: SyncBody, to?: string) {
  // 试玩是主持人自己的测试：试玩期间不往玩家窗口推播放；世界一律推真正的那份（试玩前的）
  if ((body.type === 'play' || body.type === 'stop') && getUI().trial) return;
  const out: SyncBody = body.type === 'world' ? { type: 'world', world: playerWorld(getRealWorld()) } : body;
  const msg: SyncMsg = { ...out, __ts: 'ts-map', seq: rand(), from: SESSION, ...(to ? { to } : {}) };
  try { channel?.postMessage(msg); } catch { /* 有的浏览器不能用 BroadcastChannel 传 Blob */ }
  const targets = [playerWin, window.opener as Window | null].filter((w): w is Window => !!w && !w.closed && w !== window);
  targets.forEach((w) => { try { w.postMessage(msg, target()); } catch { /* 窗口已关 */ } });
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

/** 编辑器这边：只回应找自己的玩家窗口（没指定找谁的也回应），顺便记下它，之后直接 postMessage。 */
export function listenAsEditor(onHello: () => void) {
  return listen((m, source) => {
    if (m.type !== 'hello' || (m.to && m.to !== SESSION)) return;
    if (source && source !== window && 'postMessage' in source) playerWin = source as Window;
    onHello();
  });
}

/**
 * 玩家窗口这边：只接收绑定的那个编辑器的消息。
 * 从编辑器的按钮打开的，网址里带着会话；手动打开的，认第一个推来世界的编辑器。
 */
export function listenAsPlayer(fn: (m: SyncMsg) => void) {
  let bound = new URLSearchParams(location.search).get('session');
  const off = listen((m) => {
    if (m.type === 'hello') return;
    if (!bound) { if (m.type !== 'world') return; bound = m.from; }
    if (m.from !== bound) return;
    fn(m);
  });
  send({ type: 'hello' }, bound ?? undefined);
  return off;
}

let timer: number | undefined;
export function broadcastWorld(w: World) {
  clearTimeout(timer);
  timer = window.setTimeout(() => send({ type: 'world', world: w }), 60);
}
