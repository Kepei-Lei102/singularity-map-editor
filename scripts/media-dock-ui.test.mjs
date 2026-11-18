// Dock 的 stats 合并：150ms 内多次通知只 setState 一次，卸载时清 timer。
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
const temp = await mkdtemp(join(tmpdir(), 'ts-media-dock-ui-'));
const bundle = join(temp, 'media-dock.cjs');
await build({
  stdin: {
    contents: `export { useThrottledAssetTransferStats } from './src/components/MediaPanel';
export * as React from 'react';
export { createRoot } from 'react-dom/client';
export { act } from 'react';`,
    resolveDir: root,
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
  jsx: 'automatic', logLevel: 'silent',
  define: { 'import.meta.env': JSON.stringify({ VITE_APP_ROLE: 'host' }) },
});
after(() => { dom.window.close(); return rm(temp, { recursive: true, force: true }); });

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

const emptyStats = () => ({ players: 0, requests: 0, bytes: 0, totalBytes: 0, queued: 0, inFlight: 0, rate: 0, bindings: [] });
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

test('150ms 内连续通知只合并成一次 setState，之后取最新快照', async () => {
  let current = emptyStats();
  let renders = 0;
  const listeners = new Set();
  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const snapshot = () => current;
  function Probe() {
    renders++;
    const stats = api.useThrottledAssetTransferStats(subscribe, snapshot, 150);
    return api.React.createElement('div', null, String(stats.bytes));
  }
  const container = mount(api.React.createElement(Probe));
  assert.equal(container.textContent, '0');
  const rendersAfterMount = renders;

  current = { ...current, bytes: 10, players: 1, requests: 1, inFlight: 1 };
  const notify = () => { for (const fn of [...listeners]) fn(); };
  api.act(() => { notify(); notify(); notify(); });
  assert.equal(container.textContent, '0', '150ms 之前不能重渲染');
  assert.equal(renders, rendersAfterMount, '连续通知只能排一个 timer');

  await new Promise((r) => setTimeout(r, 180));
  assert.equal(container.textContent, '10');
  assert.ok(renders >= rendersAfterMount + 1, '到点后要更新');

  current = { ...current, bytes: 20 };
  api.act(() => notify());
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(container.textContent, '20');
});

test('卸载时清掉未触发的 timer，通知不再 setState', async () => {
  let current = emptyStats();
  let renders = 0;
  const listeners = new Set();
  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  function Probe() {
    renders++;
    const stats = api.useThrottledAssetTransferStats(subscribe, () => current, 150);
    return api.React.createElement('div', null, String(stats.bytes));
  }
  const container = mount(api.React.createElement(Probe));
  current = { ...current, bytes: 10 };
  api.act(() => { for (const fn of [...listeners]) fn(); });
  const rendersBefore = renders;
  const realClear = window.clearTimeout;
  let cleared = 0;
  window.clearTimeout = (id) => { cleared++; return realClear(id); };
  try {
    api.act(() => { for (const { root } of mounted) root.unmount(); });
  } finally {
    window.clearTimeout = realClear;
  }
  assert.equal(listeners.size, 0, '卸载要退订');
  assert.ok(cleared > 0, '卸载要真的清掉 pending timer');
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(renders, rendersBefore, '卸载后 timer 不能再触发渲染');
});
