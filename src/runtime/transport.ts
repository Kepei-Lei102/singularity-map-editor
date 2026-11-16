// 主持端 ↔ 玩家端的传输抽象。本地窗口和 WebSocket 都实现这一套。
import type { SyncMsg } from './messages';

export type TransportRole = 'host' | 'player';

export interface TransportMessageMeta {
  /** 主持端：绑定的 binding；玩家端：固定为 'host'；无法认出来源时为 null。 */
  from: string | null;
  /** 本地窗口实现才有；WebSocket 实现为 null。只给守卫做来源校验，业务层不存它。 */
  source: MessageEventSource | null;
}

export interface Transport {
  readonly role: TransportRole;
  readonly hasBroadcast: boolean;
  /** 主持端打开一个玩家窗口；返回 false 表示被浏览器拦截。玩家端不实现。 */
  openPeer(binding: string, url: string): boolean;
  /** 本地窗口刷新后重新把 binding 绑到新的 window；WebSocket 不需要。 */
  bindPeer(binding: string, source: MessageEventSource | null): boolean;
  /** 本地实现用 window 反查 binding；测试会直接传窗口。 */
  bindingFor(source: MessageEventSource | null): string | null;
  hasPeer(binding: string): boolean;
  /** 这个 binding 开过窗口、但窗口已经关了；saved binding 没有窗口时是 false。 */
  peerClosed(binding: string): boolean;
  dropPeer(binding: string): void;
  /** 主持端定向发；返回 false 表示窗口已关。 */
  sendToPeer(binding: string, msg: SyncMsg): boolean;
  /** 玩家端发给主持；返回 false 表示主持窗口已关。 */
  sendToHost(msg: SyncMsg): boolean;
  /** 广播（会话占用、存活、本地同源标签页）。 */
  broadcast(msg: SyncMsg): void;
  onMessage(fn: (msg: SyncMsg, meta: TransportMessageMeta) => void): () => void;
  close(): void;
}
