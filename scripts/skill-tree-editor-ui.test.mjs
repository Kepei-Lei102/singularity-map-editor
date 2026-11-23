// 技能树编辑器：真实挂载，验证 198 节点、搜索、勾选写回 PC.skills。
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
const temp = await mkdtemp(join(tmpdir(), 'ts-skill-tree-ui-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: {
    contents: `export { SkillTreeEditor } from './src/components/SkillTreeEditor';
export { SkillPanel } from './src/components/SkillPanel';
export * as React from 'react';
export { createRoot } from 'react-dom/client';
export { act } from 'react';
export * from './src/core/defaults';
export * from './src/core/schema.js';
export * from './src/core/store';`,
    resolveDir: root,
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
});
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
  w.party = [{ id: 'pc', name: 'Ian', color: '#fff', tags: [], skills: [], pathway: '控场途径' }];
  api.replaceWorld(w);
  return api.getWorld().party[0];
}

function mount(pc) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = api.createRoot(container);
  api.act(() => { root.render(api.React.createElement(api.SkillTreeEditor, { pc })); });
  mounted.push({ root, container });
  return container;
}

function mountSkillPanel(world) {
  api.replaceWorld(world);
  api.setUI({ mapId: 'x', mode: 'edit', trial: null, cast: null, focus: null });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = api.createRoot(container);
  api.act(() => { root.render(api.React.createElement(api.SkillPanel)); });
  mounted.push({ root, container });
  return container;
}

const setValue = (input, value) => api.act(() => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});

test('树：17 条途径、198 个复选框、当前途径与计数', () => {
  const pc = fixture();
  const container = mount(pc);
  assert.equal(container.querySelectorAll('.skill-tree-pathway').length, 17);
  assert.equal(container.querySelectorAll('input[type="checkbox"]').length, 198);
  assert.match(container.textContent ?? '', /技能树 0\/198/);
  assert.match(container.textContent ?? '', /控场途径/);
  assert.match(container.textContent ?? '', /当前/);
});

test('搜索：只留下命中的节点，清空后回到树', async () => {
  const pc = fixture();
  const container = mount(pc);
  const input = container.querySelector('.skill-tree-search');
  assert.ok(input);
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  api.act(() => {
    setter.call(input, '游戏解题');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  assert.equal(container.querySelectorAll('input[type="checkbox"]').length, 1);
  assert.match(container.textContent ?? '', /游戏解题/);
  api.act(() => {
    setter.call(input, '');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  assert.equal(container.querySelectorAll('.skill-tree-pathway').length, 17);
});

test('勾选写回 PC.skills，取消勾选移除', async () => {
  const pc = fixture();
  const container = mount(pc);
  const label = [...container.querySelectorAll('label.pc-skill')].find((x) => x.textContent?.includes('游戏解题'));
  assert.ok(label);
  const box = label.querySelector('input[type="checkbox"]');
  assert.equal(box.checked, false);
  api.act(() => { box.click(); });
  assert.deepEqual(api.getWorld().party[0].skills, ['001-9-001']);
  // 组件没订阅 world；重新挂载看已勾中状态
  const fresh = mount(api.getWorld().party[0]);
  const freshLabel = [...fresh.querySelectorAll('label.pc-skill')].find((x) => x.textContent?.includes('游戏解题'));
  assert.ok(freshLabel?.querySelector('input[type="checkbox"]')?.checked);
});

test('发动面板：升级视图里锁定技能按钮禁用，已解锁可点', () => {
  const w = api.emptyWorld();
  w.party = [{ id: 'pc', name: 'Ian', color: '#fff', tags: [], skills: ['037-9-101'], pathway: '金手指途径', me: 10, meMax: 10 }];
  const container = mountSkillPanel(w);
  const upgrade = [...container.querySelectorAll('label')].find((x) => x.textContent?.includes('升级视图'))?.querySelector('input[type="checkbox"]');
  assert.ok(upgrade);
  api.act(() => upgrade.click());
  const search = container.querySelector('input[placeholder*="搜索技能"]');
  assert.ok(search);
  setValue(search, '游戏解题');
  const locked = [...container.querySelectorAll('button.skill-item')].find((x) => x.textContent?.includes('游戏解题'));
  assert.ok(locked);
  assert.equal(locked.disabled, true);
  setValue(search, '冥想');
  const open = [...container.querySelectorAll('button.skill-item')].find((x) => x.textContent?.includes('冥想'));
  assert.ok(open);
  assert.equal(open.disabled, false);
});

}
