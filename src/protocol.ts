// 三端分离的信封与房间状态机。纯函数，不碰 socket、不碰 React、不碰 world。
//
// 这一版服务器只做转发：主持端仍是规则权威；服务器只认房间、token 和绑定，
// payload 里的业务消息（现有 SyncBody）由主持端/玩家端自己校验。
export const PROTOCOL_VERSION = 1;

export type ClientRole = 'host' | 'player';
export type Role = ClientRole | 'server';

export type EnvelopeType =
  | 'room.create'
  | 'room.created'
  | 'room.invite'
  | 'room.invited'
  | 'room.join'
  | 'room.joined'
  | 'room.relay'
  | 'room.reconnect'
  | 'room.reconnected'
  | 'peer.joined'
  | 'peer.left'
  | 'room.close'
  | 'room.closed'
  | 'error';

export interface RoomCreatedPayload { roomId: string; hostToken: string }
export interface RoomInvitedPayload { inviteId: string; inviteToken: string; joinUrl: string }
export interface RoomJoinedPayload { binding: string; playerToken: string }
export interface RoomReconnectedPayload { binding: string }
export interface PeerJoinedPayload { inviteId: string; binding: string }
export interface PeerLeftPayload { binding: string }
export interface RoomInvitePayload { pcId?: string }
export interface RoomClosedPayload { reason?: string }
export interface ErrorPayload { code: string; message?: string }

export interface Envelope {
  v: 1;
  type: EnvelopeType;
  requestId: string;
  roomId?: string;
  token?: string;
  /** 只允许主持端定向发给某个 binding；玩家端回主持时不填。 */
  to?: string;
  /** 服务器下行 relay 时填来源 binding；客户端上行不填。 */
  from?: string;
  /** 握手字段或现有 SyncBody；服务器不解析业务正文。 */
  payload?: unknown;
}

export const ENVELOPE_TYPES: readonly EnvelopeType[] = [
  'room.create', 'room.created', 'room.invite', 'room.invited', 'room.join', 'room.joined',
  'room.relay', 'room.reconnect', 'room.reconnected', 'peer.joined', 'peer.left',
  'room.close', 'room.closed', 'error',
];

const HOST_SENDS = new Set<EnvelopeType>(['room.create', 'room.invite', 'room.relay', 'room.close']);
const PLAYER_SENDS = new Set<EnvelopeType>(['room.join', 'room.reconnect', 'room.relay']);
const SERVER_SENDS = new Set<EnvelopeType>([
  'room.created', 'room.invited', 'room.joined', 'room.reconnected', 'room.relay',
  'peer.joined', 'peer.left', 'room.closed', 'error',
]);

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** 宽松校验：只判信封本身；payload 交给业务层。 */
export function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  if (e.v !== PROTOCOL_VERSION) return false;
  if (typeof e.type !== 'string' || !ENVELOPE_TYPES.includes(e.type as EnvelopeType)) return false;
  if (!nonEmpty(e.requestId)) return false;
  if (e.roomId !== undefined && !nonEmpty(e.roomId)) return false;
  if (e.token !== undefined && !nonEmpty(e.token)) return false;
  if (e.to !== undefined && !nonEmpty(e.to)) return false;
  if (e.from !== undefined && !nonEmpty(e.from)) return false;
  return true;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function isRoomCreatedPayload(v: unknown): v is RoomCreatedPayload {
  return isRecord(v) && nonEmpty(v.roomId) && nonEmpty(v.hostToken);
}
export function isRoomInvitedPayload(v: unknown): v is RoomInvitedPayload {
  return isRecord(v) && nonEmpty(v.inviteId) && nonEmpty(v.inviteToken) && nonEmpty(v.joinUrl);
}
export function isRoomJoinedPayload(v: unknown): v is RoomJoinedPayload {
  return isRecord(v) && nonEmpty(v.binding) && nonEmpty(v.playerToken);
}
export function isRoomReconnectedPayload(v: unknown): v is RoomReconnectedPayload {
  return isRecord(v) && nonEmpty(v.binding);
}
export function isPeerJoinedPayload(v: unknown): v is PeerJoinedPayload {
  return isRecord(v) && nonEmpty(v.inviteId) && nonEmpty(v.binding);
}
export function isPeerLeftPayload(v: unknown): v is PeerLeftPayload {
  return isRecord(v) && nonEmpty(v.binding);
}
export function isRoomInvitePayload(v: unknown): v is RoomInvitePayload {
  return isRecord(v) && (v.pcId === undefined || typeof v.pcId === 'string');
}
export function isRoomClosedPayload(v: unknown): v is RoomClosedPayload {
  return isRecord(v) && (v.reason === undefined || typeof v.reason === 'string');
}
export function isErrorPayload(v: unknown): v is ErrorPayload {
  return isRecord(v) && nonEmpty(v.code) && (v.message === undefined || typeof v.message === 'string');
}

export function clientCanSend(role: ClientRole, type: EnvelopeType): boolean {
  return role === 'host' ? HOST_SENDS.has(type) : PLAYER_SENDS.has(type);
}

export function serverCanSend(type: EnvelopeType): boolean {
  return SERVER_SENDS.has(type);
}

/**
 * relay 的形状：主持端必须带 to；玩家端必须不带 to（只能回主持端）。
 * 真正的房间/token 校验在 relayRoute()。
 */
export function relayShapeOk(role: ClientRole, e: Envelope): boolean {
  if (e.type !== 'room.relay') return false;
  if (e.from !== undefined) return false;
  return role === 'host' ? nonEmpty(e.to) : e.to === undefined;
}

// ---------- 房间状态机 ----------

export interface Invite {
  inviteId: string;
  token: string;
  usedBy: string | null;
}

export interface PlayerBinding {
  binding: string;
  token: string;
  inviteId: string;
  online: boolean;
}

export interface RoomState {
  roomId: string;
  hostToken: string;
  hostOnline: boolean;
  closed: boolean;
  invites: Record<string, Invite>;
  /** inviteToken -> inviteId */
  inviteTokens: Record<string, string>;
  players: Record<string, PlayerBinding>;
  /** playerToken -> binding */
  playerTokens: Record<string, string>;
}

export type JoinResult =
  | { ok: true; inviteId: string; binding: string }
  | { ok: false; reason: 'closed' | 'invalid' | 'unknown-invite' | 'invite-used' | 'token-collision' };

export function createRoomState(roomId: string, hostToken: string): RoomState {
  return {
    roomId, hostToken, hostOnline: true, closed: false,
    invites: {}, inviteTokens: {}, players: {}, playerTokens: {},
  };
}

/** 发一张一次性邀请；重复 inviteId/token 返回 false。 */
export function addInvite(room: RoomState, inviteId: string, inviteToken: string): boolean {
  if (!nonEmpty(inviteId) || !nonEmpty(inviteToken) || inviteToken === room.hostToken) return false;
  if (room.closed || room.invites[inviteId] || room.inviteTokens[inviteToken]) return false;
  room.invites[inviteId] = { inviteId, token: inviteToken, usedBy: null };
  room.inviteTokens[inviteToken] = inviteId;
  return true;
}

/** 玩家拿邀请 token 换绑定；邀请只能用一次。 */
export function consumeInvite(room: RoomState, inviteToken: string, binding: string, playerToken: string): JoinResult {
  if (room.closed) return { ok: false, reason: 'closed' };
  if (!nonEmpty(inviteToken) || !nonEmpty(binding) || !nonEmpty(playerToken)) return { ok: false, reason: 'invalid' };
  if (inviteToken === room.hostToken || playerToken === room.hostToken) return { ok: false, reason: 'token-collision' };
  if (room.players[binding] || room.playerTokens[playerToken]) return { ok: false, reason: 'token-collision' };
  const inviteId = room.inviteTokens[inviteToken];
  if (!inviteId) return { ok: false, reason: 'unknown-invite' };
  const invite = room.invites[inviteId];
  if (!invite || invite.usedBy) return { ok: false, reason: 'invite-used' };
  invite.usedBy = binding;
  room.players[binding] = { binding, token: playerToken, inviteId, online: true };
  room.playerTokens[playerToken] = binding;
  return { ok: true, inviteId, binding };
}

export function isHostToken(room: RoomState, token: string): boolean {
  return !room.closed && nonEmpty(token) && token === room.hostToken;
}

export function hostReconnect(room: RoomState, token: string): boolean {
  if (!isHostToken(room, token)) return false;
  room.hostOnline = true;
  return true;
}

export function hostDisconnect(room: RoomState): void {
  room.hostOnline = false;
}

/** 玩家重连：拿回同一个 binding；顺手亮起在线。 */
export function playerReconnect(room: RoomState, playerToken: string): string | null {
  if (room.closed || !nonEmpty(playerToken) || playerToken === room.hostToken) return null;
  const binding = room.playerTokens[playerToken];
  if (!binding || !room.players[binding]) return null;
  room.players[binding].online = true;
  return binding;
}

export function playerDisconnect(room: RoomState, binding: string): void {
  const p = room.players[binding];
  if (p) p.online = false;
}

export function closeRoom(room: RoomState): void {
  room.closed = true;
  room.hostOnline = false;
  room.hostToken = '';
  room.invites = {};
  room.inviteTokens = {};
  room.players = {};
  room.playerTokens = {};
}

export type RelayRoute =
  | { from: 'host'; to: string }
  | { from: 'player'; to: 'host' };

/**
 * 校验 relay 的真实路由：
 * - 主持端只能发本房间某个在线 binding；
 * - 玩家端只能回主持端，且主持端在线。
 * token 不是本房间的、房间关了、目标不在线，都返回 null。
 */
export function relayRoute(room: RoomState, role: ClientRole, token: string, to?: string): RelayRoute | null {
  if (room.closed) return null;
  if (role === 'host') {
    if (token !== room.hostToken || !room.hostOnline || !nonEmpty(to)) return null;
    const p = room.players[to];
    return p && p.online ? { from: 'host', to } : null;
  }
  if (!room.hostOnline || token === room.hostToken) return null;
  const binding = room.playerTokens[token];
  if (!binding || !room.players[binding]?.online) return null;
  return { from: 'player', to: 'host' };
}
