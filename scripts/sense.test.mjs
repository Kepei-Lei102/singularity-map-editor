import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-sense-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/rules/sense'; export * from './src/core/defaults';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const api = createRequire(import.meta.url)(bundle);
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

const zhi = (attrs) => attrs;
const pc = (attrs, name = '阿甲') => ({ id: 'a', name, color: '#fff', tags: [], attributes: attrs });

/** 造一个场景：桌上有个抽屉，挂着一条观察线索。 */
function scene() {
  const w = api.emptyWorld();
  const m = api.newMap('书房', '现实', 1, 12, 12, 'floor', false);
  m.objects = [];
  m.fog = m.fog.map(() => 1);
  const attrs = { 力量: 50, 敏捷: 50, 意志: 50, 观察: 60, 智慧: 50, 魅力: 50 };
  const person = pc(attrs);
  // 抽屉在 5,5，玩家站在 5,6
  m.objects.push({
    id: 'drawer', kind: 'object', name: '抽屉', x: 5, y: 5, w: 1, h: 1, states: [''], state: 0, notes: '', media: [], hidden: false,
    secrets: [
      { id: 's1', label: '夹层', check: '观察', kind: 'roll', range: 2, tiers: { crit: '夹层里还有一层，藏着一封信', success: '抽屉有夹层', fail: '', fumble: '' } },
    ],
  });
  return { map: m, person };
}

test('区值按 ÷5 向下取整', () => {
  assert.equal(api.senseZone(60), 12);
  assert.equal(api.senseZone(59), 11);
  assert.equal(api.senseZone(undefined), 0);
});

test('观察掷一次观察，投 20 是大成功，投 1 是大失败', () => {
  const p = pc({ 观察: 60 });
  const hit = api.rollSense('observe', p, () => 20);
  assert.equal(hit.success, true);
  assert.equal(hit.tier, 'crit');
  assert.equal(hit.rolls.length, 1);
  assert.equal(hit.rolls[0].attr, '观察');

  const miss = api.rollSense('observe', p, () => 1);
  assert.equal(miss.success, false);
  assert.equal(miss.tier, 'fumble');
});

test('观察：骰点加区值要严格过 DC 20', () => {
  const p = pc({ 观察: 60 }); // 区值 12 → 骰点 9 就到 21
  assert.equal(api.rollSense('observe', p, () => 9).success, true);
  assert.equal(api.rollSense('observe', p, () => 8).success, false, '12+8=20 只是平 DC');
  const low = pc({ 观察: 30 }); // 区值 6 → 骰点要 > 14
  assert.equal(api.rollSense('observe', low, () => 15).success, true);
  assert.equal(api.rollSense('observe', low, () => 14).success, false);
});

test('搜索掷两次：敏捷一次、观察一次，两个都过才算成功', () => {
  const p = pc({ 敏捷: 30, 观察: 30 }); // 两个区值都是 6 → 骰点要 > 14
  const calls = [];
  const both = api.rollSense('search', p, () => { calls.push(1); return 15; });
  assert.equal(calls.length, 2, '要掷两次');
  assert.equal(both.success, true);
  assert.deepEqual(both.rolls.map((r) => r.attr), ['敏捷', '观察']);

  // 一个过一个不过 → 整体失败。这正是「都要过」的意思。
  let n = 0;
  const half = api.rollSense('search', p, () => (n++ === 0 ? 15 : 3));
  assert.equal(half.rolls[0].success, true);
  assert.equal(half.rolls[1].success, false);
  assert.equal(half.success, false, '只要有一项没过就不算成功');
});

test('嗅闻和倾听都只掷观察', () => {
  for (const kind of ['smell', 'listen']) {
    const r = api.rollSense(kind, pc({ 观察: 50 }), () => 40);
    assert.equal(r.rolls.length, 1);
    assert.equal(r.rolls[0].attr, '观察');
  }
});

test('感知失败时规则版不给任何建议', () => {
  const { map, person } = scene();
  const roll = api.rollSense('observe', person, () => 1);
  const hints = api.ruleSenseAdvisor.suggest({ pc: person, pcName: '阿甲', map, at: { x: 5, y: 6 }, roll });
  assert.deepEqual(hints, []);
});

test('感知成功时，规则版把对得上的线索摆出来', () => {
  const { map, person } = scene();
  const roll = api.rollSense('observe', person, () => 50);
  const hints = api.ruleSenseAdvisor.suggest({ pc: person, pcName: '阿甲', map, at: { x: 5, y: 6 }, roll });
  assert.equal(hints.length, 1);
  assert.equal(hints[0].objectName, '抽屉');
  assert.equal(hints[0].secretId, 's1');
  assert.equal(hints[0].from, 'rule');
});

test('指定目标就只看那个物件，不会把周围一股脑倒出来', () => {
  const { map, person } = scene();
  map.objects.push({
    id: 'vase', kind: 'object', name: '花瓶', x: 6, y: 5, w: 1, h: 1, states: [''], state: 0, notes: '', media: [], hidden: false,
    secrets: [{ id: 's2', label: '反光', check: '观察', kind: 'roll', range: 3, tiers: { crit: 'x', success: '花瓶上有反光', fail: '', fumble: '' } }],
  });
  const roll = api.rollSense('observe', person, () => 50);
  const nearby = api.ruleSenseAdvisor.suggest({ pc: person, pcName: '阿甲', map, at: { x: 5, y: 6 }, roll });
  assert.ok(nearby.length >= 2, '不指定目标时，周围够得着的都在候选里');
  assert.ok(nearby.some((h) => h.objectName === '花瓶') && nearby.some((h) => h.objectName === '抽屉'));

  const only = api.ruleSenseAdvisor.suggest({ pc: person, pcName: '阿甲', map, at: { x: 5, y: 6 }, targetObjectId: 'drawer', roll });
  assert.equal(only.length, 1);
  assert.equal(only[0].objectName, '抽屉');
});

test('检定名对不上的线索不会被摆出来', () => {
  const { map, person } = scene();
  map.objects[0].secrets.push({ id: 's3', label: '声音', check: '倾听', kind: 'roll', range: 3, tiers: { crit: '', success: '里面有滴答声', fail: '', fumble: '' } });
  const roll = api.rollSense('observe', person, () => 50);
  const hints = api.ruleSenseAdvisor.suggest({ pc: person, pcName: '阿甲', map, at: { x: 5, y: 6 }, roll });
  assert.ok(!hints.some((h) => h.secretId === 's3'), '观察不该给出倾听的线索');

  const listen = api.rollSense('listen', person, () => 50);
  const heard = api.ruleSenseAdvisor.suggest({ pc: person, pcName: '阿甲', map, at: { x: 5, y: 6 }, roll: listen });
  assert.ok(heard.some((h) => h.secretId === 's3'), '倾听才给');
});

test('超出范围的线索不给', () => {
  const { map, person } = scene();
  const roll = api.rollSense('observe', person, () => 50);
  // 站到很远的地方
  const far = api.ruleSenseAdvisor.suggest({ pc: person, pcName: '阿甲', map, at: { x: 0, y: 0 }, roll });
  assert.equal(far.length, 0, '够不着就不给');
});

test('没有候选时也留个记号，见证者知道该自己写', () => {
  const { map, person } = scene();
  map.objects[0].secrets = [];
  const roll = api.rollSense('observe', person, () => 50);
  const hints = api.senseHints({ pc: person, pcName: '阿甲', map, at: { x: 5, y: 6 }, roll });
  assert.equal(hints.length, 1);
  assert.equal(hints[0].from, 'none');
});

test('换掉建议实现，调用方一行都不用改', () => {
  const { map, person } = scene();
  const roll = api.rollSense('observe', person, () => 50);
  const ctx = { pc: person, pcName: '阿甲', map, at: { x: 5, y: 6 }, roll };

  assert.equal(api.currentSenseAdvisor().name, 'rule');
  const before = api.senseHints(ctx);

  // 换成「模型」版：同样的入参，返回自己的内容
  api.setSenseAdvisor({
    name: 'model',
    suggest: (c) => [{ text: `模型说：${c.pcName} 注意到抽屉有点不对劲`, from: 'model' }],
  });
  const after = api.senseHints(ctx);
  assert.equal(api.currentSenseAdvisor().name, 'model');
  assert.equal(after[0].from, 'model');
  assert.match(after[0].text, /模型说/);
  assert.notDeepEqual(after, before);

  // 换成「因果图」版也一样
  api.setSenseAdvisor({ name: 'causal', suggest: () => [{ text: '因果图上这条线索连着三个人', from: 'causal' }] });
  assert.equal(api.senseHints(ctx)[0].from, 'causal');

  // 换回规则版
  api.setSenseAdvisor(api.ruleSenseAdvisor);
  assert.equal(api.senseHints(ctx)[0].from, 'rule');
});

test('判定结果能说成人话', () => {
  const p = pc({ 敏捷: 30, 观察: 30 });
  let n = 0;
  const r = api.rollSense('search', p, () => (n++ === 0 ? 15 : 3));
  const line = api.describeSense(r, '阿甲');
  assert.match(line, /阿甲/);
  assert.match(line, /搜索/);
  assert.match(line, /D20=/);
  assert.match(line, /失败/);
});
