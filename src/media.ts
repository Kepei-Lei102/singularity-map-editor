import { useEffect, useState } from 'react';

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

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const putBlob = (id: string, blob: Blob) => tx('readwrite', (s) => s.put(blob, id));
export const getBlob = (id: string) => tx<Blob | undefined>('readonly', (s) => s.get(id));
export const delBlob = (id: string) => tx('readwrite', (s) => s.delete(id));

const urlCache = new Map<string, string>();
export async function blobUrl(id: string): Promise<string | null> {
  const hit = urlCache.get(id);
  if (hit) return hit;
  const b = await getBlob(id);
  if (!b) return null;
  const u = URL.createObjectURL(b);
  urlCache.set(id, u);
  return u;
}

/** 有现成的 blob（玩家窗口收到的）就直接用，否则去本地存储里取。 */
export function useBlobUrl(id: string | null | undefined, blob?: Blob) {
  const [url, setUrl] = useState<string | null>(null);
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
  }, [id, blob]);
  return url;
}
