// 线上房间：建房、邀请、加入、重连、关房。Transport 只管收发，房间生命周期在这里。
// 主持端仍然是规则权威；服务器只保存房间元数据、邀请和绑定。
import { isRoomCreatedPayload, isRoomInvitedPayload, isRoomJoinedPayload, isRoomReconnectedPayload } from '../protocol';
import { connectRelay, type RelaySocket } from './wsSocket';
import { createWsTransport } from './transportWs';
import { registerOnlinePlayer, resetPlayerBindings, setTransport, useLocalTransport } from './sync';

export const relayUrl = (): string => {
  const env = import.meta.env;
  return env?.VITE_SERVER_URL || `ws://${location.hostname}:8787`;
};

const HOST_KEY = 'ts-online-host';
const PLAYER_KEY = 'ts-online-player';

interface HostState {
  socket: RelaySocket;
  roomId: string;
  hostToken: string;
  invites: Map<string, string>; // inviteId -> pcId
}
interface PlayerState {
  socket: RelaySocket;
  roomId: string;
  playerToken: string;
  binding: string;
}

let host: HostState | null = null;
let player: PlayerState | null = null;
const playerClosedHandlers = new Set<(reason: string) => void>();
const hostClosedHandlers = new Set<(reason: string) => void>();

/** 玩家端房间被主持人关掉/主持人掉线/房间过期时，让 UI 收掉旧世界。 */
export function onOnlinePlayerClosed(fn: (reason: string) => void): () => void {
  playerClosedHandlers.add(fn);
  return () => { playerClosedHandlers.delete(fn); };
}
const notifyPlayerClosed = (reason: string) => {
  // 房间被关掉后 playerToken 已经没用了；清掉，刷新就回本地入口，不再反复“重连失败”。
  clear(PLAYER_KEY);
  player = null;
  for (const fn of [...playerClosedHandlers]) fn(reason);
};

/** 主持端 socket 掉线 / 房间过期时通知 UI；本地窗口模式不受影响。 */
export function onOnlineHostClosed(fn: (reason: string) => void): () => void {
  hostClosedHandlers.add(fn);
  return () => { hostClosedHandlers.delete(fn); };
}
const notifyHostClosed = (reason: string) => { for (const fn of [...hostClosedHandlers]) fn(reason); };

const read = <T,>(key: string): T | null => {
  try { const v = sessionStorage.getItem(key); return v ? JSON.parse(v) as T : null; } catch { return null; }
};
const write = (key: string, value: unknown): void => {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* unavailable */ }
};
const clear = (key: string): void => {
  try { sessionStorage.removeItem(key); } catch { /* unavailable */ }
};

export function onlineHostInfo(): { roomId: string } | null {
  return host ? { roomId: host.roomId } : null;
}

/** 开一个线上房间。成功后主持端的 Transport 切到 WebSocket。 */
export async function createOnlineHostRoom(url = relayUrl()): Promise<{ roomId: string }> {
  if (host) return { roomId: host.roomId };
  const socket = await connectRelay(url);
  try {
    const created = await socket.request('room.create');
    if (!isRoomCreatedPayload(created.payload)) throw new Error('服务器没有回房间号');
    const { roomId, hostToken } = created.payload;
    const invites = new Map<string, string>();
    const transport = createWsTransport({
      role: 'host', socket, roomId, token: hostToken,
      onPeerJoined: (binding, inviteId) => {
        const pcId = invites.get(inviteId);
        if (pcId) registerOnlinePlayer(binding, pcId);
      },
      onClosed: (reason) => {
        // 主持端自己关房时 host 已经置空；只有意外掉线/过期才走这里。
        if (!host || host.socket !== socket) return;
        host = null;
        clear(HOST_KEY);
        resetPlayerBindings();
        useLocalTransport();
        notifyHostClosed(reason);
      },
    });
    // 本地窗口的旧 binding 在线上没有意义；先清，再切。
    resetPlayerBindings();
    setTransport(transport);
    host = { socket, roomId, hostToken, invites };
    write(HOST_KEY, { roomId, hostToken });
    return { roomId };
  } catch (e) {
    socket.close();
    throw e;
  }
}

/** 发一张一次性邀请。joinUrl 是服务器按 PLAYER_ORIGIN 拼的。 */
export async function inviteOnlinePlayer(pcId: string): Promise<string> {
  if (!host) throw new Error('还没开线上房间');
  const invited = await host.socket.request('room.invite', {
    roomId: host.roomId, token: host.hostToken, payload: { pcId },
  });
  if (!isRoomInvitedPayload(invited.payload)) throw new Error('服务器没有回邀请链接');
  host.invites.set(invited.payload.inviteId, pcId);
  return invited.payload.joinUrl;
}

/** 关房，切回本地窗口模式。 */
export async function closeOnlineHostRoom(): Promise<void> {
  if (!host) return;
  const current = host;
  host = null;
  clear(HOST_KEY);
  try { await current.socket.request('room.close', { roomId: current.roomId, token: current.hostToken }); } catch { /* already closed */ }
  current.socket.close();
  useLocalTransport();
  resetPlayerBindings();
}

export function onlinePlayerInfo(): { roomId: string; binding: string } | null {
  return player ? { roomId: player.roomId, binding: player.binding } : null;
}

/** 玩家用邀请链接加入；成功后玩家端的 Transport 切到 WebSocket。 */
export async function joinOnlinePlayer(roomId: string, inviteToken: string, url = relayUrl()): Promise<{ binding: string }> {
  const socket = await connectRelay(url);
  try {
    const joined = await socket.request('room.join', { roomId, token: inviteToken });
    if (!isRoomJoinedPayload(joined.payload)) throw new Error('服务器没有回绑定');
    const transport = createWsTransport({ role: 'player', socket, roomId, token: joined.payload.playerToken, onClosed: notifyPlayerClosed });
    setTransport(transport);
    player = { socket, roomId, playerToken: joined.payload.playerToken, binding: joined.payload.binding };
    write(PLAYER_KEY, { roomId: player.roomId, playerToken: player.playerToken, binding: player.binding });
    return { binding: joined.payload.binding };
  } catch (e) {
    socket.close();
    throw e;
  }
}

/** 刷新/断线后凭 playerToken 回到同一个 binding。 */
export async function reconnectOnlinePlayer(url = relayUrl()): Promise<{ binding: string }> {
  const saved = read<{ roomId: string; playerToken: string }>(PLAYER_KEY);
  if (!saved?.roomId || !saved.playerToken) throw new Error('没有可重连的房间凭据');
  const socket = await connectRelay(url);
  try {
    const re = await socket.request('room.reconnect', { roomId: saved.roomId, token: saved.playerToken });
    if (!isRoomReconnectedPayload(re.payload)) throw new Error('服务器没有回绑定');
    const transport = createWsTransport({ role: 'player', socket, roomId: saved.roomId, token: saved.playerToken, onClosed: notifyPlayerClosed });
    setTransport(transport);
    player = { socket, roomId: saved.roomId, playerToken: saved.playerToken, binding: re.payload.binding };
    write(PLAYER_KEY, { roomId: player.roomId, playerToken: player.playerToken, binding: player.binding });
    return { binding: re.payload.binding };
  } catch (e) {
    socket.close();
    throw e;
  }
}

/**
 * 玩家端入口：有邀请就加入，有旧凭据就重连，都没有就保持本地窗口模式。
 * 返回 true 表示现在走线上；失败会抛错，由 PlayerView 显示。
 */
export async function ensureOnlinePlayer(url = relayUrl()): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  const invite = params.get('invite');
  if (roomId && invite) {
    await joinOnlinePlayer(roomId, invite, url);
    // 邀请是一次性的：入房后从地址栏拿掉，刷新走 playerToken 重连。
    try {
      const keep = new URL(location.href);
      keep.searchParams.delete('invite');
      history.replaceState(null, '', keep.pathname + keep.search);
    } catch { /* unavailable */ }
    return true;
  }
  if (read<{ roomId?: string; playerToken?: string }>(PLAYER_KEY)?.playerToken) {
    await reconnectOnlinePlayer(url);
    return true;
  }
  return false;
}
