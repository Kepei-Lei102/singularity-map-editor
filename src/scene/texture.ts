import { getBlob, storageKey } from '../runtime/media';

// 贴图按媒体 ID 懒加载。世界 JSON 里只有 mediaId，真正的图片在浏览器 IndexedDB；
// 同一个媒体 ID 换了内容时存储名会变，所以缓存键带上 storageKey，不会拿旧图。
const images = new Map<string, HTMLImageElement>();
const pending = new Set<string>();
const failed = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;

const keyOf = (mediaId: string) => `${mediaId}@${storageKey(mediaId)}`;

function notify() { revision++; for (const fn of listeners) fn(); }

async function load(key: string, mediaId: string) {
  try {
    const blob = await getBlob(mediaId);
    if (!blob) { failed.add(key); pending.delete(key); return; }
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      images.set(key, img);
      pending.delete(key);
      notify();
    };
    img.onerror = () => {
      failed.add(key);
      pending.delete(key);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  } catch {
    failed.add(key);
    pending.delete(key);
  }
}

/** 这个媒体是否已经加载好；没加载就顺手发起一次。 */
export function textureImage(mediaId: string): HTMLImageElement | null {
  if (!mediaId || typeof indexedDB === 'undefined' || typeof Image === 'undefined') return null;
  const key = keyOf(mediaId);
  const hit = images.get(key);
  if (hit) return hit;
  if (!pending.has(key) && !failed.has(key)) {
    pending.add(key);
    void load(key, mediaId);
  }
  return null;
}

/** 图片加载完会通知一次；画布用它触发重画。 */
export function subscribeTexture(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const textureRevision = () => revision;
