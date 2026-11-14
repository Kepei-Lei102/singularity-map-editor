// 发起互动面板的 UI 接线：预览、取消、失效提示、成功落账提示。
// 仓库没有组件测试环境，这里用 jsdom + react-dom 把面板真挂一次；不测视觉样式。
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
const temp = await mkdtemp(join(tmpdir(), 'ts-interaction-ui-'));
const bundle = join(temp, 'panel.cjs');
await build({
  stdin: {
    contents: `export { ObjectInteractionPanel } from './src/components/ObjectInteraction';
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
});

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
    if (key === 'navigator') {
      if (value) Object.defineProperty(globalThis, 'navigator', value);
      else delete globalThis.navigator;
    } else if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
  await rm(temp, { recursive: true, force: true });
});

const ATTRS = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
function fixture() {
  const w = api.emptyWorld();
  const m = api.newMap('ui', '现实', 1, 10, 10, 'floor', false);
  m.objects = [{
    ...api.newObject('object', 2, 3, 1, 1), id: 'clay', name: '橡皮泥', states: ['完好', '裂'],
    state: 0, stateRev: 0, interaction: {
      overrides: [{ actionId: '4', outcomes: { crit: 1, success: 1, fail: 0, fumble: 0 } }],
    },
  }];
  w.maps = [m];
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: ATTRS }];
  api.replaceWorld(w);
  return { w, m };
}

function mount(world) {
  const o = world.maps[0].objects[0];
  const container = document.createElement('div');
  document.body.append(container);
  const root = api.createRoot(container);
  mounted.push({ root, container });
  api.act(() => root.render(api.React.createElement(api.ObjectInteractionPanel, {
    world, mapId: world.maps[0].id, o, edit: false, defaultActorId: 'a',
  })));
  return root;
}
const click = (label) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === label);
  assert.ok(b, `找不到按钮：${label}`);
  api.act(() => b.click());
};
const setRoll = (value) => {
  const input = document.querySelector('input[placeholder="D20 点数"]');
  assert.ok(input, '找不到骰点输入框');
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  api.act(() => { setter.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
};

test('面板：看结果后取消，预览消失且世界不动', () => {
  const { w } = fixture();
  const root = mount(w);
  setRoll('15');
  click('看结果');
  assert.ok([...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
  click('取消预览');
  assert.ok(![...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
  assert.equal(api.getWorld().maps[0].objects[0].state, 0);
  assert.equal(api.getWorld().maps[0].objects[0].stateRev, 0);
});

test('面板：改骰点后旧预览失效，确认按钮不再出现', () => {
  const { w } = fixture();
  const root = mount(w);
  setRoll('15');
  click('看结果');
  assert.ok([...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
  setRoll('1');
  assert.ok(![...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
  assert.ok(![...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '取消预览'));
});

test('面板：外部改物件状态，旧预览清掉并留失效提示', () => {
  const { w } = fixture();
  const root = mount(w);
  setRoll('15');
  click('看结果');
  const next = JSON.parse(JSON.stringify(api.getWorld()));
  next.maps[0].objects[0].state = 1;
  api.act(() => {
    const o = next.maps[0].objects[0];
    root.render(api.React.createElement(api.ObjectInteractionPanel, {
      world: next, mapId: next.maps[0].id, o, edit: false, defaultActorId: 'a',
    }));
  });
  assert.ok(![...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
  assert.match(document.body.textContent, /输入或物件已经变了，请重新看结果/);
});

test('面板：确认成功且状态真的变了，提示保留已落账', () => {
  const { w } = fixture();
  const root = mount(w);
  setRoll('15');
  click('看结果');
  click('确认，落账');
  assert.match(document.body.textContent, /已落账/);
  const o = api.getWorld().maps[0].objects[0];
  assert.equal(o.state, 1);
  assert.equal(o.stateRev, 1);
  assert.equal(api.getWorld().events.at(-1).deltas.at(-1).kind, 'object');
});

test('面板：失效时替换掉旧的未落账提示', () => {
  const { w } = fixture();
  const nextWorld = JSON.parse(JSON.stringify(w));
  nextWorld.maps[0].objects[0].interaction.overrides[0].outcomes = { fail: 0 };
  api.replaceWorld(nextWorld);
  const root = mount(nextWorld);
  setRoll('15');
  click('看结果');
  assert.match(document.body.textContent, /这一档没配效果/);
  const next = JSON.parse(JSON.stringify(api.getWorld()));
  next.maps[0].objects[0].state = 1;
  api.act(() => {
    const o = next.maps[0].objects[0];
    root.render(api.React.createElement(api.ObjectInteractionPanel, {
      world: next, mapId: next.maps[0].id, o, edit: false, defaultActorId: 'a',
    }));
  });
  assert.match(document.body.textContent, /输入或物件已经变了，请重新看结果/);
  assert.doesNotMatch(document.body.textContent, /这一档没配效果/);
});

test('面板：改互动映射后旧预览失效', () => {
  const { w } = fixture();
  const root = mount(w);
  setRoll('15');
  click('看结果');
  assert.ok([...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
  const next = JSON.parse(JSON.stringify(api.getWorld()));
  next.maps[0].objects[0].interaction.overrides[0].outcomes.success = 0;
  api.act(() => {
    const o = next.maps[0].objects[0];
    root.render(api.React.createElement(api.ObjectInteractionPanel, {
      world: next, mapId: next.maps[0].id, o, edit: false, defaultActorId: 'a',
    }));
  });
  assert.ok(![...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
  assert.match(document.body.textContent, /输入或物件已经变了，请重新看结果/);
});

test('面板：改角色六维后旧预览失效', () => {
  const { w } = fixture();
  const root = mount(w);
  setRoll('15');
  click('看结果');
  assert.ok([...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
  const next = JSON.parse(JSON.stringify(api.getWorld()));
  next.party[0].attributes = { ...ATTRS, 力量: 99 };
  api.act(() => {
    const o = next.maps[0].objects[0];
    root.render(api.React.createElement(api.ObjectInteractionPanel, {
      world: next, mapId: next.maps[0].id, o, edit: false, defaultActorId: 'a',
    }));
  });
  assert.ok(![...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
  assert.match(document.body.textContent, /输入或物件已经变了，请重新看结果/);
});
