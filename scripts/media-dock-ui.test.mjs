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
    contents: `export { useThrottledAssetTransferStats, DockTransferLine, MediaDock } from './src/components/MediaPanel';
export { setUI, replaceWorld } from './src/core/store';
export { emptyWorld } from './src/core/defaults';
export * as React from 'react';
export { createRoot } from 'react-dom/client';
export { act } from 'react';`,
    resolveDir: root,
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
  jsx: 'automatic', logLevel: 'silent',
  define: { 'import.meta.env': JSON.stringify({ VITE_APP_ROLE: 'host' }) },
});
const priorGlobals = {
  windowDescriptor: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  documentDescriptor: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  locationDescriptor: Object.getOwnPropertyDescriptor(globalThis, 'location'),
  navigatorDescriptor: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  HTMLElement: globalThis.HTMLElement,
  Event: globalThis.Event,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  localStorageDescriptor: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  sessionStorageDescriptor: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
  broadcastChannelDescriptor: Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel'),
};
const restoreGlobal = (name, desc) => { if (desc) Object.defineProperty(globalThis, name, desc); else delete globalThis[name]; };
after(() => {
  dom.window.close();
  restoreGlobal('window', priorGlobals.windowDescriptor);
  restoreGlobal('document', priorGlobals.documentDescriptor);
  restoreGlobal('location', priorGlobals.locationDescriptor);
  if (priorGlobals.navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', priorGlobals.navigatorDescriptor);
  else delete globalThis.navigator;
  globalThis.HTMLElement = priorGlobals.HTMLElement;
  restoreGlobal('localStorage', priorGlobals.localStorageDescriptor);
  restoreGlobal('sessionStorage', priorGlobals.sessionStorageDescriptor);
  restoreGlobal('BroadcastChannel', priorGlobals.broadcastChannelDescriptor);
  globalThis.Event = priorGlobals.Event;
  if (priorGlobals.IS_REACT_ACT_ENVIRONMENT === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = priorGlobals.IS_REACT_ACT_ENVIRONMENT;
  return rm(temp, { recursive: true, force: true });
});

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
  try { api.setUI({ nowPlaying: null }); api.replaceWorld(api.emptyWorld()); } catch {}
});

function mount(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = api.createRoot(container);
  api.act(() => root.render(element));
  mounted.push({ root, container });
  return container;
}

function installFakeWindowTimers() {
  const realSet = window.setTimeout;
  const realClear = window.clearTimeout;
  const timers = [];
  let cleared = 0;
  window.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  window.clearTimeout = (id) => { cleared++; if (timers[id - 1]) timers[id - 1] = undefined; };
  return {
    timers,
    clearCount: () => cleared,
    restore() { window.setTimeout = realSet; window.clearTimeout = realClear; },
  };
}

test('150ms 内连续通知只合并成一次 setState，之后取最新快照', () => {
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
  const fake = installFakeWindowTimers();
  try {
    api.act(() => { notify(); notify(); notify(); });
    assert.equal(container.textContent, '0', '150ms 之前不能重渲染');
    assert.equal(renders, rendersAfterMount, '连续通知只能排一个 timer');
    assert.equal(fake.timers.length, 1, '3 次通知只排 1 个 timer');

    api.act(() => { fake.timers.shift()(); });
    assert.equal(container.textContent, '10');
    assert.ok(renders >= rendersAfterMount + 1, '到点后要更新');

    current = { ...current, bytes: 20 };
    api.act(() => notify());
    assert.equal(container.textContent, '10');
    assert.equal(fake.timers.length, 1);
    api.act(() => { fake.timers.shift()(); });
    assert.equal(container.textContent, '20');
  } finally {
    fake.restore();
  }
});

test('卸载时清掉未触发的 timer，通知不再 setState', () => {
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
  const fake = installFakeWindowTimers();
  try {
    api.act(() => { for (const fn of [...listeners]) fn(); });
    assert.equal(fake.timers.length, 1);
    const rendersBefore = renders;
    api.act(() => { for (const { root } of mounted) root.unmount(); });
    assert.equal(listeners.size, 0, '卸载要退订');
    assert.ok(fake.clearCount() > 0, '卸载要真的清掉 pending timer');
    assert.equal(fake.timers[0], undefined);
    assert.equal(renders, rendersBefore, '卸载后 timer 不能再触发渲染');
  } finally {
    fake.restore();
  }
});

test('Dock 传输行实际渲染名字、字节、排队和近2秒速率', () => {
  const transfer = {
    players: 2, requests: 1, bytes: 1_048_576, totalBytes: 2_097_152,
    queued: 2, inFlight: 1, rate: 524_288,
    bindings: [
      { binding: 'b1', pcId: 'pc1', name: '甲', bytes: 524_288, totalBytes: 1_048_576, queued: 1, inFlight: 1, rate: 262_144 },
      { binding: 'b2', pcId: 'pc2', name: '乙', bytes: 524_288, totalBytes: 1_048_576, queued: 1, inFlight: 0, rate: 262_144 },
    ],
  };
  const container = mount(api.React.createElement(api.DockTransferLine, { transfer }));
  const text = container.textContent ?? '';
  assert.match(text, /正在传素材给 甲、乙（2 名，共享带宽）/);
  assert.match(text, /1\.0 MB \/ 2\.0 MB/);
  assert.match(text, /1 个传输中/);
  assert.match(text, /2 个排队/);
  assert.match(text, /近 2 秒 512 KB\/s/);

  const many = mount(api.React.createElement(api.DockTransferLine, {
    transfer: { ...transfer, players: 4, bindings: [1, 2, 3, 4].map((i) => ({ ...transfer.bindings[0], binding: `b${i}`, name: `P${i}` })) },
  }));
  assert.match(many.textContent ?? '', /正在传素材给 4 名玩家（共享带宽）/);
  assert.doesNotMatch(many.textContent ?? '', /甲、乙/);
});

test('MediaDock 渲染头部和停止按钮，nowPlaying 清空/缺媒体时消失', () => {
  const w = api.emptyWorld();
  w.media = [{ id: 'm1', name: '图', mime: 'image/png', size: 1, key: 'k1' }];
  api.replaceWorld(w);
  api.setUI({ nowPlaying: { mediaId: 'm1', label: '图', broadcast: true } });
  const container = mount(api.React.createElement(api.MediaDock));
  assert.match(container.textContent ?? '', /玩家也在看\/听/);
  assert.match(container.textContent ?? '', /图/);
  assert.equal(container.querySelector('button')?.textContent, '停止（玩家也停）');

  api.act(() => api.setUI({ nowPlaying: { mediaId: 'm1', label: '图', broadcast: false } }));
  assert.match(container.textContent ?? '', /仅主持人/);
  assert.equal(container.querySelector('button')?.textContent, '关闭');

  api.act(() => api.setUI({ nowPlaying: null }));
  assert.equal(container.textContent, '');

  api.act(() => api.setUI({ nowPlaying: { mediaId: 'missing', label: '缺', broadcast: true } }));
  assert.equal(container.textContent, '');

  api.act(() => api.setUI({ nowPlaying: { mediaId: 'm1', label: '图', broadcast: true } }));
  const stop = container.querySelector('button');
  assert.ok(stop);
  api.act(() => stop.click());
  assert.equal(container.textContent, '');
});

test('内联 subscribe/snapshot 重渲染不重复订阅，也不丢 pending timer', () => {
  let current = emptyStats();
  let subscribeCalls = 0;
  const listeners = new Set();
  function Probe() {
    const stats = api.useThrottledAssetTransferStats((fn) => {
      subscribeCalls++;
      listeners.add(fn);
      return () => listeners.delete(fn);
    }, () => ({ ...current }), 150);
    return api.React.createElement('div', null, String(stats.bytes));
  }
  const container = mount(api.React.createElement(Probe));
  assert.equal(subscribeCalls, 1);
  const fake = installFakeWindowTimers();
  try {
    current = { ...current, bytes: 10 };
    api.act(() => { for (const fn of [...listeners]) fn(); });
    assert.equal(fake.timers.length, 1);
    api.act(() => { mounted[0].root.render(api.React.createElement(Probe)); });
    assert.equal(subscribeCalls, 1, '内联函数不能导致重复订阅');
    assert.equal(typeof fake.timers[0], 'function', '重渲染不能丢掉 pending timer');
    api.act(() => { fake.timers.shift()(); });
    assert.equal(container.textContent, '10');
  } finally {
    fake.restore();
  }
});

test('Dock 传输行单玩家、无名玩家和没有 totalBytes 的分支', () => {
  const one = { ...emptyStats(), players: 1, requests: 1, bindings: [{ binding: 'b1', pcId: 'pc', name: '甲', bytes: 0, totalBytes: 0, queued: 0, inFlight: 0, rate: 0 }] };
  const named = mount(api.React.createElement(api.DockTransferLine, { transfer: one }));
  assert.equal(named.textContent, '正在传素材给 甲（1 名）');
  assert.doesNotMatch(named.textContent ?? '', /已发|传输中|排队|近 2 秒/);

  const unnamed = mount(api.React.createElement(api.DockTransferLine, { transfer: { ...one, bindings: [{ ...one.bindings[0], name: '' }] } }));
  assert.equal(unnamed.textContent, '正在传素材给 pc（1 名）');

  const sent = mount(api.React.createElement(api.DockTransferLine, { transfer: { ...one, bytes: 2048, totalBytes: 0 } }));
  assert.equal(sent.textContent, '正在传素材给 甲（1 名） · 已发 2 KB');

  const zeroSent = mount(api.React.createElement(api.DockTransferLine, { transfer: { ...one, bytes: 0, totalBytes: 2_097_152 } }));
  assert.equal(zeroSent.textContent, '正在传素材给 甲（1 名） · 0 B / 2.0 MB');
});

test('Dock 传输行 players>1 但名字为空时用通用文案', () => {
  const two = { ...emptyStats(), players: 2, requests: 2, bindings: [
    { binding: 'b1', pcId: '', name: '', bytes: 0, totalBytes: 0, queued: 0, inFlight: 0, rate: 0 },
    { binding: 'b2', pcId: '', name: '', bytes: 0, totalBytes: 0, queued: 0, inFlight: 0, rate: 0 },
  ] };
  const line = mount(api.React.createElement(api.DockTransferLine, { transfer: two }));
  assert.equal(line.textContent, '正在传素材给 2 名玩家（共享带宽）');
});
