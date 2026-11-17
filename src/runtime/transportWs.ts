// WebSocket 传输：主持端发 room.relay 到某个 binding，玩家端发 room.relay 回主持。
// 服务器只传 payload，业务消息仍然是现有 SyncMsg。
import { isPeerJoinedPayload, isPeerLeftPayload, isRoomClosedPayload, type Envelope } from '../protocol';
import { isSyncMsg, type SyncMsg } from './messages';
import type { RelaySocket } from './wsSocket';
import type { Transport, TransportMessageMeta, TransportRole } from './transport';

export interface WsTransportOptions {
  role: TransportRole;
  socket: RelaySocket;
  roomId: string;
  token: string;
  /** 主持端：peer.joined 时把 inviteId 交回 onlineRoom，用来认 pcId。 */
  onPeerJoined?: (binding: string, inviteId: string) => void;
  /** 主持端：玩家连接断了，把 players/asset allow 一起清掉。 */
  onPeerLeft?: (binding: string) => void;
  onClosed?: (reason: string) => void;
}

export class WsTransport implements Transport {
  readonly role: TransportRole;
  readonly kind = 'ws' as const;
  readonly hasBroadcast = false;
  private readonly socket: RelaySocket;
  private readonly roomId: string;
  private readonly token: string;
  private readonly peers = new Set<string>();
  private readonly handlers: Array<(msg: SyncMsg, meta: TransportMessageMeta) => void> = [];
  private readonly offEnvelope: () => void;
  private readonly offClose: () => void;
  private readonly onPeerJoined?: (binding: string, inviteId: string) => void;
  private readonly onPeerLeft?: (binding: string) => void;
  private readonly onClosed?: (reason: string) => void;
  private closedNotified = false;

  constructor(o: WsTransportOptions) {
    this.role = o.role;
    this.socket = o.socket;
    this.roomId = o.roomId;
    this.token = o.token;
    this.onPeerJoined = o.onPeerJoined;
    this.onPeerLeft = o.onPeerLeft;
    this.onClosed = o.onClosed;
    this.offEnvelope = this.socket.onEnvelope((e) => this.handle(e));
    this.offClose = this.socket.onClose((reason) => this.notifyClosed(reason));
  }

  openPeer(): boolean { return false; }
  bindPeer(): boolean { return false; }
  bindingFor(): string | null { return null; }
  hasPeer(binding: string): boolean { return this.role === 'host' && this.peers.has(binding); }
  peerClosed(): boolean { return false; }
  dropPeer(binding: string): void { this.peers.delete(binding); }

  sendToPeer(binding: string, msg: SyncMsg): boolean {
    if (this.role !== 'host' || !this.socket.open) return false;
    this.socket.send({ type: 'room.relay', roomId: this.roomId, token: this.token, to: binding, payload: msg });
    return true;
  }

  sendToHost(msg: SyncMsg): boolean {
    if (this.role !== 'player' || !this.socket.open) return false;
    this.socket.send({ type: 'room.relay', roomId: this.roomId, token: this.token, payload: msg });
    return true;
  }

  broadcast(): void { /* 线上没有同源广播；心跳走 sendToPeer */ }

  onMessage(fn: (msg: SyncMsg, meta: TransportMessageMeta) => void): () => void {
    this.handlers.push(fn);
    return () => {
      const i = this.handlers.indexOf(fn);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  close(): void {
    this.closedNotified = true;
    this.offEnvelope();
    this.offClose();
    this.handlers.length = 0;
    this.peers.clear();
    this.socket.close();
  }

  private notifyClosed(reason: string): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.onClosed?.(reason);
  }

  private handle(e: Envelope): void {
    if (e.type === 'peer.joined' && isPeerJoinedPayload(e.payload)) {
      if (this.role !== 'host') return;
      this.peers.add(e.payload.binding);
      this.onPeerJoined?.(e.payload.binding, e.payload.inviteId);
      return;
    }
    if (e.type === 'peer.left' && isPeerLeftPayload(e.payload)) {
      if (this.role !== 'host') return;
      this.peers.delete(e.payload.binding);
      this.onPeerLeft?.(e.payload.binding);
      return;
    }
    if (e.type === 'room.closed') {
      this.notifyClosed(isRoomClosedPayload(e.payload) ? e.payload.reason ?? 'closed' : 'closed');
      // 房间没了，连接也没有继续用下去的理由；关掉后 sendToPeer/sendToHost 会返回 false。
      this.socket.close();
      return;
    }
    if (e.type !== 'room.relay' || !isSyncMsg(e.payload)) return;
    if (this.role === 'player') {
      if (e.from !== 'host') return;
    } else if (typeof e.from !== 'string' || !e.from || !this.peers.has(e.from)) return;
    const meta: TransportMessageMeta = { from: this.role === 'player' ? 'host' : e.from, source: null };
    for (const fn of [...this.handlers]) fn(e.payload, meta);
  }
}

export function createWsTransport(o: WsTransportOptions): Transport {
  return new WsTransport(o);
}
