// 转发型服务器的房间表：只管房间/邀请/绑定/重连，不碰 world、不碰规则。
// 纯内存、纯逻辑；socket 在 server/index.ts。
import {
  addInvite, closeRoom, consumeInvite, createRoomState, hostDisconnect, hostReconnect,
  playerDisconnect, playerReconnect, relayRoute,
  type ClientRole, type RelayRoute, type RoomState,
} from '../src/protocol';

export interface RoomEntry {
  state: RoomState;
  createdAt: number;
  touchedAt: number;
}

export type JoinOutcome =
  | { ok: true; inviteId: string; binding: string; room: RoomState }
  | { ok: false; reason: 'closed' | 'invalid' | 'unknown-invite' | 'invite-used' | 'token-collision' };

export class RoomService {
  private rooms = new Map<string, RoomEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? 12 * 60 * 60 * 1000;
  }

  create(roomId: string, hostToken: string): RoomState | null {
    if (!roomId || !hostToken || this.rooms.has(roomId)) return null;
    const state = createRoomState(roomId, hostToken);
    const at = this.now();
    this.rooms.set(roomId, { state, createdAt: at, touchedAt: at });
    return state;
  }

  /** 只读，不刷新 TTL：鉴权失败/坏 token 不能续房间寿命。 */
  peek(roomId: string): RoomState | null {
    return this.rooms.get(roomId)?.state ?? null;
  }

  private touch(roomId: string): void {
    const entry = this.rooms.get(roomId);
    if (entry) entry.touchedAt = this.now();
  }

  issueInvite(roomId: string, hostToken: string, inviteId: string, inviteToken: string): boolean {
    const state = this.peek(roomId);
    if (!state || !state.hostOnline || state.hostToken !== hostToken) return false;
    const ok = addInvite(state, inviteId, inviteToken);
    if (ok) this.touch(roomId);
    return ok;
  }

  join(roomId: string, inviteToken: string, binding: string, playerToken: string): JoinOutcome {
    const state = this.peek(roomId);
    if (!state) return { ok: false, reason: 'closed' };
    const result = consumeInvite(state, inviteToken, binding, playerToken);
    if (result.ok) this.touch(roomId);
    return result.ok ? { ...result, room: state } : result;
  }

  reconnect(roomId: string, playerToken: string): { room: RoomState; binding: string } | null {
    const state = this.peek(roomId);
    if (!state) return null;
    const binding = playerReconnect(state, playerToken);
    if (!binding) return null;
    this.touch(roomId);
    return { room: state, binding };
  }

  relay(roomId: string, role: ClientRole, token: string, to?: string): { room: RoomState; route: RelayRoute } | null {
    const state = this.peek(roomId);
    if (!state) return null;
    const route = relayRoute(state, role, token, to);
    if (!route) return null;
    this.touch(roomId);
    return { room: state, route };
  }

  close(roomId: string, hostToken: string): RoomState | null {
    const state = this.peek(roomId);
    if (!state || !state.hostOnline || state.hostToken !== hostToken) return null;
    closeRoom(state);
    this.rooms.delete(roomId);
    return state;
  }

  hostDisconnected(roomId: string): RoomState | null {
    const state = this.peek(roomId);
    if (!state) return null;
    hostDisconnect(state);
    return state;
  }

  hostReconnected(roomId: string, hostToken: string): RoomState | null {
    const state = this.peek(roomId);
    if (!state) return null;
    return hostReconnect(state, hostToken) ? state : null;
  }

  playerDisconnected(roomId: string, binding: string): RoomState | null {
    const state = this.peek(roomId);
    if (!state) return null;
    playerDisconnect(state, binding);
    return state;
  }

  /** 过期房间清掉；返回清掉的房间号。 */
  sweep(): string[] {
    const at = this.now();
    const gone: string[] = [];
    for (const [id, entry] of this.rooms) {
      if (at - entry.touchedAt > this.ttlMs) {
        closeRoom(entry.state);
        this.rooms.delete(id);
        gone.push(id);
      }
    }
    return gone;
  }

  size(): number {
    return this.rooms.size;
  }
}
