// 现有的同源窗口 / BroadcastChannel / postMessage 实现。
// 主持端这边：world 只 postMessage 给已绑定的玩家窗口，广播只传会话占用/存活。
// 玩家端这边：只认打开它的那个主持人窗口。
import { hostOriginForPlayer, playerWindowOrigin, messageTarget } from '../core/deployment';
import { isSyncMsg, type SyncMsg } from './messages';
import type { Transport, TransportMessageMeta, TransportRole } from './transport';

const CROSS_ORIGIN_FROM_PLAYER = new Set(['hello', 'judge-roll', 'say', 'move', 'code-submit', 'skill-decision']);

class LocalTransport implements Transport {
  readonly role: TransportRole;
  readonly hasBroadcast: boolean;
  private readonly peers = new Map<string, Window>();
  private readonly channel: BroadcastChannel | null;
  private readonly handlers: Array<(msg: SyncMsg, meta: TransportMessageMeta) => void> = [];
  private readonly seen = new Set<string>();
  private readonly onWindowMessage: (e: MessageEvent) => void;
  private readonly onChannelMessage: (e: MessageEvent) => void;
  private listening = false;

  constructor(role: TransportRole) {
    this.role = role;
    let channel: BroadcastChannel | null = null;
    try { channel = new BroadcastChannel('ts-map-sync'); } catch { /* 不支持就只走 postMessage */ }
    this.channel = channel;
    this.hasBroadcast = !!channel;
    this.onWindowMessage = (e) => this.handle(e);
    this.onChannelMessage = (e) => this.handle(e);
  }

  openPeer(binding: string, url: string): boolean {
    if (this.role !== 'host') return false;
    const win = window.open(url, `ts-player-${binding}`, 'width=1280,height=800');
    if (!win) return false;
    this.peers.set(binding, win);
    return true;
  }

  bindPeer(binding: string, source: MessageEventSource | null): boolean {
    if (this.role !== 'host' || !source || !('postMessage' in source)) return false;
    const existing = this.peers.get(binding);
    if (existing && existing !== source && !existing.closed) return false;
    this.peers.set(binding, source as Window);
    return true;
  }

  bindingFor(source: MessageEventSource | null): string | null {
    if (!source) return null;
    for (const [binding, win] of this.peers) if (win === source) return binding;
    return null;
  }

  hasPeer(binding: string): boolean {
    const win = this.peers.get(binding);
    return !!win && !win.closed;
  }

  peerClosed(binding: string): boolean {
    const win = this.peers.get(binding);
    return !!win && win.closed;
  }

  dropPeer(binding: string): void {
    this.peers.delete(binding);
  }

  sendToPeer(binding: string, msg: SyncMsg): boolean {
    const win = this.peers.get(binding);
    if (!win || win.closed) return false;
    try { win.postMessage(msg, messageTarget(playerWindowOrigin())); return true; } catch { return false; }
  }

  sendToHost(msg: SyncMsg): boolean {
    const opener = window.opener;
    if (!opener || opener.closed) return false;
    try { opener.postMessage(msg, messageTarget(hostOriginForPlayer())); return true; } catch { return false; }
  }

  broadcast(msg: SyncMsg): void {
    try { this.channel?.postMessage(msg); } catch { /* unavailable */ }
  }

  onMessage(fn: (msg: SyncMsg, meta: TransportMessageMeta) => void): () => void {
    if (!this.listening) {
      this.listening = true;
      window.addEventListener('message', this.onWindowMessage);
      this.channel?.addEventListener('message', this.onChannelMessage);
    }
    this.handlers.push(fn);
    return () => {
      const i = this.handlers.indexOf(fn);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  close(): void {
    if (this.listening) {
      window.removeEventListener('message', this.onWindowMessage);
      this.channel?.removeEventListener('message', this.onChannelMessage);
      this.listening = false;
    }
    this.channel?.close();
    this.handlers.length = 0;
    this.peers.clear();
  }

  private handle(e: MessageEvent): void {
    if (!isSyncMsg(e.data) || this.seen.has(e.data.seq)) return;
    const allowed = this.role === 'player'
      ? [hostOriginForPlayer()]
      : e.data.type === 'hello'
        ? [playerWindowOrigin()]
        : [location.origin, playerWindowOrigin()];
    if (e.origin && !allowed.includes(e.origin)) return;
    // 主持端这边：自己的窗口（另一个编辑器标签、BroadcastChannel）来自本机 origin，
    // 玩家窗口来自配置的玩家 origin——分端口部署时这两个不一样，得都认。
    if (this.role === 'host' && e.source && !CROSS_ORIGIN_FROM_PLAYER.has(e.data.type)) return;
    // 玩家端只认打开它的那个主持人窗口；BroadcastChannel（source 为空）也不认。
    if (this.role === 'player' && e.data.type !== 'alive' && (!e.source || e.source !== window.opener)) return;
    this.seen.add(e.data.seq);
    if (this.seen.size > 500) this.seen.clear();
    const from = this.role === 'player' && e.source && e.source === window.opener ? 'host' : this.bindingFor(e.source);
    for (const fn of [...this.handlers]) fn(e.data, { from, source: e.source });
  }
}

export function createLocalTransport(role: TransportRole): Transport {
  return new LocalTransport(role);
}

export type { Transport };
