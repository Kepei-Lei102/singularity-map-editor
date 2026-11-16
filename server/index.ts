// 转发型 WebSocket 服务器：房间、邀请、绑定、reconnect、relay。
// 不解析 payload 里的 world，不算规则，不落盘。
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket as WsSocket } from 'ws';
import {
  PROTOCOL_VERSION, clientCanSend, isEnvelope, relayShapeOk,
  type ClientRole, type Envelope, type EnvelopeType, type ErrorPayload,
} from '../src/protocol';
import { RoomService } from './rooms';

export interface ServerOptions {
  port?: number;
  host?: string;
  playerOrigin?: string;
  allowedOrigins?: string[];
  now?: () => number;
  roomTtlMs?: number;
  sweepIntervalMs?: number;
  maxMessageBytes?: number;
  maxRooms?: number;
  maxConnections?: number;
  allowNoOrigin?: boolean;
}

export interface StartedServer {
  http: HttpServer;
  wss: WebSocketServer;
  rooms: RoomService;
  port: number;
  listening: Promise<void>;
  /** 手动跑一次过期清理；测试和运维用。 */
  sweep: () => number;
  close: () => Promise<void>;
}

interface Conn {
  ws: WsSocket;
  role?: ClientRole;
  roomId?: string;
  token?: string;
  binding?: string;
  /** 被同 binding 的新连接替换掉：旧连接关掉时不再发 peer.left。 */
  replaced?: boolean;
  createdAt: number;
  windowStart: number;
  windowCount: number;
}

interface RoomConns {
  host?: Conn;
  players: Map<string, Conn>;
}

const RATE_WINDOW_MS = 1000;
const RATE_MAX = 60;
const DEFAULT_ORIGINS = [
  'http://localhost:5178', 'http://localhost:5179',
  'http://127.0.0.1:5178', 'http://127.0.0.1:5179',
];

const newToken = () => randomBytes(24).toString('base64url');
const newRoomId = () => randomBytes(6).toString('base64url');
const newInviteId = () => randomBytes(6).toString('base64url');
const newBinding = () => randomBytes(9).toString('base64url');

const envelope = (type: EnvelopeType, requestId: string, extra: Partial<Envelope> = {}): Envelope => ({
  v: PROTOCOL_VERSION, type, requestId, ...extra,
});

const errorPayload = (code: string, message: string): ErrorPayload => ({ code, message });

export function createServer(options: ServerOptions = {}): StartedServer {
  const rooms = new RoomService({ now: options.now, ttlMs: options.roomTtlMs });
  const roomConns = new Map<string, RoomConns>();
  const playerOrigin = options.playerOrigin ?? process.env.PLAYER_ORIGIN ?? 'http://localhost:5179';
  const envOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  const allowedOrigins = options.allowedOrigins ?? (envOrigins.length ? envOrigins : DEFAULT_ORIGINS);
  const allowNoOrigin = options.allowNoOrigin ?? process.env.NODE_ENV !== 'production';
  const maxMessageBytes = options.maxMessageBytes ?? Number(process.env.MAX_MESSAGE_BYTES ?? 8 * 1024 * 1024);
  const maxRooms = options.maxRooms ?? Number(process.env.MAX_ROOMS ?? 1000);
  const maxConnections = options.maxConnections ?? Number(process.env.MAX_CONNECTIONS ?? 2000);
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;

  const http = createHttpServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({
    server: http,
    maxPayload: maxMessageBytes,
    verifyClient: (info, done) => {
      const origin = info.origin;
      // 非浏览器客户端没有 Origin：开发/测试放行，生产必须显式给 ALLOWED_ORIGINS 或 allowNoOrigin。
      if (!origin) return done(allowNoOrigin);
      done(allowedOrigins.includes(origin));
    },
  });

  const conns = new Set<Conn>();

  const send = (conn: Conn, msg: Envelope) => {
    try { conn.ws.send(JSON.stringify(msg)); } catch { /* closed */ }
  };

  const sendError = (conn: Conn, requestId: string, code: string, message: string) => {
    send(conn, envelope('error', requestId, { roomId: conn.roomId, payload: errorPayload(code, message) }));
  };

  const roomMap = (id: string): RoomConns => {
    let entry = roomConns.get(id);
    if (!entry) { entry = { players: new Map() }; roomConns.set(id, entry); }
    return entry;
  };

  const notifyHost = (room: string, msg: Envelope) => {
    const host = roomConns.get(room)?.host;
    if (host) send(host, msg);
  };

  const bindRoom = (conn: Conn, id: string) => {
    const entry = roomMap(id);
    if (conn.role === 'host') entry.host = conn;
    else if (conn.role === 'player' && conn.binding) entry.players.set(conn.binding, conn);
  };

  const unbindRoom = (conn: Conn) => {
    if (!conn.roomId) return;
    const entry = roomConns.get(conn.roomId);
    if (!entry) return;
    if (entry.host === conn) delete entry.host;
    // 重连过的玩家可能已经被新连接替换：旧连接关掉时不能把新连接从房间表里删掉。
    if (conn.binding && entry.players.get(conn.binding) === conn) entry.players.delete(conn.binding);
  };

  const handle = (conn: Conn, raw: unknown) => {
    if (!isEnvelope(raw)) {
      sendError(conn, '0', 'bad-envelope', '信封不合法');
      return;
    }
    const msg = raw;
    const requestId = msg.requestId;
    // from 只由服务器下行填；客户端上行带 from 一律不认。
    if (msg.from !== undefined) return sendError(conn, requestId, 'bad-envelope', '客户端不能带 from');

    // 速率限制：粗粒度，够挡住刷屏；不是安全边界。
    const now = Date.now();
    if (now - conn.windowStart > RATE_WINDOW_MS) { conn.windowStart = now; conn.windowCount = 0; }
    if (++conn.windowCount > RATE_MAX) {
      sendError(conn, requestId, 'rate-limit', '发得太快');
      return;
    }

    if (conn.replaced) return sendError(conn, requestId, 'replaced', '这条连接已被重连替换');

    // 角色未定时只允许建房/加入/重连。
    if (!conn.role) {
      if (msg.type === 'room.create') {
        if (msg.roomId) return sendError(conn, requestId, 'bad-request', '建房不带 roomId');
        if (rooms.size() >= maxRooms) return sendError(conn, requestId, 'room-limit', '服务器房间满了');
        let id = newRoomId();
        let hostToken = newToken();
        while (!rooms.create(id, hostToken)) { id = newRoomId(); hostToken = newToken(); }
        conn.role = 'host'; conn.roomId = id; conn.token = hostToken;
        bindRoom(conn, id);
        send(conn, envelope('room.created', requestId, { roomId: id, payload: { roomId: id, hostToken } }));
        return;
      }
      if (msg.type === 'room.join') {
        if (!msg.roomId || !msg.token) return sendError(conn, requestId, 'bad-request', '加入要 roomId + inviteToken');
        const binding = newBinding();
        const playerToken = newToken();
        const result = rooms.join(msg.roomId, msg.token, binding, playerToken);
        if (!result.ok) return sendError(conn, requestId, 'join-failed', result.reason);
        conn.role = 'player'; conn.roomId = msg.roomId; conn.token = playerToken; conn.binding = binding;
        bindRoom(conn, msg.roomId);
        send(conn, envelope('room.joined', requestId, { roomId: msg.roomId, payload: { binding, playerToken } }));
        notifyHost(msg.roomId, envelope('peer.joined', requestId, {
          roomId: msg.roomId, payload: { inviteId: result.inviteId, binding },
        }));
        return;
      }
      if (msg.type === 'room.reconnect') {
        if (!msg.roomId || !msg.token) return sendError(conn, requestId, 'bad-request', '重连要 roomId + playerToken');
        const result = rooms.reconnect(msg.roomId, msg.token);
        if (!result) return sendError(conn, requestId, 'reconnect-failed', '重连失败');
        const old = roomConns.get(msg.roomId)?.players.get(result.binding);
        if (old && old !== conn) {
          // 同 binding 的新连接顶掉旧的：旧连接标死、从房间表摘掉、关掉；它的 close 不再发 peer.left。
          old.replaced = true;
          roomConns.get(msg.roomId)?.players.delete(result.binding);
          try { old.ws.close(4001, 'reconnected'); } catch { /* closed */ }
        }
        conn.role = 'player'; conn.roomId = msg.roomId; conn.token = msg.token; conn.binding = result.binding;
        bindRoom(conn, msg.roomId);
        send(conn, envelope('room.reconnected', requestId, {
          roomId: msg.roomId, payload: { binding: result.binding },
        }));
        notifyHost(msg.roomId, envelope('peer.joined', requestId, {
          roomId: msg.roomId, payload: { inviteId: result.room.players[result.binding]?.inviteId ?? '', binding: result.binding },
        }));
        return;
      }
      return sendError(conn, requestId, 'bad-role', '先建房或加入房间');
    }

    if (!clientCanSend(conn.role, msg.type)) return sendError(conn, requestId, 'not-allowed', '这个角色不能发这条消息');

    if (msg.type === 'room.invite') {
      if (conn.role !== 'host' || msg.roomId !== conn.roomId || msg.token !== conn.token) {
        return sendError(conn, requestId, 'not-allowed', '邀请只能由本房间主持发');
      }
      const id = newInviteId();
      const secret = newToken();
      if (!rooms.issueInvite(conn.roomId!, conn.token!, id, secret)) {
        return sendError(conn, requestId, 'invite-failed', '邀请发不出去');
      }
      const joinUrl = `${playerOrigin.replace(/\/$/, '')}/?room=${encodeURIComponent(conn.roomId!)}&invite=${encodeURIComponent(secret)}`;
      send(conn, envelope('room.invited', requestId, {
        roomId: conn.roomId, payload: { inviteId: id, inviteToken: secret, joinUrl },
      }));
      return;
    }

    if (msg.type === 'room.relay') {
      if (msg.roomId !== conn.roomId || msg.token !== conn.token) {
        return sendError(conn, requestId, 'not-allowed', '房间或凭据不匹配');
      }
      if (!relayShapeOk(conn.role, msg)) return sendError(conn, requestId, 'bad-relay', 'relay 形状不对');
      const result = rooms.relay(conn.roomId!, conn.role, conn.token!, msg.to);
      if (!result) return sendError(conn, requestId, 'relay-failed', '目标不在线');
      const entry = roomConns.get(conn.roomId!);
      if (result.route.from === 'host') {
        if (!msg.to) return sendError(conn, requestId, 'relay-failed', '目标不在线');
        const target = entry?.players.get(msg.to);
        if (!target) return sendError(conn, requestId, 'relay-failed', '目标不在线');
        send(target, envelope('room.relay', requestId, { roomId: conn.roomId, from: 'host', payload: msg.payload }));
        return;
      }
      const host = entry?.host;
      if (!host) return sendError(conn, requestId, 'relay-failed', '主持不在线');
      send(host, envelope('room.relay', requestId, { roomId: conn.roomId, from: conn.binding, payload: msg.payload }));
      return;
    }

    if (msg.type === 'room.close') {
      if (conn.role !== 'host' || msg.roomId !== conn.roomId || msg.token !== conn.token) {
        return sendError(conn, requestId, 'not-allowed', '只有本房间主持能关房');
      }
      const state = rooms.close(conn.roomId!, conn.token!);
      if (!state) return sendError(conn, requestId, 'close-failed', '关房失败');
      const entry = roomConns.get(conn.roomId!);
      send(conn, envelope('room.closed', requestId, { roomId: conn.roomId, payload: { reason: 'host-closed' } }));
      for (const player of entry?.players.values() ?? []) {
        send(player, envelope('room.closed', requestId, { roomId: conn.roomId, payload: { reason: 'host-closed' } }));
      }
      roomConns.delete(conn.roomId!);
      return;
    }

    sendError(conn, requestId, 'bad-request', '未知消息');
  };

  wss.on('connection', (ws) => {
    if (conns.size >= maxConnections) { try { ws.close(1013, 'server busy'); } catch { /* closed */ } return; }
    const conn: Conn = { ws, createdAt: Date.now(), windowStart: Date.now(), windowCount: 0 };
    conns.add(conn);
    ws.on('message', (data) => {
      try { handle(conn, JSON.parse(data.toString())); } catch { sendError(conn, '0', 'bad-json', '不是 JSON'); }
    });
    ws.on('close', () => {
      conns.delete(conn);
      const entry = conn.roomId ? roomConns.get(conn.roomId) : undefined;
      const stillBound = !!(conn.role === 'player' && conn.binding && !conn.replaced && entry?.players.get(conn.binding) === conn);
      unbindRoom(conn);
      if (conn.roomId && conn.role === 'player' && conn.binding && stillBound) {
        const state = rooms.playerDisconnected(conn.roomId, conn.binding);
        if (state) notifyHost(conn.roomId, envelope('peer.left', `left-${conn.binding}`, {
          roomId: conn.roomId, payload: { binding: conn.binding },
        }));
      }
      if (conn.roomId && conn.role === 'host') {
        rooms.close(conn.roomId, conn.token!);
        const entry = roomConns.get(conn.roomId);
        for (const player of entry?.players.values() ?? []) {
          send(player, envelope('room.closed', 'host-left', { roomId: conn.roomId, payload: { reason: 'host-disconnected' } }));
        }
        roomConns.delete(conn.roomId);
      }
    });
    ws.on('error', () => { /* close will follow */ });
  });

  const port = options.port ?? Number(process.env.PORT ?? 8787);
  const host = options.host ?? '0.0.0.0';
  const listening = new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => resolve());
  });

  const sweepRooms = (): number => {
    const gone = rooms.sweep();
    for (const id of gone) {
      const entry = roomConns.get(id);
      for (const player of entry?.players.values() ?? []) {
        send(player, envelope('room.closed', `expired-${id}`, { roomId: id, payload: { reason: 'expired' } }));
      }
      if (entry?.host) send(entry.host, envelope('room.closed', `expired-${id}`, { roomId: id, payload: { reason: 'expired' } }));
      roomConns.delete(id);
    }
    return gone.length;
  };
  const sweeper = setInterval(sweepRooms, sweepIntervalMs);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  const started: StartedServer = {
    http, wss, rooms, port, listening,
    sweep: sweepRooms,
    close: async () => {
      clearInterval(sweeper);
      for (const conn of conns) { try { conn.ws.close(); } catch { /* closed */ } }
      conns.clear(); roomConns.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
  return started;
}

export async function startServer(options: ServerOptions = {}): Promise<StartedServer> {
  const server = createServer(options);
  await server.listening;
  const address = server.http.address();
  if (address && typeof address === 'object') server.port = address.port;
  return server;
}
