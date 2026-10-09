import type { World } from './types';

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

export function send(body: SyncBody) {
  const msg: SyncMsg = { ...body, __ts: 'ts-map', seq: Math.random().toString(36).slice(2) };
  try { channel?.postMessage(msg); } catch { /* 有的浏览器不能用 BroadcastChannel 传 Blob */ }
  const targets = [playerWin, window.opener as Window | null].filter((w): w is Window => !!w && !w.closed && w !== window);
  targets.forEach((w) => { try { w.postMessage(msg, '*'); } catch { /* 窗口已关 */ } });
}

/** 订阅消息（两条路都听，按编号去重）。 */
export function listen(fn: (m: SyncMsg, source: MessageEventSource | null) => void) {
  const seen = new Set<string>();
  const handle = (e: MessageEvent) => {
    if (!isMsg(e.data) || seen.has(e.data.seq)) return;
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
