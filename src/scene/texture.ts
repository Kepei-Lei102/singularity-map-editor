import { getBlob, onMediaChanged, storageKey } from '../runtime/media';
import { onProjectReplaced } from '../core/store';

// 贴图按媒体 ID 懒加载。世界 JSON 里只有 mediaId，真正的图片在浏览器 IndexedDB；
// 同一个媒体 ID 换了内容时存储名会变，所以缓存键带上 storageKey，不会拿旧图。
const images = new Map<string, HTMLImageElement>();
const pending = new Set<string>();
const pendingUrls = new Map<string, string>();
const failed = new Set<string>();
const listeners = new Set<() => void>();
// 一张图通常几十个组；留足余量，避免渲染时反复淘汰正在用的图。
export const TEXTURE_CACHE_LIMIT = 256;
let revision = 0;
let generation = 0;

export type TextureLoader = (mediaId: string) => Promise<Blob | null>;
const defaultLoader: TextureLoader = async (mediaId) => (await getBlob(mediaId)) ?? null;

const keyOf = (mediaId: string) => `${mediaId}@${storageKey(mediaId)}`;

function notify() { revision++; for (const fn of listeners) fn(); }

function trimCache() {
  while (images.size > TEXTURE_CACHE_LIMIT) {
    const oldest = images.keys().next().value;
    if (oldest === undefined) return;
    images.delete(oldest);
  }
}

/** 清空贴图画布缓存：切工程、媒体文件变化、手动清理时用；正在飞的加载回来不再落地。 */
export function clearTextureCache() {
  generation++;
  pendingUrls.forEach((url) => URL.revokeObjectURL(url));
  pendingUrls.clear();
  images.clear();
  pending.clear();
  failed.clear();
  notify();
}

function revokePending(key: string, url: string) {
  if (pendingUrls.get(key) !== url) return;
  pendingUrls.delete(key);
  URL.revokeObjectURL(url);
}

async function load(key: string, mediaId: string, loader: TextureLoader, gen: number) {
  try {
    const blob = await loader(mediaId);
    if (gen !== generation) return;
    if (!blob) { failed.add(key); pending.delete(key); return; }
    const url = URL.createObjectURL(blob);
    if (gen !== generation) { URL.revokeObjectURL(url); return; }
    pendingUrls.set(key, url);
    const img = new Image();
    img.onload = () => {
      if (gen !== generation) { revokePending(key, url); return; }
      pendingUrls.delete(key);
      images.delete(key);
      images.set(key, img);
      trimCache();
      pending.delete(key);
      URL.revokeObjectURL(url);
      notify();
    };
    img.onerror = () => {
      if (gen !== generation) { revokePending(key, url); return; }
      pendingUrls.delete(key);
      failed.add(key);
      pending.delete(key);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  } catch {
    if (gen !== generation) return;
    failed.add(key);
    pending.delete(key);
  }
}

/** 这个媒体是否已经加载好；没加载就顺手发起一次。loader 只给测试用，生产走默认 getBlob。 */
export function textureImage(mediaId: string, loader: TextureLoader = defaultLoader): HTMLImageElement | null {
  if (!mediaId || typeof indexedDB === 'undefined' || typeof Image === 'undefined') return null;
  const key = keyOf(mediaId);
  const hit = images.get(key);
  if (hit) {
    images.delete(key);
    images.set(key, hit);
    return hit;
  }
  if (!pending.has(key) && !failed.has(key)) {
    const gen = generation;
    pending.add(key);
    void load(key, mediaId, loader, gen);
  }
  return null;
}

/** 图片加载完会通知一次；画布用它触发重画。 */
export function subscribeTexture(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const textureRevision = () => revision;

// 切工程、媒体文件变化：旧工程/旧文件名的图不能留着被新工程误用。
onProjectReplaced(clearTextureCache);
onMediaChanged(clearTextureCache);
