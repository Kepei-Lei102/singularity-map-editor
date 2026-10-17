import { useEffect, useState, useSyncExternalStore } from 'react';

// 媒体文件（音频/视频/图片）存在浏览器的 IndexedDB 里，世界 JSON 只存元数据。
// 主持人窗口和玩家窗口同源，所以玩家窗口可以直接读到同一份文件。

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

export const putBlob = (id: string, blob: Blob) => tx('readwrite', (s) => s.put(blob, id));
export const getBlob = (id: string) => tx<Blob | undefined>('readonly', (s) => s.get(id));
export const delBlob = (id: string) => tx('readwrite', (s) => s.delete(id));

/** 一批写入放在同一个事务里：要么全部生效，要么（任何一步出错、空间不够）一个都不生效。blob = null 表示删除。 */
export async function putBlobs(ops: { id: string; blob: Blob | null }[]): Promise<void> {
  if (!ops.length) return;
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const s = t.objectStore(STORE);
    for (const o of ops) { if (o.blob) s.put(o.blob, o.id); else s.delete(o.id); }
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
  const hit = urlCache.get(id);
  if (hit) return hit;
  const b = await getBlob(id);
  if (!b) return null;
  const u = URL.createObjectURL(b);
  urlCache.set(id, u);
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
  }, [id, blob, v]);
  return url;
}
