// NPC 上限输入框：逐键只改本地文本，失焦/Enter 才提交；卸载时提交未失焦的文本。
// 仓库没有组件测试环境，这里用 jsdom + react-dom 真挂 TokenInspector。
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
const temp = await mkdtemp(join(tmpdir(), 'ts-npc-hp-ui-'));
const bundle = join(temp, 'panel.cjs');
try { await build({
  stdin: {
    contents: `export { TokenInspector } from './src/components/Inspector';
export * as React from 'react';
export { createRoot } from 'react-dom/client';
export { act } from 'react';
export * from './src/core/defaults';
export * from './src/core/schema.js';
export * from './src/core/store';`,
    resolveDir: root,
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
  jsx: 'automatic', logLevel: 'silent',
}); } catch (e) { await rm(temp, { recursive: true, force: true }); throw e; }

const isolated = process.env.NODE_TEST_CONTEXT !== undefined;
if (isolated) {
const saved = {
  window: globalThis.window,
  document: globalThis.document,
  location: globalThis.location,
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  HTMLElement: globalThis.HTMLElement,
  Event: globalThis.Event,
  localStorage: globalThis.localStorage,
  sessionStorage: globalThis.sessionStorage,
  BroadcastChannel: globalThis.BroadcastChannel,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  crypto: Object.getOwnPropertyDescriptor(globalThis, 'crypto'),
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
};
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
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
globalThis.BroadcastChannel = class { postMessage() {} };
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
after(async () => {
  dom.window.close();
  for (const [key, value] of Object.entries(saved)) {
    if (key === 'navigator' || key === 'crypto') {
      if (value) Object.defineProperty(globalThis, key, value);
      else delete globalThis[key];
    } else if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

function fixture() {
  const w = api.emptyWorld();
  const m = api.newMap('ui', '现实', 1, 10, 10, 'floor', false);
  m.tokens = [{ id: 'npc', pcId: null, name: '路人', color: '#888', x: 2, y: 2, hp: 10, hpMax: 10 }];
  w.maps = [m];
  w.party = [];
  api.replaceWorld(w);
  return { w, m };
}

function mount(mapId) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = api.createRoot(container);
  mounted.push({ root, container });
  function Host() {
    const world = api.useWorld();
    const t = world.maps.find((m) => m.id === mapId)?.tokens.find((x) => x.id === 'npc');
    return api.React.createElement(api.TokenInspector, { world, mapId, t });
  }
  api.act(() => root.render(api.React.createElement(Host)));
  return { root, input: document.querySelector('input[aria-label="NPC HP 上限"]') };
}

function mountSelection(mapId) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = api.createRoot(container);
  mounted.push({ root, container });
  function SelectionHost() {
    const world = api.useWorld();
    const ui = api.useUI();
    const sel = ui.selection;
    if (sel?.type !== 'token' || sel.mapId !== mapId) return null;
    const t = world.maps.find((m) => m.id === mapId)?.tokens.find((x) => x.id === sel.id);
    return t ? api.React.createElement(api.TokenInspector, { world, mapId, t }) : null;
  }
  api.act(() => root.render(api.React.createElement(SelectionHost)));
  return { root, input: document.querySelector('input[aria-label="NPC HP 上限"]') };
}

const token = () => api.getWorld().maps[0].tokens.find((x) => x.id === 'npc');
const setValue = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  api.act(() => { setter.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
};
const blur = (input) => api.act(() => { input.focus(); input.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true })); });
const key = (input, name) => api.act(() => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true })));

test('上限输入逐键不夹 HP：2→20 失焦后是 10/20', () => {
  const { m } = fixture();
  const { input } = mount(m.id);
  assert.ok(input, '找不到 NPC HP 上限输入框');
  assert.equal(input.value, '10');

  setValue(input, '2');
  assert.equal(token().hp, 10, '敲第一位时不能改 world');
  assert.equal(token().hpMax, 10, '敲第一位时不能改 world');
  setValue(input, '20');
  assert.equal(token().hp, 10, '输入完整数字前不改 world');
  assert.equal(token().hpMax, 10);
  blur(input);
  assert.equal(token().hp, 10, '10/10 改上限 20 不回血');
  assert.equal(token().hpMax, 20);
  assert.equal(input.value, '20');
});

test('上限输入 100 后 Enter：10/100，不把 hp 夹成 1', () => {
  const { m } = fixture();
  const { input } = mount(m.id);
  setValue(input, '100');
  key(input, 'Enter');
  assert.equal(token().hp, 10);
  assert.equal(token().hpMax, 100);
  assert.equal(input.value, '100');
});

test('上限输入 Escape：不改 world，文本回旧值', () => {
  const { m } = fixture();
  const { input } = mount(m.id);
  setValue(input, '30');
  key(input, 'Escape');
  assert.equal(token().hpMax, 10);
  assert.equal(input.value, '10');
});

test('上限清空后失焦：回默认 10', () => {
  const { m } = fixture();
  const { input } = mount(m.id);
  setValue(input, '');
  blur(input);
  assert.equal(token().hpMax, 10);
  assert.equal(token().hp, 10);
  assert.equal(input.value, '10');
});

test('上限输入 0.4 后 Enter：按 helper 走 1，HP 跟着夹到 1', () => {
  const { m } = fixture();
  const { input } = mount(m.id);
  setValue(input, '0.4');
  key(input, 'Enter');
  assert.equal(token().hpMax, 1);
  assert.equal(token().hp, 1);
  assert.equal(input.value, '1');
});

test('输入上限后没失焦就卸载：提交文本，不丢 50', () => {
  const { m } = fixture();
  const { root, input } = mount(m.id);
  setValue(input, '50');
  api.act(() => root.unmount());
  assert.equal(token().hpMax, 50);
  assert.equal(token().hp, 10);
  const i = mounted.findIndex((x) => x.root === root);
  if (i >= 0) mounted.splice(i, 1);
});

test('切到另一个棋子：文本不串到新棋子，旧棋子输入照常提交', () => {
  const { m } = fixture();
  api.update((d) => {
    d.maps[0].tokens.push({ id: 'npc2', pcId: null, name: '路人二', color: '#888', x: 3, y: 2, hp: 10, hpMax: 10 });
  });
  api.act(() => api.setUI({ mapId: m.id, selection: { type: 'token', mapId: m.id, id: 'npc' }, mode: 'edit', trial: null }));
  const { root, input } = mountSelection(m.id);
  setValue(input, '50');
  api.act(() => api.setUI({ selection: { type: 'token', mapId: m.id, id: 'npc2' } }));
  const tokens = api.getWorld().maps[0].tokens;
  assert.equal(tokens.find((t) => t.id === 'npc').hpMax, 50, '旧棋子把已输入值提交');
  assert.equal(tokens.find((t) => t.id === 'npc2').hpMax, 10, '新棋子不能被串成 50');
  assert.equal(document.querySelector('input[aria-label="NPC HP 上限"]').value, '10');
  api.act(() => root.unmount());
  const i = mounted.findIndex((x) => x.root === root);
  if (i >= 0) mounted.splice(i, 1);
});

test('Escape 同一拍清掉选择/卸载检查器：不提交输入', () => {
  const { m } = fixture();
  api.act(() => api.setUI({ mapId: m.id, selection: { type: 'token', mapId: m.id, id: 'npc' }, mode: 'edit', trial: null }));
  const { root, input } = mountSelection(m.id);
  assert.ok(input, '选择面板里找不到 NPC HP 上限输入框');
  setValue(input, '50');
  api.act(() => {
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    api.setUI({ selection: null }); // App 的全局 Escape 会清选择，检查器随之卸载
  });
  assert.equal(token().hpMax, 10, 'Escape 取消不能被卸载 cleanup 提交');
  assert.equal(token().hp, 10);
  api.act(() => root.unmount());
  const i = mounted.findIndex((x) => x.root === root);
  if (i >= 0) mounted.splice(i, 1);
});
}
