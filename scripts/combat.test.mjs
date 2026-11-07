import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-combat-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/rules/combat'; export * from './src/rules/interaction'; export * from './src/core/defaults'; export * from './src/core/schema.js'; export * from './src/runtime/trial'; export * from './src/core/store'; export * from './src/runtime/actions'; export * from './src/scene/architecture'; export * from './src/scene/sight';`, resolveDir: root },
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

test('攻击：D100 投 1 才是大失败，其余都命中', () => {
  const one = api.rollAttack(1, 8, () => 5);
  assert.equal(one.hit, false);
  assert.equal(one.damage, 0);
  for (const roll of [2, 7, 15, 50, 99]) {
    const r = api.rollAttack(roll, 8, () => 3);
    assert.equal(r.hit, true, `D100=${roll} 应该命中`);
    assert.equal(r.damage, 3);
  }
});

test('攻击：00 是特大成功，伤害 ×4', () => {
  const r = api.rollAttack(100, 8, () => 6);
  assert.equal(r.hit, true);
  assert.equal(r.crit, true);
  assert.equal(r.damage, 24);
  assert.match(api.describeAttack('A', 'B', r), /×4/);
});

test('伤害默认 1D8：每个骰点都在 1..8', () => {
  for (let roll = 2; roll <= 99; roll++) {
    for (let face = 1; face <= 8; face++) {
      const r = api.rollAttack(roll, 8, () => face);
      assert.equal(r.damage, face);
    }
  }
});

test('HP 上限按区值算：0.4 魅 + 0.3 力 + 0.2 敏 + 0.1 志', () => {
  // Ian：力42/敏47/志63 观53/智52/魅57 → 区值 8/9/12/10/10/11
  const attrs = { 力量: 42, 敏捷: 47, 意志: 63, 观察: 53, 智慧: 52, 魅力: 57 };
  assert.equal(api.zoneOf(attrs, '魅力'), 11);
  assert.equal(api.hpMaxOf(attrs), Math.round(0.4 * 11 + 0.3 * 8 + 0.2 * 9 + 0.1 * 12)); // 4.4+2.4+1.8+1.2=9.8→10
  const pc = { attributes: attrs };
  assert.deepEqual(api.hpOf(pc), { hp: 10, max: 10 });
  assert.deepEqual(api.hpOf({ attributes: attrs, hp: 4 }), { hp: 4, max: 10 });
  assert.deepEqual(api.hpOf({}), { hp: 0, max: 0 });
});

test('伤害扣血不会扣到负数', () => {
  assert.equal(api.applyDamage(10, 3), 7);
  assert.equal(api.applyDamage(2, 9), 0);
  assert.equal(api.applyDamage(5, -4), 5);
});

test('攻击距离：曼哈顿 ≤ 8', () => {
  assert.equal(api.tokenDistance({ x: 0, y: 0 }, { x: 8, y: 0 }), 8);
  assert.equal(api.inAttackRange({ x: 0, y: 0 }, { x: 8, y: 0 }), true);
  assert.equal(api.inAttackRange({ x: 0, y: 0 }, { x: 5, y: 4 }), false);
  assert.equal(api.inAttackRange({ x: 0, y: 0 }, { x: 4, y: 4 }), true);
});

test('回合状态：扣一次再减一回合，减到 0 移除', () => {
  const { ticks, left } = api.tickEffects([
    { label: '流血', roundsLeft: 2, perRound: 2 },
    { label: '中毒', roundsLeft: 1, perRound: 3, target: 'me' },
  ]);
  assert.equal(ticks.length, 2);
  assert.equal(ticks[0].amount, 2);
  assert.equal(ticks[0].ends, false);
  assert.equal(ticks[1].target, 'me');
  assert.equal(ticks[1].ends, true);
  assert.equal(left.length, 1);
  assert.equal(left[0].roundsLeft, 1);
  assert.equal(api.effectsToMinutes(left, 5)[0].minutes, 5);
});

test('试玩里攻击：扣行动点、扣目标 HP、濒死标状态', async () => {
  // 建一个 10×10 的图，放攻击者和目标
  const w = api.emptyWorld();
  const m = api.newMap('战斗', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  const attrsTarget = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [
    { id: 'a', name: '攻击者', color: '#fff', tags: [], attributes: { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 } },
    { id: 'b', name: '目标', color: '#f00', tags: [], attributes: attrsTarget },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '攻击者', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '目标', color: '#f00', x: 4, y: 2 },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  // 直接构造试玩状态（不依赖放棋子的自动选位）
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '攻击者' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  const err = api.trialAttack('tb', { roll: 42, roller: () => 3 });
  assert.equal(err, null);
  const world = api.getWorld();
  const tb = api.findMap(world, m.id).tokens.find((t) => t.id === 'tb');
  const pcB = world.party.find((p) => p.id === 'b');
  // 全 30 的属性 → 区值 6/6/6/6/6/6，HP 上限 = 0.4*6+0.3*6+0.2*6+0.1*6 = 6
  assert.equal(pcB.hpMax, 6);
  assert.equal(pcB.hp, 3, '目标 HP 6 应该扣 3');
  assert.equal(api.actionsLeft(api.getUI().trial), 0);
  assert.match(api.trialAttack('tb') ?? '', /行动点/);
  api.trialEndTurn();
  assert.equal(api.actionsLeft(api.getUI().trial), 1);
});

test('目标是濒死就不能再打', () => {
  const w = api.emptyWorld();
  const m = api.newMap('战斗', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [
    { id: 'a', name: '攻击者', color: '#fff', tags: [], attributes: { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 } },
    { id: 'b', name: '目标', color: '#f00', tags: [], attributes: { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 }, hp: 0 },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '攻击者', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '目标', color: '#f00', x: 3, y: 2, status: { label: '濒死', roundsLeft: 3 } },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '攻击者' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  assert.match(api.trialAttack('tb', { roll: 50, roller: () => 1 }) ?? '', /濒死/);
  const targets = api.trialAttackTargets();
  assert.equal(targets.find((t) => t.tokenId === 'tb').canHit, false);
});

test('攻击后给出事件卡片所需的数据', () => {
  const w = api.emptyWorld();
  const m = api.newMap('战斗', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [
    { id: 'a', name: '攻击者', color: '#fff', tags: [], attributes: attrs },
    { id: 'b', name: '目标', color: '#f00', tags: [], attributes: attrs },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '攻击者', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '目标', color: '#f00', x: 3, y: 2 },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '攻击者' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialAttack('tb', { roll: 100, roller: () => 2 });
  const ev = api.getUI().trial.event;
  assert.equal(ev.kind, 'hit');
  assert.equal(ev.crit, true);
  assert.equal(ev.roll, 100);
  assert.equal(ev.damage, 8); // 2 × 4
  assert.equal(ev.hpBefore, 6);
  assert.equal(ev.hpAfter, 0);
  assert.equal(ev.dying, true);
  assert.equal(ev.targetName, '目标');
  assert.equal(api.getUI().trial.msg, '');
});
