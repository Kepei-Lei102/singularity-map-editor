import { contentKey, getRaw, putRaw } from './media';
import type { AssetBody, AssetFailReason, SyncMsg } from './messages';

// 线上房间的媒体文件不能塞进 world JSON。这里只搬字节，不碰规则：
// 玩家按 world.media 里的存储名发出请求，主持端只发这个 binding 被允许的 key；
// 256 KiB 一块、base64 走现有 relay，服务器不解析 payload。
export const ASSET_CHUNK_BYTES = 256 * 1024;
export const ASSET_MAX_BYTES = 64 * 1024 * 1024;
export const ASSET_MAX_KEYS = 32;
export const ASSET_QUEUE_TIMEOUT_MS = 120_000;
/** 主持端读文件卡住时别把整批吊死；超时就当这份文件没了。 */
export const ASSET_LOAD_TIMEOUT_MS = 30_000;
/** 单块从 Blob 读出来也设上限；卡住就按 read-failed 停这个 key。 */
export const ASSET_SLICE_TIMEOUT_MS = 15_000;
/** 缺文件/被拒/校验失败后先别每帧重问；15 秒后再试一次。 */
export const ASSET_FAIL_COOLDOWN_MS = 15_000;
/** 单条 binding 的基线间隔：一块 45ms，约 22 块/秒。 */
export const ASSET_PACE_MS = 45;
/** 全局 token：一块 20ms，约 50 块/秒，给 world/判定/说话留出每连接 60 条/秒的余量。
 *  12 个玩家一起拉时按 binding 轮转，不会让一个人独占全局预算。 */
export const ASSET_GLOBAL_TOKEN_MS = 20;
const MAX_CHUNKS = Math.ceil(ASSET_MAX_BYTES / ASSET_CHUNK_BYTES);
const HASHED_KEY = /^v:[0-9a-f]{40}$/;

export function assetKeyOf(meta: { id: string; key?: string }): string {
  return meta.key ?? meta.id;
}

export function isAssetRequest(m: SyncMsg): m is SyncMsg & Extract<AssetBody, { type: 'asset-request' }> {
  return m.type === 'asset-request' && !!m && typeof m.requestId === 'string' && Array.isArray(m.keys);
}
export function isAssetChunk(m: SyncMsg): m is SyncMsg & Extract<AssetBody, { type: 'asset-chunk' }> {
  return m.type === 'asset-chunk';
}
export function isAssetEnd(m: SyncMsg): m is SyncMsg & Extract<AssetBody, { type: 'asset-end' }> {
  return m.type === 'asset-end';
}
export function isAssetFail(m: SyncMsg): m is SyncMsg & Extract<AssetBody, { type: 'asset-fail' }> {
  return m.type === 'asset-fail';
}
export function isAssetMessage(m: SyncMsg): m is SyncMsg & AssetBody {
  return m.type === 'asset-start' || m.type === 'asset-chunk' || m.type === 'asset-end' || m.type === 'asset-fail';
}
export function isAssetCancel(m: SyncMsg): m is SyncMsg & Extract<AssetBody, { type: 'asset-cancel' }> {
  return m.type === 'asset-cancel';
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  // 一次只展开 32 KiB，避免 String.fromCharCode 参数过多把调用栈撑爆。
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function base64ToBytes(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 主持端发送调度：每个 binding 至少隔 paceMs 一块；全局每 ASSET_GLOBAL_TOKEN_MS 只发一块。
 * 等 token 的 binding 按“上次发得最早”轮转，避免 12 个玩家时某个 binding 把队列占满。
 */
export class AssetPacer {
  private queue: { binding: string; paceMs: number; resolve: () => void }[] = [];
  private last = new Map<string, number>();
  private nextGlobal = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  wait(binding: string, paceMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ binding: binding || '', paceMs: Math.max(0, paceMs), resolve });
      this.pump();
    });
  }

  private readyAt(job: { binding: string; paceMs: number }): number {
    return (this.last.get(job.binding) ?? 0) + job.paceMs;
  }

  private pump(): void {
    if (!this.queue.length) return;
    const now = Date.now();
    if (now < this.nextGlobal) { this.arm(this.nextGlobal - now); return; }
    const ready = this.queue.filter((job) => this.readyAt(job) <= now);
    if (!ready.length) {
      let at = Infinity;
      for (const job of this.queue) at = Math.min(at, this.readyAt(job));
      this.arm(Math.max(0, at - now));
      return;
    }
    // 上次最早发的那条 binding 先走；没发过的 binding 优先。
    let chosen = ready[0];
    let chosenLast = this.last.get(chosen.binding) ?? -Infinity;
    for (const job of ready) {
      const last = this.last.get(job.binding) ?? -Infinity;
      if (last < chosenLast) { chosen = job; chosenLast = last; }
    }
    const index = this.queue.indexOf(chosen);
    if (index >= 0) this.queue.splice(index, 1);
    this.last.set(chosen.binding, now);
    this.nextGlobal = now + ASSET_GLOBAL_TOKEN_MS;
    chosen.resolve();
    if (this.queue.length) this.arm(this.nextGlobal - Date.now());
  }

  private arm(ms: number): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, Math.max(0, ms));
  }
}
const assetPacer = new AssetPacer();

async function paced<T>(binding: string | undefined, fn: () => T, paceMs: number): Promise<T> {
  if (paceMs <= 0) return fn();
  await assetPacer.wait(binding ?? '', paceMs);
  return fn();
}

export interface ServeAssetOptions {
  send: (body: AssetBody) => boolean;
  load: (key: string) => Promise<Blob | undefined>;
  /** 只有当前 binding 的玩家世界允许的 key 才返回 meta；返回 undefined 就是 forbidden。 */
  meta: (key: string) => { mime: string; size?: number } | undefined;
  paceMs?: number;
  maxBytes?: number;
  /** 发送调度按 binding 分：同一个人不会把全局 token 占满。 */
  binding?: string;
  /** 主持端 load 的超时；默认 30 秒，0 表示不设。 */
  loadTimeoutMs?: number;
  /** 主持端从 Blob 切片读字节的超时；默认 15 秒，0 表示不设。 */
  sliceTimeoutMs?: number;
  /** 玩家发来 asset-cancel / 世界换掉 allow 时，下一块前停下。 */
  isCancelled?: (key?: string) => boolean;
}

/** 主持端把一个请求逐块发完。失败只发 asset-fail，不把主机路径、文件名或错误栈带出去。 */
export async function serveAssetRequest(
  request: Extract<AssetBody, { type: 'asset-request' }>,
  opts: ServeAssetOptions,
): Promise<void> {
  const keys = [...new Set((Array.isArray(request.keys) ? request.keys : []).filter((k) => typeof k === 'string' && k.length > 0))].slice(0, ASSET_MAX_KEYS);
  const maxBytes = opts.maxBytes ?? ASSET_MAX_BYTES;
  const paceMs = opts.paceMs ?? ASSET_PACE_MS;
  const loadTimeoutMs = opts.loadTimeoutMs ?? ASSET_LOAD_TIMEOUT_MS;
  const sliceTimeoutMs = opts.sliceTimeoutMs ?? ASSET_SLICE_TIMEOUT_MS;
  const fail = async (key: string, reason: AssetFailReason): Promise<boolean> => {
    // allow 被撤走时不能再说 missing/too-large/read-failed，统一按 forbidden 回。
    const liveReason = opts.meta(key) ? reason : 'forbidden';
    return paced(opts.binding, () => opts.send({ type: 'asset-fail', requestId: request.requestId, key, reason: liveReason }), paceMs);
  };
  for (const key of keys) {
    if (opts.isCancelled?.(key)) continue;
    const candidate = opts.meta(key);
    if (!candidate) { await fail(key, 'forbidden'); continue; }
    if (typeof candidate.size === 'number' && candidate.size > maxBytes) { await fail(key, 'too-large'); continue; }
    let blob: Blob | undefined;
    try {
      const loading = opts.load(key);
      if (loadTimeoutMs) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), loadTimeoutMs); (timer as unknown as { unref?: () => void }).unref?.(); });
        try { blob = await Promise.race([loading, timedOut]); } finally { if (timer !== undefined) clearTimeout(timer); }
      } else blob = await loading;
    } catch { await fail(key, 'read-failed'); continue; }
    if (!blob) { await fail(key, 'missing'); continue; }
    if (blob.size > maxBytes) { await fail(key, 'too-large'); continue; }
    // load 可能花了几秒：发 start 前再查一次取消/allow，别在玩家已经走了之后才开始。
    if (opts.isCancelled?.(key)) continue;
    if (!opts.meta(key)) { await fail(key, 'forbidden'); continue; }
    // 文件确实存在、要开始发了，才让玩家把“排队 watchdog”换成这个 key 的 inactivity timer。
    let startAborted = false;
    let startRevoked = false;
    const started = await paced(opts.binding, () => {
      if (opts.isCancelled?.(key)) { startAborted = true; return false; }
      if (!opts.meta(key)) { startRevoked = true; return false; }
      // bytes 让玩家端能显示进度；旧玩家端会忽略这个可选字段。
      return opts.send({ type: 'asset-start', requestId: request.requestId, key, bytes: blob.size });
    }, paceMs);
    if (!started) {
      // 这个 key 的 allow 在窗口里被撤：回 forbidden 后继续处理同批后面的 key。
      if (startRevoked) { await fail(key, 'forbidden'); continue; }
      if (startAborted) continue;
      return;
    }
    const mime = candidate.mime || 'application/octet-stream';
    const count = Math.max(1, Math.ceil(blob.size / ASSET_CHUNK_BYTES));
    let completed = true;
    for (let index = 0; index < count; index++) {
      // world 更新可能把 key 收走；发到一半权限没了/玩家取消就停，剩下的不发。
      if (opts.isCancelled?.(key)) { completed = false; break; }
      const live = opts.meta(key);
      if (!live) { await fail(key, 'forbidden'); completed = false; break; }
      const start = index * ASSET_CHUNK_BYTES;
      let chunk: Uint8Array;
      try {
        const reading = blob.slice(start, Math.min(start + ASSET_CHUNK_BYTES, blob.size)).arrayBuffer();
        if (sliceTimeoutMs) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timedOut = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('slice timeout')), sliceTimeoutMs); (timer as unknown as { unref?: () => void }).unref?.(); });
          try { chunk = new Uint8Array(await Promise.race([reading, timedOut])); } finally { if (timer !== undefined) clearTimeout(timer); }
        } else chunk = new Uint8Array(await reading);
      } catch { await fail(key, 'read-failed'); completed = false; break; }
      let chunkRevoked = false;
      let chunkFailed = false;
      const ok = await paced(opts.binding, () => {
        // 节流等待期间 allow/cancel 都可能到；发出前再看一眼。
        if (opts.isCancelled?.(key)) return false;
        if (!opts.meta(key)) { chunkRevoked = true; return false; }
        const sent = opts.send({ type: 'asset-chunk', requestId: request.requestId, key, mime, index, count, data: bytesToBase64(chunk) });
        if (!sent) chunkFailed = true;
        return sent;
      }, paceMs);
      if (!ok) {
        if (chunkRevoked) { await fail(key, 'forbidden'); completed = false; break; }
        if (chunkFailed) return;
        completed = false; break; // 单个 key 取消，只停这个 key，同批后面的还能继续
      }
    }
    if (!completed) continue;
    // 最后一块之后 allow 也可能刚被撤；end 前再查一次，避免把已无权文件标完。
    if (!opts.meta(key)) { await fail(key, 'forbidden'); continue; }
    if (opts.isCancelled?.(key)) continue;
    let endCanceled = false;
    let endRevoked = false;
    const ok = await paced(opts.binding, () => {
      // 节流等待期间 cancel/allow 都可能变；进发送前再查一次。
      if (opts.isCancelled?.(key)) { endCanceled = true; return false; }
      if (!opts.meta(key)) { endRevoked = true; return false; }
      return opts.send({ type: 'asset-end', requestId: request.requestId, key, bytes: blob.size });
    }, paceMs);
    if (!ok) {
      // 单个 key 被取消/没权限只跳过这个 key；send 本身失败才停整批。
      if (endRevoked) await fail(key, 'forbidden');
      if (endCanceled) continue;
      if (endRevoked) continue;
      return;
    }
  }
}

export interface AssetReceiverOptions {
  send: (body: AssetBody) => void;
  /** 不传就按本地媒体库查/写；测试可以注入。 */
  load?: (key: string) => Promise<Blob | undefined>;
  save?: (key: string, blob: Blob) => Promise<void>;
  onReady?: (key: string) => void;
  onFail?: (key: string, reason: AssetFailReason) => void;
  /** 已收到多少字节/总共多少；start 时 total 可能未知。 */
  onProgress?: (key: string, received: number, total?: number) => void;
  maxBytes?: number;
  /** 0 表示不设超时；默认 30 秒 inactivity。 */
  timeoutMs?: number;
  /** 从请求发出到收到 asset-start 的排队上限，默认 120 秒。 */
  queueTimeoutMs?: number;
}

interface Incoming {
  requestId: string;
  started: boolean;
  gen: number;
  count: number;
  mime: string;
  parts: Uint8Array[];
  bytes: number;
  totalBytes?: number;
  finishing: boolean;
}

/** 玩家端收文件：按 key 拼块，v: 哈希能校验就校验，失败最多重试一次。 */
export interface AssetReceiver {
  request(keys: string[]): Promise<void>;
  /** 用户明确点重试：绕过一次失败冷却，其他规则和 request 一样。 */
  retry(keys: string[]): Promise<void>;
  handle(body: AssetBody): void;
  /** 只取消这几个 key 的在途请求（stop/切媒体时用），不标记失败。 */
  cancel(keys: string[]): void;
  reset(): void;
}

export function createAssetReceiver(opts: AssetReceiverOptions): AssetReceiver {
  const load = opts.load ?? getRaw;
  const save = opts.save ?? putRaw;
  const maxBytes = opts.maxBytes ?? ASSET_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const queueTimeoutMs = opts.queueTimeoutMs ?? (timeoutMs ? ASSET_QUEUE_TIMEOUT_MS : 0);
  const pending = new Map<string, Incoming>();
  const requests = new Map<string, Set<string>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const known = new Set<string>();
  const failed = new Map<string, number>();
  const retried = new Set<string>();
  const requesting = new Set<string>();
  let generation = 0;
  let n = 0;
  const newRequestId = () => `ar-${Date.now().toString(36)}-${(++n).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const forget = (requestId: string, key: string) => {
    const set = requests.get(requestId);
    if (!set) return;
    set.delete(key);
    if (!set.size) requests.delete(requestId);
  };

  const clearKeyTimer = (key: string) => {
    const timer = timers.get(key);
    if (timer !== undefined) { clearTimeout(timer); timers.delete(key); }
  };

  /** 每个 key 自己的 inactivity timer：收到一块就续，不是整批 32 个 key 共用一个死线。 */
  const armKeyTimeout = (key: string, requestId: string, ms: number) => {
    clearKeyTimer(key);
    if (!ms) return;
    const timer = setTimeout(() => {
      const p = pending.get(key);
      if (!p || p.requestId !== requestId) return;
      pending.delete(key);
      timers.delete(key);
      forget(requestId, key);
      failed.set(key, Date.now());
      // 只取消这一个 key：同批其他文件还在传，别一起砍。
      opts.send({ type: 'asset-cancel', requestId, key });
      opts.onFail?.(key, 'read-failed');
    }, ms);
    // Node 测试里未完成请求不该把进程吊住；浏览器没有 unref。
    (timer as unknown as { unref?: () => void }).unref?.();
    timers.set(key, timer);
  };

  /** 同一批里只要有一个 key 开始传，就把还没开始的 key 的排队死线往后延；
   *  否则 32 个 key 串行传时，后面几个会在自己还没轮到就排队超时。 */
  const refreshQueued = (requestId: string) => {
    if (!queueTimeoutMs) return;
    const keys = requests.get(requestId);
    if (!keys) return;
    for (const key of keys) {
      const p = pending.get(key);
      if (!p || p.started) continue;
      armKeyTimeout(key, requestId, queueTimeoutMs);
    }
  };

  async function finish(key: string, p: Incoming): Promise<void> {
    if (p.finishing || p.gen !== generation) return;
    p.finishing = true;
    const blob = new Blob(p.parts, { type: p.mime || 'application/octet-stream' });
    if (HASHED_KEY.test(key)) {
      let got = '';
      try { got = await contentKey(blob); } catch { /* 没有 crypto 时 contentKey 会回随机名，下面当校验失败 */ }
      if (p.gen !== generation) return;
      if (got !== key) {
        pending.delete(key);
        forget(p.requestId, key);
        if (!retried.has(key)) {
          retried.add(key);
          await request([key]);
        } else {
          failed.set(key, Date.now());
          opts.onFail?.(key, 'read-failed');
        }
        return;
      }
    }
    if (p.gen !== generation) return;
    try {
      await save(key, blob);
      if (p.gen !== generation) return;
      known.add(key);
      failed.delete(key);
    } catch {
      if (p.gen !== generation) return;
      pending.delete(key);
      failed.set(key, Date.now());
      opts.onFail?.(key, 'read-failed');
      return;
    }
    pending.delete(key);
    opts.onProgress?.(key, p.bytes, p.totalBytes); // 不知道总大小时不假装 100%
    opts.onReady?.(key);
  }

  async function request(keys: string[]): Promise<void> {
    const gen = generation;
    const unique = [...new Set((Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && k.length > 0))];
    const missing: string[] = [];
    for (const key of unique) {
      if (pending.has(key) || known.has(key) || requesting.has(key)) continue;
      const failedAt = failed.get(key);
      if (failedAt && Date.now() - failedAt < ASSET_FAIL_COOLDOWN_MS) continue;
      failed.delete(key);
      requesting.add(key);
      let cached: Blob | undefined;
      try { cached = await load(key); } catch { cached = undefined; }
      if (gen !== generation) return;
      requesting.delete(key);
      if (cached) known.add(key);
      else missing.push(key);
    }
    for (let i = 0; i < missing.length; i += ASSET_MAX_KEYS) {
      if (gen !== generation) return;
      const batch = missing.slice(i, i + ASSET_MAX_KEYS);
      const requestId = newRequestId();
      requests.set(requestId, new Set(batch));
      for (const key of batch) { pending.set(key, { requestId, started: false, gen: generation, count: 0, mime: '', parts: [], bytes: 0, finishing: false }); armKeyTimeout(key, requestId, queueTimeoutMs); }
      opts.send({ type: 'asset-request', requestId, keys: batch });
    }
  }

  async function retry(keys: string[]): Promise<void> {
    const list = (Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && k.length > 0);
    for (const key of list) failed.delete(key);
    return request(list);
  }

  function handle(body: AssetBody): void {
    if (body.type === 'asset-start') {
      const p = pending.get(body.key);
      if (!p || p.requestId !== body.requestId) return;
      if (p.started) return; // 重复 start 不能把 inactivity 无限往后推
      p.started = true;
      if (typeof body.bytes === 'number' && Number.isFinite(body.bytes) && body.bytes >= 0) p.totalBytes = body.bytes;
      // host 真开始发这个 key 了，排队 watchdog 换成 inactivity timer。
      armKeyTimeout(body.key, body.requestId, timeoutMs);
      refreshQueued(body.requestId);
      opts.onProgress?.(body.key, 0, p.totalBytes);
      return;
    }
    if (body.type === 'asset-fail') {
      const p = pending.get(body.key);
      if (!p || p.requestId !== body.requestId) return;
      pending.delete(body.key);
      clearKeyTimer(body.key);
      forget(body.requestId, body.key);
      failed.set(body.key, Date.now());
      opts.onFail?.(body.key, body.reason);
      return;
    }
    if (body.type === 'asset-chunk') {
      const p = pending.get(body.key);
      if (!p || p.requestId !== body.requestId || !p.started) return;
      if (typeof body.data !== 'string' || !Number.isInteger(body.index) || !Number.isInteger(body.count)) return;
      if (body.count < 1 || body.count > MAX_CHUNKS || body.index < 0 || body.index >= body.count) return;
      if (p.count && p.count !== body.count) { pending.delete(body.key); clearKeyTimer(body.key); forget(body.requestId, body.key); failed.set(body.key, Date.now()); opts.onFail?.(body.key, 'read-failed'); return; }
      if (p.count === 0) p.count = body.count;
      if (!p.mime && typeof body.mime === 'string') p.mime = body.mime;
      if (p.parts[body.index]) return;
      let chunk: Uint8Array;
      try { chunk = base64ToBytes(body.data); } catch { pending.delete(body.key); clearKeyTimer(body.key); forget(body.requestId, body.key); failed.set(body.key, Date.now()); opts.onFail?.(body.key, 'read-failed'); return; }
      if (chunk.length > ASSET_CHUNK_BYTES) { pending.delete(body.key); clearKeyTimer(body.key); forget(body.requestId, body.key); failed.set(body.key, Date.now()); opts.onFail?.(body.key, 'too-large'); return; }
      if (p.bytes + chunk.length > maxBytes) { pending.delete(body.key); clearKeyTimer(body.key); forget(body.requestId, body.key); failed.set(body.key, Date.now()); opts.onFail?.(body.key, 'too-large'); return; }
      p.parts[body.index] = chunk;
      p.bytes += chunk.length;
      armKeyTimeout(body.key, body.requestId, timeoutMs);
      opts.onProgress?.(body.key, p.bytes, p.totalBytes);
      return;
    }
    if (body.type === 'asset-end') {
      const p = pending.get(body.key);
      if (!p || p.requestId !== body.requestId || !p.started) return;
      if (!p.count || p.parts.filter(Boolean).length !== p.count || p.bytes !== body.bytes) {
        pending.delete(body.key);
        clearKeyTimer(body.key);
        forget(body.requestId, body.key);
        failed.set(body.key, Date.now());
        opts.onFail?.(body.key, 'read-failed');
        return;
      }
      clearKeyTimer(body.key);
      forget(body.requestId, body.key);
      void finish(body.key, p);
    }
  }

  function cancel(keys: string[]): void {
    for (const key of [...new Set((Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && k.length > 0))]) {
      const p = pending.get(key);
      if (!p) continue;
      pending.delete(key);
      clearKeyTimer(key);
      forget(p.requestId, key);
      opts.send({ type: 'asset-cancel', requestId: p.requestId, key });
    }
  }

  function reset(): void {
    generation++;
    for (const requestId of [...requests.keys()]) opts.send({ type: 'asset-cancel', requestId });
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
    pending.clear();
    requests.clear();
    known.clear();
    failed.clear();
    retried.clear();
    requesting.clear();
  }

  return { request, retry, handle, cancel, reset };
}
