// 浏览器 WebSocket 连接 + request/response 配对。只搬 Envelope，不碰业务消息。
import { PROTOCOL_VERSION, isEnvelope, isErrorPayload, type Envelope, type EnvelopeType } from '../protocol';

export class RelayError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.name = 'RelayError';
    this.code = code;
  }
}

export interface RelaySocket {
  readonly raw: WebSocket;
  readonly open: boolean;
  /** 发一条信封，返回生成的 requestId。 */
  send(e: Omit<Envelope, 'v' | 'requestId'> & { requestId?: string }): string;
  /** 发一条信封并等同一 requestId 的回包；error 会 reject。 */
  request(type: EnvelopeType, extra?: Omit<Envelope, 'v' | 'requestId' | 'type'>): Promise<Envelope>;
  onEnvelope(fn: (e: Envelope) => void): () => void;
  /** WebSocket 关闭时通知（主动 close 也会通知一次）。 */
  onClose(fn: (reason: string) => void): () => void;
  close(): void;
}

interface Pending {
  resolve: (e: Envelope) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

export function connectRelay(url: string, timeoutMs = 10_000): Promise<RelaySocket> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (e) { reject(e instanceof Error ? e : new Error('连接失败')); return; }
    const pending = new Map<string, Pending>();
    const listeners: Array<(e: Envelope) => void> = [];
    const closeListeners: Array<(reason: string) => void> = [];
    let open = false;
    let closed = false;
    let settled = false;
    let closeNotified = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* closed */ }
      reject(new RelayError('timeout', '连接服务器超时'));
    }, timeoutMs);

    const socket: RelaySocket = {
      raw: ws,
      get open() { return open; },
      send(e) {
        const requestId = e.requestId ?? newId();
        const envelope = { v: PROTOCOL_VERSION, ...e, requestId } as Envelope;
        try { ws.send(JSON.stringify(envelope)); } catch { /* close will follow */ }
        return requestId;
      },
      request(type, extra = {}) {
        const requestId = newId();
        return new Promise<Envelope>((res, rej) => {
          const t = setTimeout(() => {
            pending.delete(requestId);
            rej(new RelayError('timeout', '服务器没有回应'));
          }, timeoutMs);
          pending.set(requestId, { resolve: res, reject: rej, timer: t });
          socket.send({ ...extra, type, requestId });
        });
      },
      onEnvelope(fn) {
        listeners.push(fn);
        return () => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      onClose(fn) {
        closeListeners.push(fn);
        return () => {
          const i = closeListeners.indexOf(fn);
          if (i >= 0) closeListeners.splice(i, 1);
        };
      },
      close() {
        if (closed) return;
        fail('连接已关闭');
        try { ws.close(); } catch { /* closed */ }
      },
    };

    ws.addEventListener('open', () => {
      open = true;
      if (!settled) { settled = true; clearTimeout(timer); resolve(socket); }
    });
    ws.addEventListener('message', (event) => {
      let msg: unknown;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (!isEnvelope(msg)) return;
      const waiting = pending.get(msg.requestId);
      if (waiting) {
        pending.delete(msg.requestId);
        clearTimeout(waiting.timer);
        if (msg.type === 'error') {
          const p = msg.payload;
          waiting.reject(isErrorPayload(p) ? new RelayError(p.code, p.message) : new RelayError('error'));
        } else {
          waiting.resolve(msg);
        }
      }
      for (const fn of [...listeners]) fn(msg);
    });
    const fail = (reason?: string) => {
      const first = !closed;
      closed = true; open = false;
      for (const [id, p] of pending) { pending.delete(id); clearTimeout(p.timer); p.reject(new RelayError('closed', reason || '连接已断开')); }
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new RelayError('closed', reason || '连接失败'));
      }
      if (first && !closeNotified) {
        closeNotified = true;
        for (const fn of [...closeListeners]) fn(reason || '连接已断开');
      }
    };
    ws.addEventListener('close', (event) => fail(event.reason || `连接关闭（${event.code}）`));
    ws.addEventListener('error', () => fail('连接失败'));
  });
}
