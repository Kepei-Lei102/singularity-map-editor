// 主持端 ↔ 玩家端的传输抽象。本地窗口和 WebSocket 都实现这一套。
import type { SyncMsg } from './messages';

export type TransportRole = 'host' | 'player';
/** 本地窗口模式还是线上房间模式；UI 用它决定给“打开窗口”还是“发邀请链接”。 */
export type TransportKind = 'local' | 'ws';

export interface TransportMessageMeta {
  /** 主持端：绑定的 binding；玩家端：固定为 'host'；无法认出来源时为 null。 */
  from: string | null;
  /** 本地窗口实现才有；WebSocket 实现为 null。只给守卫做来源校验，业务层不存它。 */
  source: MessageEventSource | null;
}

export interface Transport {
  readonly role: TransportRole;
  readonly kind: TransportKind;
  readonly hasBroadcast: boolean;
  /** 主持端打开一个玩家窗口；返回 false 表示被浏览器拦截。线上房间不实现。 */
  openPeer(binding: string, url: string): boolean;
  /** 本地窗口刷新后重新把 binding 绑到新的 window；WebSocket 不需要。 */
  bindPeer(binding: string, source: MessageEventSource | null): boolean;
  /** 本地实现用 window 反查 binding；测试会直接传窗口。 */
  bindingFor(source: MessageEventSource | null): string | null;
  hasPeer(binding: string): boolean;
  /** 这个 binding 开过窗口、但窗口已经关了；saved binding 没有窗口时是 false。 */
  peerClosed(binding: string): boolean;
  dropPeer(binding: string): void;
  /** 主持端定向发；返回 false 表示窗口已关/发送失败。 */
  sendToPeer(binding: string, msg: SyncMsg): boolean;
  /** 玩家端发给主持；返回 false 表示主持窗口已关/发送失败。 */
  sendToHost(msg: SyncMsg): boolean;
  /** 广播（会话占用、存活、本地同源标签页）。WebSocket 没有广播。 */
  broadcast(msg: SyncMsg): void;
  onMessage(fn: (msg: SyncMsg, meta: TransportMessageMeta) => void): () => void;
  close(): void;
}

export interface SwitchableTransport extends Transport {
  /** 把收发切到另一条传输；已有订阅者跟着切，不用重挂。 */
  use(next: Transport): void;
}

/**
 * 本地窗口先起，点了“线上房间”再切 WebSocket。
 * 订阅是挂在 SwitchTransport 上的，所以切走时 sync.ts 里的 listenAsEditor/listenAsPlayer 不会被丢掉。
 */
class SwitchTransport implements SwitchableTransport {
  readonly role: TransportRole;
  private active: Transport;
  private detach: (() => void) | null = null;
  private listening = false;
  private closed = false;
  private readonly handlers: Array<(msg: SyncMsg, meta: TransportMessageMeta) => void> = [];

  constructor(active: Transport) {
    this.active = active;
    this.role = active.role;
  }

  get kind(): TransportKind { return this.active.kind; }
  get hasBroadcast(): boolean { return this.active.hasBroadcast; }

  use(next: Transport): void {
    if (this.closed) throw new Error('传输已经关闭，不能再切换');
    if (next === this.active) return;
    if (next.role !== this.role) throw new Error(`传输角色不能从 ${this.role} 切到 ${next.role}`);
    const previous = this.active;
    this.detachActive();
    this.active = next;
    if (this.listening) this.attachActive();
    // 旧传输要真正关掉；否则本地窗口监听/WebSocket 会留在后台继续收包。
    previous.close();
  }

  openPeer(binding: string, url: string): boolean { return this.active.openPeer(binding, url); }
  bindPeer(binding: string, source: MessageEventSource | null): boolean { return this.active.bindPeer(binding, source); }
  bindingFor(source: MessageEventSource | null): string | null { return this.active.bindingFor(source); }
  hasPeer(binding: string): boolean { return this.active.hasPeer(binding); }
  peerClosed(binding: string): boolean { return this.active.peerClosed(binding); }
  dropPeer(binding: string): void { this.active.dropPeer(binding); }
  sendToPeer(binding: string, msg: SyncMsg): boolean { return this.active.sendToPeer(binding, msg); }
  sendToHost(msg: SyncMsg): boolean { return this.active.sendToHost(msg); }
  broadcast(msg: SyncMsg): void { this.active.broadcast(msg); }

  onMessage(fn: (msg: SyncMsg, meta: TransportMessageMeta) => void): () => void {
    if (this.closed) return () => {};
    if (!this.listening) { this.listening = true; this.attachActive(); }
    this.handlers.push(fn);
    return () => {
      const i = this.handlers.indexOf(fn);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachActive();
    this.active.close();
    this.handlers.length = 0;
    this.listening = false;
  }

  private attachActive(): void {
    this.detach = this.active.onMessage((msg, meta) => this.dispatch(msg, meta));
  }

  private detachActive(): void {
    this.detach?.();
    this.detach = null;
  }

  private dispatch(msg: SyncMsg, meta: TransportMessageMeta): void {
    for (const fn of [...this.handlers]) fn(msg, meta);
  }
}

export function createSwitchTransport(active: Transport): SwitchableTransport {
  return new SwitchTransport(active);
}
