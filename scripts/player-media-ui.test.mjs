// 玩家端媒体浮层的运行时接线：载入中、失败重试、成功后渲染，以及 play→按 key 请求。
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
const temp = await mkdtemp(join(tmpdir(), 'ts-player-media-ui-'));
const bundle = join(temp, 'player-media.cjs');
await build({
  stdin: {
    contents: `export { PlayerMediaOverlay, requestPlayMedia } from './src/components/PlayerView';
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

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.BroadcastChannel = class { postMessage() {} addEventListener() {} removeEventListener() {} close() {} };
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
const api = createRequire(import.meta.url)(bundle);

const mounted = [];
afterEach(() => {
  for (const { root, container } of mounted) {
    try { api.act(() => root.unmount()); } catch {}
    container.remove();
  }
  mounted.length = 0;
});

function mount(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = api.createRoot(container);
  api.act(() => root.render(element));
  mounted.push({ root, container });
  return container;
}

test('媒体没传过来时显示失败和重试按钮，点重试只回调不自己发请求', () => {
  let retried = 0;
  const container = mount(api.React.createElement(api.PlayerMediaOverlay, {
    media: { mediaId: 'v:abc', label: '音频', mime: 'audio/mpeg', failed: true },
    armed: true,
    onRetry: () => { retried++; },
    onEnded: () => {},
  }));
  assert.match(container.textContent ?? '', /媒体没传过来/);
  const button = container.querySelector('button');
  assert.ok(button);
  api.act(() => button.click());
  assert.equal(retried, 1);
});

test('没有 blob 的线上媒体显示载入中，成功后渲染图片', () => {
  let container = mount(api.React.createElement(api.PlayerMediaOverlay, {
    media: { mediaId: 'k-loading', label: '图', mime: 'image/png' },
    armed: true,
    onRetry: () => {},
    onEnded: () => {},
  }));
  assert.match(container.textContent ?? '', /载入中/);
  api.act(() => mounted[0].root.unmount());
  mounted.length = 0;
  container.remove();

  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
  container = mount(api.React.createElement(api.PlayerMediaOverlay, {
    media: { mediaId: 'k-ready', label: '图', mime: 'image/png', blob },
    armed: true,
    onRetry: () => {},
    onEnded: () => {},
  }));
  const img = container.querySelector('img');
  assert.ok(img);
  assert.match(img.getAttribute('src') ?? '', /^blob:/);
});

test('play→按 key 请求只发生在线上、且没有 blob 时', () => {
  const calls = [];
  const receiver = {
    request: async () => {},
    retry: async (keys) => { calls.push(keys); },
    handle: () => {},
    reset: () => {},
  };
  api.requestPlayMedia(receiver, true, 'k1', undefined);
  api.requestPlayMedia(receiver, true, 'k1', new Blob([new Uint8Array([1])]));
  api.requestPlayMedia(receiver, false, 'k1', undefined);
  api.requestPlayMedia(null, true, 'k1', undefined);
  assert.deepEqual(calls, [['k1']]);
});

test('未 armed 时不渲染媒体', () => {
  const container = mount(api.React.createElement(api.PlayerMediaOverlay, {
    media: { mediaId: 'k', label: '图', mime: 'image/png' },
    armed: false,
    onRetry: () => {},
    onEnded: () => {},
  }));
  assert.equal(container.textContent, '');
});
