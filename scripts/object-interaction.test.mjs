// 物件互动：公开动作 → 判定口径、物件四档映射、确认后落状态与账本。
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-interaction-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: {
    contents: `export * from './src/rules/actionLibrary';
export * from './src/rules/objectInteraction';
export * from './src/rules/interactionPreview';
export * from './src/runtime/objectInteraction';
export * from './src/runtime/sync';
export * from './src/runtime/actions';
export * from './src/rules/interaction';
export * from './src/rules/events';
export * from './src/core/defaults';
export * from './src/core/schema.js';
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

const ATTRS = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };

function fixture() {
  const w = api.emptyWorld();
  const m = api.newMap('互动', '现实', 1, 10, 10, 'floor', false);
  m.objects = [{
    ...api.newObject('object', 2, 3, 1, 1), id: 'clay', name: '橡皮泥', states: ['完好', '裂', '碎'],
    state: 0, stateRev: 0, interaction: {
      material: '橡皮泥', tags: ['可变形'],
      overrides: [{ actionId: '5', outcomes: { crit: 2, success: 1, fail: 0, fumble: 0 } }],
    },
  }];
  w.maps = [m];
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: ATTRS }];
  api.replaceWorld(w);
  return { w, m };
}

test('动作库适配：单属性/或/与/叠加能接，多来源/拼点/裁决明确拒绝', () => {
  assert.deepEqual(api.actionCheckSpec(api.actionById('4')).spec, { attributes: ['敏捷'], mode: 'single' });
  assert.equal(api.actionCheckSpec(api.actionById('5')).spec.mode, 'or');
  assert.equal(api.actionCheckSpec(api.actionById('28')).spec.mode, 'and');
  assert.equal(api.actionCheckSpec(api.actionById('133')).spec.mode, 'and');
  assert.match(api.actionCheckSpec(api.actionById('1')).error, /多来源/);
  assert.match(api.actionCheckSpec(api.actionById('74')).error, /拼点/);
  assert.match(api.actionCheckSpec(api.actionById('30')).error, /见证者/);
  assert.equal(api.PANEL_ACTIONS.length, 148);
});

test('物件四档：查到哪个 state；没配就是 null', () => {
  const { m } = fixture();
  const o = m.objects[0];
  assert.equal(api.objectOutcome(o, '5', 'crit'), 2);
  assert.equal(api.objectOutcome(o, '5', 'success'), 1);
  assert.equal(api.objectOutcome(o, '5', 'fail'), 0);
  assert.equal(api.objectOutcome(o, '999', 'success'), null);
  assert.deepEqual(api.objectOutcomePlan(o, '5', 'success'), { from: 0, to: 1 });
});

test('确认后改 state、stateRev+1，并落一条动作库事件', () => {
  const { m } = fixture();
  const spec = api.actionCheckSpec(api.actionById('5')).spec;
  const result = api.resolve({ check: spec, actor: ATTRS, d20s: [[15], [10]] });
  assert.equal(result.tier, 'success');
  const err = api.commitObjectInteraction({
    mapId: m.id, objectId: 'clay', actorId: 'a', actionId: '5', actionName: '教授',
    result, merge: 'any', scale: 'd20',
  });
  assert.equal(err, null);
  const w = api.getWorld();
  const o = w.maps[0].objects[0];
  assert.equal(o.state, 1);
  assert.equal(o.stateRev, 1);
  const ev = w.events.at(-1);
  assert.equal(ev.action.id, '5');
  assert.equal(ev.action.source, '动作库');
  assert.deepEqual(ev.target, { kind: 'object', id: 'clay', name: '橡皮泥' });
  assert.deepEqual(ev.deltas, [{ kind: 'object', id: 'clay', name: '橡皮泥', path: '状态', from: '完好', to: '裂' }]);
  assert.equal(ev.check.success, true);
  assert.equal(ev.check.attrs[0].success, true);
  assert.match(w.log.at(-1).text, /【教授】成功/);
  assert.doesNotThrow(() => api.checkWorld(w));
});

test('这一档没映射 / 选项非法：确认被拒，世界不动', () => {
  const { m } = fixture();
  const spec = api.actionCheckSpec(api.actionById('5')).spec;
  const result = api.resolve({ check: spec, actor: ATTRS, d20s: [[3], [3]] }); // fail，但 fail 映射到 0（原状态）
  const err = api.commitObjectInteraction({
    mapId: m.id, objectId: 'clay', actorId: 'a', actionId: '7', actionName: '不存在',
    result, merge: 'any', scale: 'd20',
  });
  assert.match(err, /没有预置效果/);
  assert.equal(api.getWorld().maps[0].objects[0].state, 0);
  const w = api.getWorld();
  const bad = JSON.parse(JSON.stringify(w));
  bad.maps[0].objects[0].interaction.overrides[0].outcomes.crit = 99;
  assert.throws(() => api.checkWorld(bad), /outcomes.crit/);
  const unknown = JSON.parse(JSON.stringify(w));
  unknown.maps[0].objects[0].interaction.overrides[0].outcomes.great = 1;
  assert.throws(() => api.checkWorld(unknown), /outcomes\.great/);
  const dup = JSON.parse(JSON.stringify(w));
  dup.maps[0].objects[0].interaction.overrides.push({ actionId: '5', outcomes: {} });
  assert.throws(() => api.checkWorld(dup), /actionId/);
});

test('玩家载荷：物件互动档案不进玩家地图', () => {
  const { m } = fixture();
  const w = api.getWorld();
  const map = { ...m, fog: m.fog.map(() => 1) };
  const pw = api.playerWorld({ ...w, maps: [map], playerMapId: m.id, visionMode: 'shared' }, m.id);
  const objs = pw.maps[0]?.objects ?? [];
  assert.ok(objs.some((o) => o.id === 'clay'), '物件可见时应该在玩家载荷里');
  assert.ok(objs.every((o) => !('interaction' in o)), '互动档案不能带进玩家载荷');
});

test('改状态列表时，互动四档跟着序号迁移；被删的档清空，不硬塞到第一个状态', () => {
  const { m } = fixture();
  api.setObjectStates(m.id, 'clay', ['完好', '碎']);
  const o = api.getWorld().maps[0].objects[0];
  assert.deepEqual(o.states, ['完好', '碎']);
  assert.deepEqual(o.interaction.overrides[0].outcomes, { crit: 1, fail: 0, fumble: 0 });
  assert.equal(o.interaction.overrides[0].outcomes.success, undefined);
});

test('成功但目标状态没变：不造 delta，也不白涨 stateRev', () => {
  const { m } = fixture();
  api.update((d) => { d.maps[0].objects[0].interaction.overrides[0].outcomes.success = 0; });
  const spec = api.actionCheckSpec(api.actionById('5')).spec;
  const result = api.resolve({ check: spec, actor: ATTRS, d20s: [[15], [10]] });
  const err = api.commitObjectInteraction({ mapId: m.id, objectId: 'clay', actorId: 'a', actionId: '5', actionName: '教授', result, merge: 'any', scale: 'd20' });
  assert.equal(err, null);
  const after = api.getWorld().maps[0].objects[0];
  assert.equal(after.state, 0);
  assert.equal(after.stateRev ?? 0, 0);
  assert.deepEqual(api.getWorld().events.at(-1).deltas, []);
});

test('优势/劣势：账本写真实骰势和两颗骰，日志不再只剩一颗', () => {
  const { m } = fixture();
  const spec = api.actionCheckSpec(api.actionById('5')).spec;
  const result = api.resolve({ check: spec, actor: ATTRS, d20s: [[15, 10], [10, 1]], advantage: 'advantage' });
  assert.equal(result.rolls[0].roll, 15);
  const err = api.commitObjectInteraction({
    mapId: m.id, objectId: 'clay', actorId: 'a', actionId: '5', actionName: '教授',
    result, merge: 'any', scale: 'd20', advantage: 'advantage',
  });
  assert.equal(err, null);
  const ev = api.getWorld().events.at(-1);
  assert.equal(ev.check.attrs[0].dice, 'advantage');
  assert.deepEqual(ev.check.attrs[0].rolls, [15, 10]);
  assert.equal(ev.check.attrs[0].roll, 15);
  assert.match(api.getWorld().log.at(-1).text, /15\/10→取15\+区值/);
  assert.doesNotThrow(() => api.checkWorld(api.getWorld()));
});

test('预览快照：任一输入变了都会失效', () => {
  const base = {
    mapId: 'm1', objectId: 'clay', actorId: 'a', actionId: '5', advantage: 'advantage',
    rollKey: '15,10|10,1', state: 0, actorKey: '{"力量":30}', interactionKey: '{"overrides":[]}', statesKey: '["完好","裂"]',
  };
  assert.equal(api.interactionPreviewValid(base, { ...base }), true);
  for (const key of Object.keys(base)) {
    assert.equal(api.interactionPreviewValid(base, { ...base, [key]: 'changed' }), false, `${key} 变了仍被判有效`);
  }
});

test('劣势：账本写 disadvantage、采用骰与两颗骰一致', () => {
  const { m } = fixture();
  const spec = api.actionCheckSpec(api.actionById('5')).spec;
  const result = api.resolve({ check: spec, actor: ATTRS, d20s: [[15, 10], [19, 1]], advantage: 'disadvantage' });
  assert.equal(result.rolls[0].roll, 10);
  const err = api.commitObjectInteraction({
    mapId: m.id, objectId: 'clay', actorId: 'a', actionId: '5', actionName: '教授',
    result, merge: 'any', scale: 'd20', advantage: 'disadvantage',
  });
  assert.equal(err, null);
  const ev = api.getWorld().events.at(-1);
  assert.equal(ev.check.attrs[0].dice, 'disadvantage');
  assert.deepEqual(ev.check.attrs[0].rolls, [15, 10]);
  assert.equal(ev.check.attrs[0].roll, 10);
  assert.match(api.getWorld().log.at(-1).text, /15\/10→取10/);
  assert.doesNotThrow(() => api.checkWorld(api.getWorld()));
});

test('旧事件没有 rolls 仍兼容；普通日志不写 undefined', () => {
  const w = api.getWorld();
  const old = JSON.parse(JSON.stringify(w));
  old.events = [api.newEvent(old, Date.now(),
    { kind: 'pc', id: 'a', name: '甲' },
    { id: '5', name: '教授', source: '动作库' },
    {
      target: { kind: 'object', id: 'clay', name: '橡皮泥' },
      check: {
        kind: 'check', scale: 'd20', merge: 'any', dc: 20,
        attrs: [{ attr: '魅力', dice: 'advantage', roll: 15, value: 10, total: 25, success: true, tier: null }],
        success: true, tier: null, rolledBy: 'host',
      },
      deltas: [],
    })];
  assert.doesNotThrow(() => api.checkWorld(old));
  const text = api.resultText(old.events[0]);
  assert.match(text, /魅力 15\+区值10✓/);
  assert.doesNotMatch(text, /undefined/);
});

test('rolls 与骰势不一致会被 checkWorld 拒绝，repair 会丢掉坏事件', () => {
  const w = api.getWorld();
  const base = JSON.parse(JSON.stringify(w));
  base.events = [api.newEvent(base, Date.now(),
    { kind: 'pc', id: 'a', name: '甲' },
    { id: '5', name: '教授', source: '动作库' },
    {
      target: { kind: 'object', id: 'clay', name: '橡皮泥' },
      check: {
        kind: 'check', scale: 'd20', merge: 'any', dc: 20,
        attrs: [{ attr: '魅力', dice: 'advantage', roll: 15, value: 10, total: 25, rolls: [15, 10], success: true, tier: null }],
        success: true, tier: null, rolledBy: 'host',
      },
      deltas: [],
    })];
  const kept = JSON.parse(JSON.stringify(base));
  api.repairWorld(kept);
  assert.equal(kept.events.length, 1);

  const wrongCount = JSON.parse(JSON.stringify(base));
  wrongCount.events[0].check.attrs[0].dice = 'single';
  assert.throws(() => api.checkWorld(wrongCount), /rolls/);
  const fixedCount = JSON.parse(JSON.stringify(wrongCount));
  api.repairWorld(fixedCount);
  assert.equal(fixedCount.events.length, 0);

  const wrongRoll = JSON.parse(JSON.stringify(base));
  wrongRoll.events[0].check.attrs[0].roll = 12;
  assert.throws(() => api.checkWorld(wrongRoll), /roll/);

  const broken = JSON.parse(JSON.stringify(base));
  broken.events[0].check.attrs[0].rolls = [15, null];
  assert.throws(() => api.checkWorld(broken), /rolls/);
  const fixed = api.repairWorld(broken);
  assert.ok(fixed.length > 0);
  assert.equal(broken.events.length, 0);
});

test('旧档互动档案：删未知档位/越界状态/重复动作；空档案不留下', () => {
  const w1 = JSON.parse(JSON.stringify(api.getWorld()));
  const o = w1.maps[0].objects[0];
  o.interaction.overrides = [
    { actionId: '5', outcomes: { crit: 2, success: 99, great: 1 } },
    { actionId: '5', outcomes: { success: 1 } },
    { actionId: '', outcomes: { success: 1 } },
    { actionId: '4', outcomes: null },
  ];
  const fixed = api.repairWorld(w1);
  assert.ok(fixed.some((x) => x.includes('档位')));
  assert.equal(o.interaction.overrides.length, 1);
  assert.deepEqual(o.interaction.overrides[0].outcomes, { crit: 2, success: 1 });
  assert.doesNotThrow(() => api.checkWorld(w1));

  const w2 = JSON.parse(JSON.stringify(api.getWorld()));
  w2.maps[0].objects[0].interaction.overrides = [
    { actionId: '5', outcomes: {} },
    { actionId: '5', outcomes: { success: 1 } },
  ];
  api.repairWorld(w2);
  assert.equal(w2.maps[0].objects[0].interaction.overrides.length, 1);
  assert.deepEqual(w2.maps[0].objects[0].interaction.overrides[0].outcomes, { success: 1 });

  const w3 = JSON.parse(JSON.stringify(api.getWorld()));
  w3.maps[0].objects[0].interaction.overrides = [{ actionId: ' 5 ', outcomes: { success: 1 } }];
  api.repairWorld(w3);
  assert.equal(w3.maps[0].objects[0].interaction.overrides[0].actionId, '5');
  assert.doesNotThrow(() => api.checkWorld(w3));

  const w4 = JSON.parse(JSON.stringify(api.getWorld()));
  w4.maps[0].objects[0].interaction.overrides = [];
  api.repairWorld(w4);
  assert.equal(w4.maps[0].objects[0].interaction, undefined);
});

test('快照工厂：把角色属性、物件映射、状态名都序列化进快照', () => {
  const snap = api.makeInteractionPreviewSnapshot({
    mapId: 'm1', objectId: 'clay', actorId: 'a', actionId: '5', advantage: 'normal',
    rollKey: '15', state: 0, actorAttributes: { 力量: 30 }, interaction: null, states: ['完好', '裂'],
  });
  assert.equal(snap.mapId, 'm1');
  assert.equal(snap.actorKey, '{"力量":30}');
  assert.equal(snap.interactionKey, 'null');
  assert.equal(snap.statesKey, '["完好","裂"]');
  assert.equal(snap.rollKey, '15');
  assert.equal(api.makeInteractionPreviewSnapshot({ ...snap, actorAttributes: undefined }).actorKey, 'null');
  assert.equal(api.makeInteractionPreviewSnapshot({ ...snap, interaction: undefined }).interactionKey, 'null');
});
