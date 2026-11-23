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
try { await build({
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
  api.setUI({ trial: null });
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

const ATTRS = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
function fixture() {
  const w = api.emptyWorld();
  const m = api.newMap('ui', '现实', 1, 10, 10, 'floor', false);
  m.objects = [{
    ...api.newObject('object', 2, 3, 1, 1), id: 'clay', name: '橡皮泥', states: ['完好', '裂'],
    state: 0, stateRev: 0, interaction: {
      overrides: [{ actionId: '4', outcomes: { crit: 1, success: 1, fail: 0, fumble: 0 } }],
    },
  }, {
    ...api.newObject('object', 4, 4, 1, 1), id: 'other', name: '另一件', states: ['完好', '坏'],
    state: 0, stateRev: 0, interaction: {
      overrides: [{ actionId: '4', outcomes: { success: 1, fail: 1 } }],
    },
  }];
  w.maps = [m];
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: ATTRS }];
  api.replaceWorld(w);
  return { w, m };
}

function trialFixture(over = {}) {
  const w = api.emptyWorld();
  const m = api.newMap('ui-trial', '现实', 1, 10, 10, 'floor', false);
  m.objects = [{
    ...api.newObject('object', 2, 3, 1, 1), id: 'clay', name: '橡皮泥', states: ['完好', '裂'],
    state: 0, stateRev: 0, interaction: {
      overrides: [{ actionId: '4', outcomes: { crit: 1, success: 1, fail: 0, fumble: 0 } }],
    },
  }];
  m.tokens = [{ id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 3, y: 3 }];
  w.maps = [m];
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: ATTRS },
             { id: 'b', name: '乙', color: '#fff', tags: [], attributes: ATTRS }];
  api.replaceWorld(w);
  api.setUI({ trial: {
    mapId: m.id,
    players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }, { tokenId: 'tb', pcId: 'b', name: '乙' }],
    current: 0, combat: false, moved: {}, turn: 1, msg: '',
    ...over,
  } });
  return { w, m };
}

function mount(world, objectId = 'clay', mapId = world.maps[0].id, edit = false) {
  const o = world.maps[0].objects.find((x) => x.id === objectId);
  assert.ok(o, `找不到物件：${objectId}`);
  const container = document.createElement('div');
  document.body.append(container);
  const root = api.createRoot(container);
  mounted.push({ root, container });
  api.act(() => root.render(api.React.createElement(api.ObjectInteractionPanel, {
    world, mapId, o, edit, defaultActorId: 'a',
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
const setField = (placeholder, value) => {
  const input = document.querySelector(`input[placeholder="${placeholder}"]`);
  assert.ok(input, `找不到输入框：${placeholder}`);
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

test('面板：换动作后旧预览失效', () => {
  const { w } = fixture();
  mount(w);
  setRoll('15');
  click('看结果');
  assert.ok([...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
  const actionSelect = [...document.querySelectorAll('select')].find((sel) => [...sel.options].some((o) => o.value === '4'));
  assert.ok(actionSelect, '找不到动作选择器');
  api.act(() => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set;
    setter.call(actionSelect, '9');
    actionSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  assert.ok(![...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
});

test('面板：换物件后旧预览失效', () => {
  const { w } = fixture();
  const root = mount(w);
  setRoll('15');
  click('看结果');
  assert.ok([...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
  const o = w.maps[0].objects.find((x) => x.id === 'other');
  api.act(() => root.render(api.React.createElement(api.ObjectInteractionPanel, {
    world: w, mapId: w.maps[0].id, o, edit: false, defaultActorId: 'a',
  })));
  assert.ok(![...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
});

test('面板：切地图后旧预览失效', () => {
  const { w } = fixture();
  const root = mount(w);
  setRoll('15');
  click('看结果');
  assert.ok([...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
  const o = w.maps[0].objects[0];
  api.act(() => root.render(api.React.createElement(api.ObjectInteractionPanel, {
    world: w, mapId: 'another-map', o, edit: false, defaultActorId: 'a',
  })));
  assert.ok(![...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
  assert.match(document.body.textContent, /输入或物件已经变了，请重新看结果/);
});

test('面板：改状态名后旧预览失效', () => {
  const { w } = fixture();
  const root = mount(w);
  setRoll('15');
  click('看结果');
  assert.ok([...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
  const next = JSON.parse(JSON.stringify(api.getWorld()));
  next.maps[0].objects[0].states = ['完好', '碎裂'];
  api.act(() => {
    const o = next.maps[0].objects[0];
    root.render(api.React.createElement(api.ObjectInteractionPanel, {
      world: next, mapId: next.maps[0].id, o, edit: false, defaultActorId: 'a',
    }));
  });
  assert.ok(![...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
  assert.match(document.body.textContent, /输入或物件已经变了，请重新看结果/);
});

test('基座：试玩里选错行动角色，面板直接拦并禁用看结果', () => {
  const { w } = trialFixture({ current: 1 });
  mount(w, 'clay', w.maps[0].id);
  assert.match(document.body.textContent, /现在轮到 乙，不能由 甲 发起/);
  const preview = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '看结果');
  assert.ok(preview, '找不到看结果按钮');
  assert.equal(preview.disabled, true, '条件不满足时看结果还能点');
});

test('基座：人物离物件太远，面板显示原因并禁用看结果', () => {
  const { w, m } = trialFixture();
  api.update((d) => { d.maps[0].tokens[0].x = 6; });
  mount(api.getWorld(), 'clay', m.id);
  assert.match(document.body.textContent, /要贴身才能操作/);
  const preview = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '看结果');
  assert.equal(preview.disabled, true);
});

test('基座：战斗里确认落账后行动点被用掉', () => {
  const { w, m } = trialFixture({ combat: true });
  mount(w, 'clay', m.id);
  setRoll('15');
  click('看结果');
  click('确认，落账');
  assert.equal(api.getUI().trial.acted.ta, true);
  assert.equal(api.getWorld().maps[0].objects[0].state, 1);
});

test('基座：非战斗落账不扣行动点', () => {
  const { w, m } = trialFixture({ combat: false });
  mount(w, 'clay', m.id);
  setRoll('15');
  click('看结果');
  click('确认，落账');
  assert.equal(api.getUI().trial.acted, undefined);
  assert.equal(api.getWorld().maps[0].objects[0].state, 1);
});

test('基座：预览后人物走开，旧预览清掉且确认按钮消失', () => {
  const { w, m } = trialFixture();
  const root = mount(w, 'clay', m.id);
  setRoll('15');
  click('看结果');
  assert.ok([...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
  api.update((d) => { d.maps[0].tokens[0].x = 7; });
  const next = api.getWorld();
  const o = next.maps[0].objects[0];
  api.act(() => root.render(api.React.createElement(api.ObjectInteractionPanel, {
    world: next, mapId: next.maps[0].id, o, edit: false, defaultActorId: 'a',
  })));
  assert.match(document.body.textContent, /要贴身才能操作/);
  assert.ok(![...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
});

test('基座：预览后行动点被吃掉，旧预览清掉且确认按钮消失', () => {
  const { w, m } = trialFixture({ combat: true });
  const root = mount(w, 'clay', m.id);
  setRoll('15');
  click('看结果');
  assert.ok([...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
  const trial = api.getUI().trial;
  api.setUI({ trial: { ...trial, acted: { ta: true } } });
  const next = api.getWorld();
  const o = next.maps[0].objects[0];
  api.act(() => root.render(api.React.createElement(api.ObjectInteractionPanel, {
    world: next, mapId: next.maps[0].id, o, edit: false, defaultActorId: 'a',
  })));
  assert.match(document.body.textContent, /行动点已经用掉/);
  assert.ok(![...document.querySelectorAll('button')].some((x) => x.textContent?.trim() === '确认，落账'));
});

test('编辑器：距离、目标标签、发动者标签、目标状态写回映射', () => {
  const { w } = fixture();
  mount(w, 'clay', w.maps[0].id, true);
  setField('留空＝1', '2');
  let ov = api.getWorld().maps[0].objects[0].interaction.overrides[0];
  assert.equal(ov.range, 2);

  setField('物件标签，如 易燃物', '易燃物, 金属');
  ov = api.getWorld().maps[0].objects[0].interaction.overrides[0];
  assert.deepEqual(ov.preconditions, [
    { kind: 'targetHasProp', prop: '易燃物' },
    { kind: 'targetHasProp', prop: '金属' },
  ]);

  setField('角色途径标签，如 打火机', '打火机');
  ov = api.getWorld().maps[0].objects[0].interaction.overrides[0];
  assert.ok(ov.preconditions.some((p) => p.kind === 'actorHas' && p.tag === '打火机'));

  const checks = [...document.querySelectorAll('input[type="checkbox"]')];
  assert.equal(checks.length, 2, '两个物件状态应各有一个勾选框');
  api.act(() => checks[1].click());
  ov = api.getWorld().maps[0].objects[0].interaction.overrides[0];
  const state = ov.preconditions.find((p) => p.kind === 'targetStateIn');
  assert.deepEqual(state.states, [1]);
});

test('条件：目标标签不满足，面板拦并禁用看结果', () => {
  const { w, m } = trialFixture();
  api.update((d) => {
    const o = d.maps[0].objects[0];
    o.interaction.tags = [];
    o.interaction.overrides[0].preconditions = [{ kind: 'targetHasProp', prop: '易燃物' }];
  });
  mount(api.getWorld(), 'clay', m.id);
  assert.match(document.body.textContent, /目标不是「易燃物」/);
  const preview = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '看结果');
  assert.equal(preview.disabled, true);
});

} else {
  test('面板 UI 测试需要按文件隔离进程', { skip: '默认 npm test 按文件分进程；--test-isolation=none 下 jsdom 全局会和别的测试打架' }, () => {});
}
after(async () => { await rm(temp, { recursive: true, force: true }); });
