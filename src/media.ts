import { useEffect, useState, useSyncExternalStore } from 'react';
import type { MediaMeta } from './types';

// 媒体文件（音频/视频/图片）存在浏览器的 IndexedDB 里，世界 JSON 只存元数据。
// 主持人窗口和玩家窗口同源，所以玩家窗口可以直接读到同一份文件。
//
// 存储名（key）和媒体 ID 分开：写进去的文件永远不改。同一个 ID 换了内容（导入另一个版本的工程），
// 就用新的存储名（v:内容哈希）另存一份，旧的原样留着。所以导入、恢复、两个标签页开着不同版本，
// 谁都不会把别人正在用的文件换掉。旧数据没有 key，就按 ID 存取（老办法）。

const DB = 'ts-map-media';
const STORE = 'blobs';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 读写都等整个事务提交完才算成功（只等单个请求成功的话，磁盘满、配额不够时可能报了成功却没存上）。 */
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req.result); };
    t.onerror = () => { db.close(); reject(t.error ?? req.error); };
    t.onabort = () => { db.close(); reject(t.error ?? new Error('存储被中止（可能是空间不够）')); };
  });
}

/** 按存储名直接读写（导入时用；一般代码用下面按媒体 ID 的版本）。 */
export const putRaw = (key: string, blob: Blob) => tx('readwrite', (s) => s.put(blob, key));
export const getRaw = (key: string) => tx<Blob | undefined>('readonly', (s) => s.get(key));
export const delBlob = (key: string) => tx('readwrite', (s) => s.delete(key));

// 当前世界里媒体 ID → 存储名（世界一变，store 就调用 setMediaIndex）
let keyOf = new Map<string, string>();
let mimeOf = new Map<string, string>();
export function setMediaIndex(list: MediaMeta[]) {
  keyOf = new Map(list.map((m) => [m.id, m.key ?? m.id]));
  mimeOf = new Map(list.map((m) => [m.id, m.mime]));
}
/** 这个媒体 ID 在当前世界里存在哪。 */
export const storageKey = (id: string) => keyOf.get(id) ?? id;
export const getBlob = (id: string) => getRaw(storageKey(id));

/** 按内容算存储名：v: + SHA-256（同样的内容只存一份）。算不了哈希的环境就用随机名，照样不覆盖别的。 */
export async function contentKey(blob: Blob): Promise<string> {
  try {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
    return 'v:' + Array.from(h.slice(0, 20), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return 'v:r' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

/** 存一份新文件，返回存储名。已经有同样内容的就不再写。 */
export async function storeBlob(blob: Blob): Promise<string> {
  const key = await contentKey(blob);
  if (!(await getRaw(key))) await putRaw(key, blob);
  return key;
}

/** 浏览器里存着的全部文件的存储名，和每个的大小。 */
export async function listStored(): Promise<{ key: string; size: number }[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const out: { key: string; size: number }[] = [];
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      out.push({ key: String(c.key), size: (c.value as Blob)?.size ?? 0 });
      c.continue();
    };
    t.oncomplete = () => { db.close(); resolve(out); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error ?? new Error('读取被中止')); };
  });
}

/** 一批写入放在同一个事务里：要么全部生效，要么（任何一步出错、空间不够）一个都不生效。blob = null 表示删除。 */
export async function putBlobs(ops: { id: string; blob: Blob | null }[]): Promise<void> {
  if (!ops.length) return;
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const s = t.objectStore(STORE);
    try {
      for (const o of ops) { if (o.blob) s.put(o.blob, o.id); else s.delete(o.id); }
    } catch (e) { // 入队时就出错：主动中止，已经入队的也不生效
      try { t.abort(); } catch { /* 已经结束 */ }
      db.close();
      reject(e);
      return;
    }
    t.oncomplete = () => { db.close(); resolve(); };
    t.onerror = () => { db.close(); reject(t.error ?? new Error('写媒体文件失败')); };
    t.onabort = () => { db.close(); reject(t.error ?? new Error('写媒体文件被中止（可能是空间不够）')); };
  });
}

const urlCache = new Map<string, string>();
let version = 0;
const versionListeners = new Set<() => void>();
/** 文件被换掉以后（导入、恢复备份），把缓存的地址作废，并通知正在显示媒体的地方重新读取。 */
export function mediaChanged() {
  urlCache.forEach((u) => URL.revokeObjectURL(u));
  urlCache.clear();
  version++;
  versionListeners.forEach((l) => l());
}
export async function blobUrl(id: string): Promise<string | null> {
  // 按存储名 + 类型缓存：同一个 ID 换了内容就是另一个存储名；同样的字节可能被当成不同类型导入过（比如先是未知类型、后来是 PDF），按当前的类型重新包一下
  const key = storageKey(id), mime = mimeOf.get(id);
  const ck = `${key}|${mime ?? ''}`;
  const hit = urlCache.get(ck);
  if (hit) return hit;
  const raw = await getRaw(key);
  if (!raw) return null;
  const b = mime && raw.type !== mime ? new Blob([raw], { type: mime }) : raw;
  const u = URL.createObjectURL(b);
  urlCache.set(ck, u);
  return u;
}
const useMediaVersion = () => useSyncExternalStore((l) => { versionListeners.add(l); return () => versionListeners.delete(l); }, () => version);

/** 有现成的 blob（玩家窗口收到的）就直接用，否则去本地存储里取。 */
export function useBlobUrl(id: string | null | undefined, blob?: Blob) {
  const [url, setUrl] = useState<string | null>(null);
  const v = useMediaVersion();
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (blob) {
      const u = URL.createObjectURL(blob);
      setUrl(u);
      return () => { live = false; URL.revokeObjectURL(u); };
    }
    if (id) blobUrl(id).then((u) => live && setUrl(u)).catch(() => live && setUrl(null));
    return () => { live = false; };
  }, [id, id && storageKey(id), blob, v]);
  return url;
}
