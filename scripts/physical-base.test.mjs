// 物理互动基座：统一发起条件（当前角色/状态/行动点/距离/视线/启用）与确认时复核。
import assert from 'node:assert/strict';
import { test, after, afterEach } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-physical-base-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: {
    contents: `export * from './src/rules/physicalAction';
export * from './src/rules/objectInteraction';
export * from './src/runtime/objectInteraction';
export * from './src/rules/actionLibrary';
export * from './src/rules/interaction';
export * from './src/core/defaults';
export * from './src/core/schema.js';
export * from './src/core/grid';
export * from './src/core/store';`,
    resolveDir: root,
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.location = { search: '', origin: 'http://localhost' };
globalThis.window = { setTimeout: () => 0, open: () => ({ closed: false, postMessage() {} }) };
globalThis.BroadcastChannel = class { postMessage() {} };
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
const api = createRequire(import.meta.url)(bundle);
after(() => rm(temp, { recursive: true, force: true }));
afterEach(() => api.setUI({ trial: null }));

const ATTRS = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
const ACTOR = () => ({ id: 'a', name: '甲', color: '#fff', tags: [], attributes: ATTRS });
const TOKEN = (over = {}) => ({ id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 3, y: 3, ...over });
const TRIAL = (m, over = {}) => ({
  mapId: m.id,
  players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }],
  current: 0,
  combat: false,
  moved: {},
  turn: 1,
  msg: '',
  ...over,
});

function fixture() {
  const w = api.emptyWorld();
  const m = api.newMap('物理基座', '现实', 1, 12, 10, 'floor', false);
  m.objects = [{
    ...api.newObject('object', 2, 3, 1, 1), id: 'clay', name: '橡皮泥', states: ['完好', '裂'],
    state: 0, stateRev: 0, interaction: {
      overrides: [{ actionId: '5', outcomes: { crit: 1, success: 1, fail: 0, fumble: 0 } }],
    },
  }];
  m.tokens = [TOKEN()];
  w.maps = [m];
  w.party = [ACTOR()];
  api.replaceWorld(w);
  return { w, m };
}

const gate = (w, m, trial, over = {}) => api.physicalActionError({
  world: w, map: m, object: m.objects[0], actor: w.party[0], trial, ...over,
});
const setToken = (m, over) => api.update((d) => Object.assign(d.maps[0].tokens[0], over));
const setObject = (m, over) => api.update((d) => Object.assign(d.maps[0].objects[0], over));
const successResult = () => api.resolve({
  check: api.actionCheckSpec(api.actionById('5')).spec,
  actor: ATTRS,
  d20s: [[15], [10]],
});

test('不在试玩里且不传动作 id：只查物件启用，不查距离/视线/行动点', () => {
  const { w, m } = fixture();
  assert.equal(gate(w, m, null), null);
  api.update((d) => { d.maps[0].objects[0].enabled = false; });
  assert.match(gate(w, api.getWorld().maps[0], null), /禁用/);
});

test('试玩：只认当前行动角色，棋子必须在地图上', () => {
  const { w, m } = fixture();
  const trial = TRIAL(m, {
    players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }, { tokenId: 'tb', pcId: 'b', name: '乙' }],
    current: 1,
  });
  assert.match(gate(w, m, trial), /现在轮到 乙/);
  const missing = TRIAL(m, { players: [{ tokenId: 'nope', pcId: 'a', name: '甲' }] });
  assert.match(gate(w, m, missing), /找不到 甲 的棋子/);
});

test('发起者状态：尸体/昏厥/挡行动状态/回合结束/行动点都会拦', () => {
  const { w, m } = fixture();
  const trial = TRIAL(m);
  for (const [over, re] of [
    [{ corpse: true }, /已经死了/],
    [{ down: true }, /昏厥/],
    [{ status: { label: '眩晕', skipTurns: 1, blocksAction: true } }, /眩晕中/],
  ]) {
    api.replaceWorld({ ...api.getWorld(), maps: [{ ...m, tokens: [TOKEN(over)] }] });
    const now = api.getWorld().maps[0];
    assert.match(gate(api.getWorld(), now, TRIAL(now)), re, JSON.stringify(over));
  }
  api.replaceWorld({ ...api.getWorld(), maps: [{ ...m, tokens: [TOKEN()] }] });
  const now = api.getWorld().maps[0];
  const combat = TRIAL(now, { combat: true, ended: { ta: true } });
  assert.match(gate(api.getWorld(), now, combat), /回合已经结束/);
  const used = TRIAL(now, { combat: true, acted: { ta: true } });
  assert.match(gate(api.getWorld(), now, used), /行动点已经用掉/);
});

test('流血/中毒不挡行动；非战斗不扣行动点', () => {
  const { w, m } = fixture();
  setToken(m, { status: { label: '流血', damageDie: 6, roundsLeft: 1 } });
  assert.equal(gate(w, api.getWorld().maps[0], TRIAL(api.getWorld().maps[0])), null);
  setToken(api.getWorld().maps[0], { status: undefined });
  assert.equal(gate(w, api.getWorld().maps[0], TRIAL(api.getWorld().maps[0], {
    combat: false, acted: { ta: true }, ended: { ta: true },
  })), null);
});

test('距离：默认贴身 1 格；放远要带范围', () => {
  const { w, m } = fixture();
  setToken(m, { x: 4, y: 3 });
  const now = api.getWorld().maps[0];
  assert.match(gate(w, now, TRIAL(now)), /要贴身/);
  assert.equal(gate(w, now, TRIAL(now), { range: 2 }), null);
});

test('视线被墙挡住；隐藏物件也看不见', () => {
  const { w, m } = fixture();
  setToken(m, { x: 4, y: 3 });
  api.update((d) => {
    const dm = d.maps[0];
    dm.cells[3 * dm.width + 3] = 'wall'; // 挡在甲和橡皮泥中间
    dm.fineCells = api.buildFineCells(dm.width, dm.height, dm.cells);
  });
  let now = api.getWorld().maps[0];
  assert.match(gate(w, now, TRIAL(now), { range: 2 }), /看不见/);
  api.update((d) => {
    const dm = d.maps[0];
    dm.cells[3 * dm.width + 3] = 'floor';
    dm.fineCells = api.buildFineCells(dm.width, dm.height, dm.cells);
    dm.objects[0].hidden = true;
  });
  now = api.getWorld().maps[0];
  assert.match(gate(w, now, TRIAL(now)), /看不见/);
});

test('高物件不自己挡自己；墙后高物件仍看不见', () => {
  const { w, m } = fixture();
  api.update((d) => { d.maps[0].objects[0].height = 2.4; });
  let now = api.getWorld().maps[0];
  assert.equal(gate(w, now, TRIAL(now)), null, '2.4m 高书架贴身应能互动');
  api.update((d) => {
    const dm = d.maps[0];
    dm.tokens[0].x = 4;
    dm.cells[3 * dm.width + 3] = 'wall';
    dm.fineCells = api.buildFineCells(dm.width, dm.height, dm.cells);
  });
  now = api.getWorld().maps[0];
  assert.match(gate(w, now, TRIAL(now), { range: 2 }), /看不见/, '高书架在墙后面仍应看不见');
});

test('1/3 格吸附家具：距离按真实占位矩形算', () => {
  const { w, m } = fixture();
  api.update((d) => {
    const dm = d.maps[0];
    dm.objects[0].anchor = { x: 2, y: 0 };
    dm.tokens[0].x = 4;
  });
  const now = api.getWorld().maps[0];
  assert.ok(api.physicalActionDistance(now, now.objects[0], now.tokens[0]) < 1);
  assert.equal(gate(w, now, TRIAL(now)), null);
});

test('动作覆盖：range 放宽到 2 格，超出报具体格数', () => {
  const { w, m } = fixture();
  api.update((d) => {
    const dm = d.maps[0];
    dm.objects[0].interaction.overrides[0].range = 2;
    dm.tokens[0].x = 4;
  });
  let ww = api.getWorld();
  let now = ww.maps[0];
  assert.match(gate(ww, now, TRIAL(now)), /要贴身/, '不带动作 id 时仍按默认 1 格');
  assert.equal(gate(ww, now, TRIAL(now), { actionId: '5' }), null);
  api.update((d) => { d.maps[0].tokens[0].x = 6; });
  ww = api.getWorld(); now = ww.maps[0];
  assert.match(gate(ww, now, TRIAL(now), { actionId: '5' }), /目标不在 2 格内/);
});

test('动作前置条件：目标标签、发动者标签、目标状态', () => {
  const { w, m } = fixture();
  api.update((d) => {
    const o = d.maps[0].objects[0];
    o.interaction.tags = ['易燃物'];
    o.interaction.overrides[0].preconditions = [
      { kind: 'targetHasProp', prop: '易燃物' },
      { kind: 'actorHas', tag: '打火机' },
      { kind: 'targetStateIn', states: [1] },
    ];
  });
  let ww = api.getWorld(); let now = ww.maps[0];
  assert.match(gate(ww, now, TRIAL(now), { actionId: '5' }), /打火机/);
  assert.match(gate(ww, now, TRIAL(now), { actionId: '5' }), /目标状态不是：裂/);
  api.update((d) => {
    d.party[0].tags = ['打火机'];
    d.maps[0].objects[0].state = 1;
  });
  ww = api.getWorld(); now = ww.maps[0];
  assert.equal(gate(ww, now, TRIAL(now), { actionId: '5' }), null);
  api.update((d) => { d.maps[0].objects[0].interaction.tags = []; });
  ww = api.getWorld(); now = ww.maps[0];
  assert.match(gate(ww, now, TRIAL(now), { actionId: '5' }), /易燃物/);
});

test('withinRange 条件：范围放 2 格，但条件只允许 1 格', () => {
  const { w, m } = fixture();
  api.update((d) => {
    const dm = d.maps[0];
    dm.objects[0].interaction.overrides[0].range = 2;
    dm.objects[0].interaction.overrides[0].preconditions = [{ kind: 'withinRange', cells: 1 }];
    dm.tokens[0].x = 4;
  });
  const ww = api.getWorld(); const now = ww.maps[0];
  assert.match(gate(ww, now, TRIAL(now), { actionId: '5' }), /1 格内/);
});

test('锁具类型自动作为目标属性', () => {
  const { w, m } = fixture();
  api.update((d) => {
    const o = d.maps[0].objects[0];
    o.lock = { kind: 'physical', locked: true, keyable: true };
    o.interaction.overrides[0].preconditions = [{ kind: 'targetHasProp', prop: '物理锁具' }];
  });
  const ww = api.getWorld(); const now = ww.maps[0];
  assert.equal(gate(ww, now, TRIAL(now), { actionId: '5' }), null);
});

test('备团（无试玩）也查目标/发起者条件，不查距离/视线', () => {
  const { w, m } = fixture();
  api.update((d) => {
    const o = d.maps[0].objects[0];
    o.interaction.tags = ['易燃物'];
    o.interaction.overrides[0].preconditions = [
      { kind: 'targetHasProp', prop: '易燃物' },
      { kind: 'withinRange', cells: 1 },
    ];
  });
  const ww = api.getWorld(); const now = ww.maps[0];
  assert.equal(gate(ww, now, null, { actionId: '5' }), null, '备团不查距离');
  api.update((d) => { d.maps[0].objects[0].interaction.tags = []; });
  const ww2 = api.getWorld();
  assert.match(gate(ww2, ww2.maps[0], null, { actionId: '5' }), /易燃物/);
});

test('确认落账复核动作前置条件：缺目标标签不落账', () => {
  const { w, m } = fixture();
  api.update((d) => {
    d.maps[0].objects[0].interaction.overrides[0].preconditions = [{ kind: 'targetHasProp', prop: '易燃物' }];
  });
  const err = api.commitObjectInteraction({
    mapId: m.id, objectId: 'clay', actorId: 'a', actionId: '5', actionName: '教授',
    result: successResult(), merge: 'any', scale: 'd20',
  });
  assert.match(err, /易燃物/);
  assert.equal(api.getWorld().maps[0].objects[0].state, 0);
  assert.equal((api.getWorld().events ?? []).length, 0);
});

test('确认落账：战斗里成功一次把行动点用掉，非战斗不扣', () => {
  const { w, m } = fixture();
  const trial = TRIAL(m, { combat: true });
  api.setUI({ trial });
  const err = api.commitObjectInteraction({
    mapId: m.id, objectId: 'clay', actorId: 'a', actionId: '5', actionName: '教授',
    result: successResult(), merge: 'any', scale: 'd20',
  });
  assert.equal(err, null);
  assert.equal(api.getWorld().maps[0].objects[0].state, 1);
  assert.equal(api.getUI().trial.acted.ta, true);

  api.replaceWorld(w);
  const nonCombat = TRIAL(api.getWorld().maps[0], { combat: false });
  api.setUI({ trial: nonCombat });
  const err2 = api.commitObjectInteraction({
    mapId: m.id, objectId: 'clay', actorId: 'a', actionId: '5', actionName: '教授',
    result: successResult(), merge: 'any', scale: 'd20',
  });
  assert.equal(err2, null);
  assert.equal(api.getUI().trial.acted, undefined);
});

test('判定成功但状态没变：空 delta 仍落一条事件并占行动点', () => {
  const { w, m } = fixture();
  api.update((d) => { d.maps[0].objects[0].interaction.overrides[0].outcomes.success = 0; });
  const trial = TRIAL(api.getWorld().maps[0], { combat: true });
  api.setUI({ trial });
  const err = api.commitObjectInteraction({
    mapId: m.id, objectId: 'clay', actorId: 'a', actionId: '5', actionName: '教授',
    result: successResult(), merge: 'any', scale: 'd20',
  });
  assert.equal(err, null);
  const now = api.getWorld();
  assert.equal(now.maps[0].objects[0].state, 0);
  assert.equal(now.maps[0].objects[0].stateRev ?? 0, 0);
  assert.deepEqual(now.events.at(-1).deltas, []);
  assert.equal(api.getUI().trial.acted.ta, true);
});

test('确认时复核：预览后人物走远/行动点被吃/物件禁用都拒绝，世界不动', () => {
  const { w, m } = fixture();
  const trial = TRIAL(m, { combat: true });
  api.setUI({ trial });
  const baseline = api.getWorld();
  const beforeEvents = (baseline.events ?? []).length;

  // 人物走远
  api.update((d) => { d.maps[0].tokens[0].x = 7; });
  let err = api.commitObjectInteraction({
    mapId: m.id, objectId: 'clay', actorId: 'a', actionId: '5', actionName: '教授',
    result: successResult(), merge: 'any', scale: 'd20',
  });
  assert.match(err, /要贴身/);
  assert.equal(api.getWorld().maps[0].objects[0].state, 0);
  assert.equal((api.getWorld().events ?? []).length, beforeEvents);

  // 行动点被别的动作吃掉
  api.replaceWorld(baseline);
  api.setUI({ trial: { ...trial, acted: { ta: true } } });
  err = api.commitObjectInteraction({
    mapId: m.id, objectId: 'clay', actorId: 'a', actionId: '5', actionName: '教授',
    result: successResult(), merge: 'any', scale: 'd20',
  });
  assert.match(err, /行动点/);
  assert.equal(api.getWorld().maps[0].objects[0].state, 0);

  // 物件被禁用
  api.replaceWorld(baseline);
  api.setUI({ trial });
  api.update((d) => { d.maps[0].objects[0].enabled = false; });
  err = api.commitObjectInteraction({
    mapId: m.id, objectId: 'clay', actorId: 'a', actionId: '5', actionName: '教授',
    result: successResult(), merge: 'any', scale: 'd20',
  });
  assert.match(err, /禁用/);
  assert.equal(api.getWorld().maps[0].objects[0].state, 0);
});
