// 事件账本：攻击落成一条 PhysicalEvent，句子由事件渲染；以及账本进存档校验、回合重置的边界。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-events-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: {
    contents: `export * from './src/rules/events';
export * from './src/rules/combat';
export * from './src/rules/interaction';
export * from './src/core/defaults';
export * from './src/core/schema.js';
export * from './src/runtime/trial';
export * from './src/core/store';
export * from './src/runtime/actions';
export * from './src/scene/architecture';
export * from './src/scene/sight';`,
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
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

const ATTRS = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };

/** 一张 10×10 的战斗图：攻击者 ta（pc a），目标 tb（pc b）。 */
function fight(opts = {}) {
  const w = api.emptyWorld();
  const m = api.newMap('战斗', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [
    { id: 'a', name: '攻击者', color: '#fff', tags: [], attributes: ATTRS },
    { id: 'b', name: '目标', color: '#f00', tags: [], attributes: ATTRS, ...(opts.targetHp !== undefined ? { hp: opts.targetHp } : {}) },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '攻击者', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '目标', color: '#f00', x: 4, y: 2, ...(opts.targetToken ?? {}) },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: {
    mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '攻击者' }, { tokenId: 'tb', pcId: 'b', name: '目标' }],
    current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false,
  } });
  return { w, m };
}

test('落空不写假账：伤害 0 就不该有「HP 从 6 改为 6」', () => {
  const { m } = fight();
  assert.equal(api.trialAttack('tb', { roll: 3, roller: () => 3 }), null);
  const w = api.getWorld();
  const ev = w.events.at(-1);
  assert.equal(ev.check.outcome, '落空');
  assert.equal(ev.check.success, false);
  assert.deepEqual(ev.deltas, [], '落空不该有状态变化');
  assert.equal(ev.check.rolledBy, 'host', 'NPC/主机现掷的要记成 host');
  assert.match(w.log.at(-1).text, /落空/);
  assert.doesNotMatch(w.log.at(-1).text, /改为/);
  assert.equal(api.findMap(w, m.id).tokens.find((t) => t.id === 'tb').hp, undefined);
});

test('打已经昏厥的目标：不写「状态从 昏厥 改为 昏厥」', () => {
  fight({ targetToken: { down: true }, targetHp: 0 });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 3 }), null);
  const w = api.getWorld();
  const ev = w.events.at(-1);
  assert.equal(ev.check.success, true);
  assert.deepEqual(ev.deltas, []);
  assert.match(ev.note ?? '', /数值没有变化/);
});

test('带非濒死状态被打到 0：status.from 是原来的状态名，不是 null', () => {
  fight({ targetHp: 2, targetToken: { status: { label: '晕厥', roundsLeft: 2 } } });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 3 }), null);
  const ev = api.getWorld().events.at(-1);
  const st = ev.deltas.find((d) => d.kind === 'status');
  assert.equal(st.from, '晕厥');
  assert.equal(st.to, '昏厥');
  // 状态改的是棋子，id 必须是 tokenId，不能拿 pcId 顶替
  assert.equal(st.id, 'tb');
});

test('没有血条的目标：伤害没落地这件事要进账本', () => {
  const { m } = fight();
  // 角色卡没填 HP 时 hpOf 会按公式算出来，所以「没有血条」只有 NPC 棋子才成立：
  // 把目标改成没有 pcId、也没有 hp/hpMax 的棋子。
  api.update((d) => {
    const t = api.findMap(d, m.id).tokens.find((x) => x.id === 'tb');
    delete t.pcId; delete t.hp; delete t.hpMax;
  });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 3 }), null);
  const ev = api.getWorld().events.at(-1);
  assert.deepEqual(ev.deltas, []);
  assert.match(ev.note ?? '', /没有血条/);
});

test('已昏厥且身上还挂着别的状态：状态被抹掉要入账', () => {
  fight({ targetHp: 2, targetToken: { down: true, status: { label: '中毒', roundsLeft: 3 } } });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 3 }), null);
  const st = api.getWorld().events.at(-1).deltas.find((d) => d.kind === 'status');
  assert.ok(st, 'status 被 delete 了就必须有 delta');
  assert.equal(st.from, '中毒');
  assert.equal(st.to, '昏厥');
});

test('落空打没有血条的目标：不该说「伤害没落地」', () => {
  const { m } = fight();
  api.update((d) => {
    const t = api.findMap(d, m.id).tokens.find((x) => x.id === 'tb');
    delete t.pcId; delete t.hp; delete t.hpMax;
  });
  assert.equal(api.trialAttack('tb', { roll: 3, roller: () => 3 }), null);
  const ev = api.getWorld().events.at(-1);
  assert.deepEqual(ev.deltas, []);
  assert.equal(ev.note, undefined, '落空时本来就没伤害，别把原因归成没血条');
  assert.equal(ev.check.outcome, '落空');
});

test('攻击事件的 check 用的是 kind/band，不再拿 dc:0 当哨兵', () => {
  fight();
  api.settleAttack('tb', 50, { roller: () => 3, rolledBy: 'player' });
  const c = api.getWorld().events.at(-1).check;
  assert.equal(c.kind, 'attack');
  assert.equal(c.band, 'hit');
  assert.equal(c.dc, undefined);
  assert.equal(c.rolledBy, 'player');
  assert.equal(c.outcome, '命中');
});

test('锐器/钝器是装备选择：结束回合不会静默回钝器', () => {
  fight();
  api.setUI({ trial: { ...api.getUI().trial, sharpAttack: { ta: true } } });
  api.trialEndTurn();
  assert.equal(api.getUI().trial.sharpAttack.ta, true);
});

test('进出战斗要重算点池：上一场的 300 点不能带进新一场', () => {
  fight();
  api.setUI({ trial: { ...api.getUI().trial, movePoints: { ta: 300 }, charge: { ta: { progress: 1, cells: 1 } } } });
  api.toggleCombat(); // 退出战斗
  api.toggleCombat(); // 再进战斗
  assert.deepEqual(api.getUI().trial.movePoints, {});
  assert.deepEqual(api.getUI().trial.charge, {});
});

test('真实路径：A 攻击后切到 B，B 的行动点是满的', () => {
  fight();
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 3 }), null);
  assert.equal(api.actionsLeft(api.getUI().trial), 0);
  api.switchTrialPlayer(1); // 轮到目标那个角色
  assert.equal(api.getUI().trial.current, 1);
  assert.equal(api.actionsLeft(api.getUI().trial), 1);
});

test('存档校验：真事件能过校验；events 不是数组/超 200 条要报错，导入时裁到 200', () => {
  fight();
  api.trialAttack('tb', { roll: 50, roller: () => 3 }); // 先落一条真事件
  const w = api.getWorld();
  api.checkWorld(w); // 真事件必须能过校验
  const bad = JSON.parse(JSON.stringify(w));
  bad.events = 'x';
  assert.throws(() => api.checkWorld(bad), /events/);

  const many = JSON.parse(JSON.stringify(w));
  many.events = Array.from({ length: 205 }, (_, i) => ({
    id: `e${i}`, at: i, session: 0,
    actor: { kind: 'pc', id: 'a', name: '攻击者' },
    action: { name: '攻击', source: '临场' },
    deltas: [],
  }));
  assert.throws(() => api.checkWorld(many), /200/);

  const fixed = api.repairWorld(many);
  assert.match(fixed.join('；'), /200/);
  assert.equal(many.events.length, 200);
  assert.equal(many.events[0].id, 'e5');

  // 形状不对的条目要在 repair 阶段就被丢掉（跟 checkWorld 同一张单子）
  const partial = JSON.parse(JSON.stringify(w));
  partial.events = [
    partial.events[partial.events.length - 1],
    { id: 'broken', actor: { kind: 'pc', id: 'a', name: 'x' }, action: { name: '攻击', source: '临场' }, deltas: [] },
  ];
  const fixed2 = api.repairWorld(partial);
  assert.match(fixed2.join('；'), /形状不对/);
  assert.equal(partial.events.length, 1);
  assert.equal(partial.events[0].id, w.events.at(-1).id);
});
