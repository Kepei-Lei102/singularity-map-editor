import type { GameMap, World } from './types';

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
export type SyncMsg = SyncBody & { __ts: 'ts-map'; seq: string };

let channel: BroadcastChannel | null = null;
try { channel = new BroadcastChannel('ts-map-sync'); } catch { /* 不支持就只走 postMessage */ }

let playerWin: Window | null = null;
export function openPlayerWindow() {
  playerWin = window.open('?view=player', 'ts-player', 'width=1280,height=800');
}

const isMsg = (d: unknown): d is SyncMsg => !!d && typeof d === 'object' && (d as SyncMsg).__ts === 'ts-map';

/**
 * 发给玩家窗口的"玩家版"世界：主持人才能看的东西在发出去之前就删掉，而不只是不画。
 * 删掉：备注、预测和记录、NPC、隐藏物件和触发区、没公开的线索（公开的只留揭示到的那一档）、
 * 物件上挂的媒体、D100 区域、出生点、隐藏的连接点、玩家看不见的非玩家棋子。
 */
export function playerWorld(w: World): World {
  const seenBySomeone = (m: GameMap, i: number) => m.fog[i] === 1 || Object.values(m.views ?? {}).some((L) => L.fog[i] === 1);
  return {
    ...w,
    flows: [], log: [], npcs: [],
    connections: w.connections.filter((c) => !c.hidden),
    maps: w.maps.map((m) => ({
      ...m,
      notes: '',
      spawn: null,
      d100: m.d100.map(() => 0),
      rooms: m.rooms.map((r) => ({ ...r, note: '' })),
      tokens: m.tokens.filter((t) => t.pcId || seenBySomeone(m, t.y * m.width + t.x)),
      objects: m.objects.filter((o) => o.kind === 'object' && !o.hidden).map((o) => ({
        ...o,
        notes: '',
        media: [],
        secrets: o.secrets.filter((s) => s.revealed?.scope === 'party').map((s) => ({
          ...s,
          tiers: { crit: '', success: '', fail: '', fumble: '', [s.revealed!.tier]: s.tiers[s.revealed!.tier] },
        })),
      })),
    })),
  };
}

// 只发给自己的同源窗口（双击 html 用 file:// 打开时没有正经的 origin，只能用 '*'）
const target = () => (location.origin && location.origin !== 'null' ? location.origin : '*');

export function send(body: SyncBody) {
  const out: SyncBody = body.type === 'world' ? { type: 'world', world: playerWorld(body.world) } : body;
  const msg: SyncMsg = { ...out, __ts: 'ts-map', seq: Math.random().toString(36).slice(2) };
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
    if (e.source && e.source !== window && 'postMessage' in e.source && !window.opener) playerWin = e.source as Window;
    fn(e.data, e.source);
  };
  channel?.addEventListener('message', handle);
  window.addEventListener('message', handle);
  return () => {
    channel?.removeEventListener('message', handle);
    window.removeEventListener('message', handle);
  };
}

let timer: number | undefined;
export function broadcastWorld(w: World) {
  clearTimeout(timer);
  timer = window.setTimeout(() => send({ type: 'world', world: w }), 60);
}
