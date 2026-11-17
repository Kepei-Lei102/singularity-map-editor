import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-texture-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/scene/texture'; export * from './src/runtime/media'; export * from './src/core/defaults'; export * from './src/core/store';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.location = { search: '', origin: 'http://localhost' };
globalThis.window = { setTimeout: () => 0, open: () => ({ closed: false, postMessage() {} }) };
globalThis.BroadcastChannel = class { postMessage() {} };
globalThis.indexedDB = {};
let failNextImage = false;
let holdImage = false;
let heldImage = null;
globalThis.Image = class FakeImage {
  onload = null;
  onerror = null;
  naturalWidth = 1;
  naturalHeight = 1;
  _src = '';
  set src(value) {
    this._src = value;
    if (holdImage) { heldImage = this; holdImage = false; return; }
    queueMicrotask(() => {
      if (failNextImage) { failNextImage = false; this.onerror?.(); }
      else this.onload?.();
    });
  }
};
let urlSeq = 0;
const createdUrls = [];
const revokedUrls = [];
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
URL.createObjectURL = () => { const url = `blob:texture-${++urlSeq}`; createdUrls.push(url); return url; };
URL.revokeObjectURL = (url) => { revokedUrls.push(url); };
const api = createRequire(import.meta.url)(bundle);
after(() => { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; delete globalThis.indexedDB; delete globalThis.Image; return rm(temp, { recursive: true, force: true }); });

const tick = () => new Promise((resolve) => setImmediate(resolve));
function makeLoader(impl) {
  const loader = async (id) => { loader.calls++; return impl(id, loader.calls); };
  loader.calls = 0;
  return loader;
}
function resetCache() {
  api.clearTextureCache();
  urlSeq = 0;
  createdUrls.length = 0;
  revokedUrls.length = 0;
  failNextImage = false;
  holdImage = false;
  heldImage = null;
}

test('玩家窗口收到的世界媒体表会换成内容存储名；清空后回落到 id', () => {
  api.applyMediaIndex({ media: [{ id: 'tex', name: '柜纹', mime: 'image/png', size: 1, key: 'v:abc' }] });
  assert.equal(api.storageKey('tex'), 'v:abc');
  api.applyMediaIndex({ media: [{ id: 'old', name: '旧图', mime: 'image/png', size: 1 }] });
  assert.equal(api.storageKey('tex'), 'tex');
  assert.equal(api.storageKey('old'), 'old');
  api.applyMediaIndex(null);
  assert.equal(api.storageKey('old'), 'old');
});

test('同一媒体只加载一次，成功后 revoke 临时地址', async () => {
  resetCache();
  const loader = makeLoader(async () => new Blob(['x']));
  assert.equal(api.textureImage('m', loader), null);
  await tick();
  const img = api.textureImage('m', loader);
  assert.ok(img);
  assert.equal(loader.calls, 1);
  assert.equal(createdUrls.length, 1);
  assert.deepEqual(revokedUrls, createdUrls);
});

test('加载失败不会无限重试；clearTextureCache 后可以重试', async () => {
  resetCache();
  const loader = makeLoader(async () => null);
  assert.equal(api.textureImage('m', loader), null);
  await tick();
  assert.equal(loader.calls, 1);
  assert.equal(api.textureImage('m', loader), null);
  assert.equal(loader.calls, 1);
  api.clearTextureCache();
  assert.equal(api.textureImage('m', loader), null);
  assert.equal(loader.calls, 2);
});

test('清缓存时还在飞的加载回来不落地', async () => {
  resetCache();
  let resolveBlob;
  const loader = makeLoader(() => new Promise((resolve) => { resolveBlob = resolve; }));
  assert.equal(api.textureImage('m', loader), null);
  assert.equal(loader.calls, 1);
  api.clearTextureCache();
  resolveBlob(new Blob(['x']));
  await tick();
  assert.equal(api.textureImage('m', loader), null);
  assert.equal(loader.calls, 2);
});

test('清缓存后旧图错误不污染新的失败缓存', async () => {
  resetCache();
  holdImage = true;
  const loader = makeLoader(async () => new Blob(['x']));
  assert.equal(api.textureImage('m', loader), null);
  await tick();
  assert.ok(heldImage);
  api.clearTextureCache();
  heldImage.onerror?.();
  await tick();
  assert.equal(api.textureImage('m', loader), null);
  assert.equal(loader.calls, 2);
});

test('清缓存后旧图加载完不删掉新加载的 pending', async () => {
  resetCache();
  holdImage = true;
  const loader = makeLoader(async () => new Blob(['x']));
  assert.equal(api.textureImage('m', loader), null);
  await tick();
  const oldImage = heldImage;
  assert.ok(oldImage);
  api.clearTextureCache();
  holdImage = true;
  assert.equal(api.textureImage('m', loader), null);
  await tick();
  assert.equal(loader.calls, 2);
  oldImage.onload?.();
  await tick();
  assert.equal(api.textureImage('m', loader), null);
  assert.equal(loader.calls, 2);
});

test('缓存有上限，最旧的图会被淘汰后重新加载', async () => {
  resetCache();
  const limit = api.TEXTURE_CACHE_LIMIT;
  const loader = makeLoader(async () => new Blob(['x']));
  for (let i = 0; i <= limit; i++) api.textureImage(`m${i}`, loader);
  await tick();
  assert.equal(loader.calls, limit + 1);
  assert.equal(api.textureImage('m0', loader), null);
  assert.equal(loader.calls, limit + 2);
});

test('切工程会清空贴图缓存', async () => {
  resetCache();
  const loader = makeLoader(async () => new Blob(['x']));
  assert.equal(api.textureImage('m', loader), null);
  await tick();
  assert.ok(api.textureImage('m', loader));
  api.replaceWorld(api.emptyWorld());
  assert.equal(api.textureImage('m', loader), null);
  assert.equal(loader.calls, 2);
});

test('媒体变化会清空贴图缓存和失败状态', async () => {
  resetCache();
  const failing = makeLoader(async () => null);
  assert.equal(api.textureImage('m', failing), null);
  await tick();
  assert.equal(failing.calls, 1);
  api.mediaChanged();
  assert.equal(api.textureImage('m', failing), null);
  assert.equal(failing.calls, 2);
});
