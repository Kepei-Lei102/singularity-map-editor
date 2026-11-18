// 整 PlayerView 的运行时接线：本地窗口收到 play → 媒体浮层 → stop 收掉；没有 blob 显示载入中。
import assert from 'node:assert/strict';
import { test, after, afterEach } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-player-view-'));
const bundle = join(temp, 'player-view.cjs');
await build({
  stdin: {
    contents: `export { PlayerView } from './src/components/PlayerView';
export * as React from 'react';
export { createRoot } from 'react-dom/client';
export { act } from 'react';`,
    resolveDir: root,
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
  jsx: 'automatic', logLevel: 'silent',
  define: { 'import.meta.env': JSON.stringify({ VITE_APP_ROLE: 'player' }) },
});
after(() => rm(temp, { recursive: true, force: true }));

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/?binding=b1&session=s1' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;
globalThis.MessageEvent = dom.window.MessageEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.BroadcastChannel = class { postMessage() {} addEventListener() {} removeEventListener() {} close() {} };
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
const opener = { closed: false, postMessage() {} };
dom.window.opener = opener;
dom.window.setInterval = () => 0; // 心跳定时器不拖住测试进程
const api = createRequire(import.meta.url)(bundle);

const mounted = [];
afterEach(() => {
  for (const { root, container } of mounted) {
    try { api.act(() => root.unmount()); } catch {}
    container.remove();
  }
  mounted.length = 0;
});

const msg = (type, extra = {}) => ({
  __ts: 'ts-map', seq: `${type}-${Math.random()}`, from: 's1', inst: 'i1', born: 1, type, ...extra,
});
function send(data) {
  const ev = new dom.window.MessageEvent('message', { data, source: opener, origin: 'http://localhost' });
  api.act(() => dom.window.dispatchEvent(ev));
}

async function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = api.createRoot(container);
  api.act(() => { root.render(api.React.createElement(api.PlayerView)); });
  await new Promise((r) => setTimeout(r, 0));
  mounted.push({ root, container });
  return container;
}

test('整 PlayerView：收到带 Blob 的 play 挂媒体，stop 收掉', async () => {
  const container = await mount();
  const arm = container.querySelector('.arm');
  assert.ok(arm);
  api.act(() => arm.click());
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
  send(msg('play', { mediaId: 'm-local', label: '图', mime: 'image/png', blob }));
  await new Promise((r) => setTimeout(r, 0));
  api.act(() => {});
  const img = container.querySelector('.player-media img');
  assert.ok(img);
  assert.match(img.getAttribute('src') ?? '', /^blob:/);
  send(msg('stop'));
  assert.equal(container.querySelector('.player-media'), null);
});

test('整 PlayerView：没有 Blob 的 play 显示载入中', async () => {
  const container = await mount();
  const arm = container.querySelector('.arm');
  api.act(() => arm.click());
  send(msg('play', { mediaId: 'm-key-only', label: '图', mime: 'image/png' }));
  await new Promise((r) => setTimeout(r, 10));
  api.act(() => {});
  assert.match(container.textContent ?? '', /载入中/);
});
