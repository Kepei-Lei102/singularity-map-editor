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

test('攻击：1–5 落空，6–94 命中', () => {
  // 作者口径：000 特大成功、1–5 落空、95–99 大成功、其余命中。
  for (const roll of [1, 2, 3, 4, 5]) {
    const r = api.rollAttack(roll, 8, () => 3);
    assert.equal(r.hit, false, `D100=${roll} 应该落空`);
    assert.equal(r.damage, 0);
    assert.equal(r.dice, 0);
  }
  for (const roll of [6, 7, 15, 50, 94]) {
    const r = api.rollAttack(roll, 8, () => 3);
    assert.equal(r.hit, true, `D100=${roll} 应该命中`);
    assert.equal(r.dice, 1, '普通命中掷 1 颗伤害骰');
    assert.equal(r.damage, 3);
  }
});

test('攻击：95–99 大成功，1D8 变 2D8', () => {
  for (const roll of [95, 96, 97, 98, 99]) {
    const r = api.rollAttack(roll, 8, () => 6);
    assert.equal(r.hit, true);
    assert.equal(r.band, 'great');
    assert.equal(r.dice, 2, '大成功伤害骰数量翻倍');
    assert.equal(r.rolls.length, 2);
    assert.equal(r.damage, 12);
    assert.equal(r.crit, true);
  }
});

test('攻击：00 是特大成功，1D8 变 4D8', () => {
  const r = api.rollAttack(100, 8, () => 6);
  assert.equal(r.hit, true);
  assert.equal(r.band, 'super');
  assert.equal(r.dice, 4, '特大成功伤害骰 ×4');
  assert.equal(r.damage, 24);
  assert.match(api.describeAttack('A', 'B', r), /4 颗伤害骰/);
});

test('伤害默认 1D8：每个骰点都在 1..8', () => {
  for (let roll = 6; roll <= 94; roll++) {
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
  // 事件账本：一句宣告 + 一句结果，都是渲染出来的
  const ev = world.events.at(-1);
  assert.equal(ev.action.name, '攻击（钝器）');
  assert.equal(ev.check.success, true);
  assert.equal(ev.deltas[0].kind, 'hp');
  assert.equal(ev.deltas[0].from, 6);
  assert.equal(ev.deltas[0].to, 3);
  assert.match(world.log.at(-1).text, /^攻击者 对 目标 发起了【攻击（钝器）】.*目标 的 HP 从 6 改为 3$/);
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
  assert.equal(ev.downed, 'down'); // 这一击是钝器：打倒成昏厥，不是撕卡
  assert.equal(ev.targetName, '目标');
  assert.equal(api.getUI().trial.msg, '');
});

test('借机攻击只在贴身脱离时触发（乙口径）', () => {
  const enemy = { id: 'e1', x: 5, y: 5 };
  // 原本贴身（2 格），往外挪到 3 格 → 触发，敌人算进去
  const a = api.opportunityTriggers({ x: 5, y: 6 }, { x: 5, y: 8 }, [enemy]);
  assert.equal(a.leaving, true);
  assert.deepEqual(a.enemies, ['e1']);
  // 远端进出（远到 8 格外，再走进 4 格）→ 不触发，因为起点就不贴身
  const b = api.opportunityTriggers({ x: 5, y: 12 }, { x: 5, y: 9 }, [enemy]);
  assert.equal(b.leaving, false);
  // 原地不动 / 往里走 → 不触发
  assert.equal(api.opportunityTriggers({ x: 5, y: 2 }, { x: 5, y: 3 }, [enemy]).leaving, false);
  // 贴身后依然贴身（2 格挪到 1 格）→ 不触发
  assert.equal(api.opportunityTriggers({ x: 6, y: 6 }, { x: 5, y: 6 }, [enemy]).leaving, false);
});

test('贴身范围内一次只能挪 1 格', () => {
  const enemy = { x: 5, y: 5 };
  assert.equal(api.stepLimitNear({ x: 5, y: 6 }, [enemy]), 1);
  assert.equal(api.stepLimitNear({ x: 5, y: 7 }, [enemy]), 1);
  assert.equal(api.stepLimitNear({ x: 5, y: 9 }, [enemy]), Number.POSITIVE_INFINITY);
});

test('借机攻击每个人回合外只能一次', () => {
  const w = api.emptyWorld();
  const m = api.newMap('借机', '现实', 1, 12, 12, 'floor', false);
  m.objects = [];
  m.fog = m.fog.map(() => 1);
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [
    { id: 'a', name: '走的人', color: '#fff', tags: [], attributes: attrs },
    { id: 'b', name: '敌人', color: '#f00', tags: [], attributes: attrs },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '走的人', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '敌人', color: '#f00', x: 2, y: 4 },
  ];
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '走的人' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  // 敌人原本在 2 格（贴身）。战斗里第一次按方向只转向，所以先转北再走两格脱离。
  api.trialMove(0, -1); // 转向北
  api.trialMove(0, -1); // 距离 2 → 3，脱离
  const opp = api.getUI().trial.opportunity;
  assert.ok(opp && opp.enemies.includes('tb'), '应该触发借机');
  api.trialOpportunityAttack();
  assert.equal(api.findMap(api.getWorld(), m.id).tokens.find((k) => k.id === 'tb').opportunityUsed, true);
  assert.equal(api.getUI().trial.opportunity, null);
});

test('救治：解锁急救技能才能做，D100 投 1 失败', () => {
  const w = api.emptyWorld();
  const m = api.newMap('救治', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  m.fog = m.fog.map(() => 1);
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [
    { id: 'a', name: '医生', color: '#fff', tags: [], attributes: attrs, skills: ['011-9-102'] },
    { id: 'b', name: '伤员', color: '#f00', tags: [], attributes: attrs, hp: 0 },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '医生', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '伤员', color: '#f00', x: 2, y: 3, status: { label: '濒死', roundsLeft: 3 } },
  ];
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '医生' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  // 投 1 失败（结果写在 HUD 的 msg 里）
  assert.equal(api.trialRescue('tb', { roll: 1 }), null);
  assert.match(api.getUI().trial.msg, /失败/);
  api.setUI({ trial: { ...api.getUI().trial, acted: {} } });
  assert.equal(api.trialRescue('tb', { roll: 60 }), null);
  assert.match(api.getUI().trial.msg, /成功/);
  const tb = api.findMap(api.getWorld(), m.id).tokens.find((k) => k.id === 'tb');
  assert.equal(tb.status, undefined);
  assert.equal(api.getWorld().party.find((p) => p.id === 'b').hp, 1);
});

test('没解锁急救技能的人不能救治', () => {
  assert.equal(api.canRescue([]), false);
  assert.equal(api.canRescue(['001-9-001']), false);
  assert.equal(api.canRescue(['011-9-102']), true);
});

test('钝器打倒 → 昏厥；锐器打倒 → 濒死', () => {
  assert.equal(api.downedBy(false), 'down');
  assert.equal(api.downedBy(true), 'dying');
  assert.equal(api.downedLabel('down'), '昏厥');
  assert.equal(api.downedLabel('dying'), '濒死');
  assert.equal(api.DYING_ROUNDS, 3);
});

test('没有锐器的角色勾不了锐器', () => {
  assert.equal(api.canUseSharp({ sharp: true }), true);
  assert.equal(api.canUseSharp({ sharp: false }), false);
  assert.equal(api.canUseSharp({}), false);
  assert.equal(api.canUseSharp(null), false);
});

test('钝器把 HP 打到 0 是昏厥，锐器是濒死', () => {
  const run = (sharp) => {
    const w = api.emptyWorld();
    const m = api.newMap('打', '现实', 1, 10, 10, 'floor', false);
    m.objects = []; m.fog = m.fog.map(() => 1);
    const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
    w.party = [
      { id: 'a', name: '打手', color: '#fff', tags: [], attributes: attrs, sharp: true },
      { id: 'b', name: '挨打的', color: '#f00', tags: [], attributes: attrs, hp: 1, hpMax: 6 },
    ];
    m.tokens = [
      { id: 'ta', pcId: 'a', name: '打手', color: '#fff', x: 2, y: 2 },
      { id: 'tb', pcId: 'b', name: '挨打的', color: '#f00', x: 2, y: 3 },
    ];
    w.maps = [m];
    api.replaceWorld(w);
    api.startTrial();
    api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '打手' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
    assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 3, sharp }), null);
    const tb = api.findMap(api.getWorld(), m.id).tokens.find((k) => k.id === 'tb');
    return { downed: api.getUI().trial.event.downed, status: tb.status?.label ?? null, down: tb.down ?? false, hp: api.getWorld().party.find(p => p.id === 'b').hp };
  };
  const blunt = run(false);
  assert.equal(blunt.downed, 'down');
  assert.equal(blunt.status, null);
  assert.equal(blunt.down, true);
  assert.equal(blunt.hp, 0);
  const sharp = run(true);
  assert.equal(sharp.downed, 'dying');
  assert.equal(sharp.status, '濒死');
  assert.equal(sharp.down, false);
});

test('身上没锐器的角色勾了锐器会被拦', () => {
  const w = api.emptyWorld();
  const m = api.newMap('打', '现实', 1, 10, 10, 'floor', false);
  m.objects = []; m.fog = m.fog.map(() => 1);
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [{ id: 'a', name: '拳手', color: '#fff', tags: [], attributes: attrs }, { id: 'b', name: '靶子', color: '#f00', tags: [], attributes: attrs }];
  m.tokens = [{ id: 'ta', pcId: 'a', name: '拳手', color: '#fff', x: 2, y: 2 }, { id: 'tb', pcId: 'b', name: '靶子', color: '#f00', x: 2, y: 3 }];
  w.maps = [m]; api.replaceWorld(w); api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '拳手' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  assert.match(api.trialAttack('tb', { roll: 50, sharp: true }) ?? '', /没有锐器/);
});

test('NPC 棋子填了 hpMax 就会扣血', () => {
  const w = api.emptyWorld();
  const m = api.newMap('打', '现实', 1, 12, 12, 'floor', false);
  m.objects = []; m.fog = m.fog.map(() => 1);
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [{ id: 'a', name: '打手', color: '#fff', tags: [], attributes: attrs }];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '打手', color: '#fff', x: 2, y: 2 },
    { id: 'robot', pcId: null, name: '机器人', color: '#888', x: 2, y: 3, hp: 80, hpMax: 80 },
  ];
  w.maps = [m]; api.replaceWorld(w); api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '打手' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  assert.equal(api.trialAttack('robot', { roll: 30, roller: () => 5 }), null);
  const ev = api.getUI().trial.event;
  assert.equal(ev.hpBefore, 80);
  assert.equal(ev.hpAfter, 75);
  assert.equal(ev.hpMax, 80);
  assert.equal(api.findMap(api.getWorld(), m.id).tokens.find(k => k.id === 'robot').hp, 75);
});

test('NPC 没填血条就不扣，只提示记在裁定里', () => {
  const w = api.emptyWorld();
  const m = api.newMap('打', '现实', 1, 12, 12, 'floor', false);
  m.objects = []; m.fog = m.fog.map(() => 1);
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [{ id: 'a', name: '打手', color: '#fff', tags: [], attributes: attrs }];
  m.tokens = [{ id: 'ta', pcId: 'a', name: '打手', color: '#fff', x: 2, y: 2 }, { id: 'npc', pcId: null, name: '路人', color: '#888', x: 2, y: 3 }];
  w.maps = [m]; api.replaceWorld(w); api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '打手' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  assert.equal(api.trialAttack('npc', { roll: 30, roller: () => 5 }), null);
  const ev = api.getUI().trial.event;
  assert.equal(ev.hpBefore, null);
  assert.match(ev.note ?? '', /没有血条/);
});

test('濒死三回合走完就撕卡：卡标已死亡，尸体留在原地', () => {
  const w = api.emptyWorld();
  const m = api.newMap('战斗', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [
    { id: 'a', name: '队友', color: '#fff', tags: [], attributes: { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 } },
    { id: 'b', name: '伤员', color: '#f00', tags: [], attributes: { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 }, hp: 0 },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '队友', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '伤员', color: '#f00', x: 3, y: 2, status: { label: '濒死', roundsLeft: 3 } },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '队友' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });

  api.trialEndTurn();
  assert.equal(api.findMap(api.getWorld(), m.id).tokens.find((t) => t.id === 'tb').status.roundsLeft, 2, '第一轮只是减一');
  assert.notEqual(api.getWorld().party.find((p) => p.id === 'b').dead, true);

  api.trialEndTurn();
  api.trialEndTurn();
  const world = api.getWorld();
  const tb = api.findMap(world, m.id).tokens.find((t) => t.id === 'tb');
  const pcB = world.party.find((p) => p.id === 'b');
  assert.equal(pcB.dead, true, '三回合到点撕卡');
  assert.deepEqual(pcB.deathPlace, { mapId: m.id, x: 3, y: 2 }, '死在原地，坐标留着');
  assert.equal(tb.corpse, true, '棋子变尸体，不删掉');
  assert.equal(tb.status, undefined, '濒死标签清掉');
  assert.ok(world.log.some((l) => l.text.includes('撕卡')), '日志里留一句');
});

test('尸体不能打、不能救，也不算可攻击目标', () => {
  const w = api.emptyWorld();
  const m = api.newMap('战斗', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [
    { id: 'a', name: '队友', color: '#fff', tags: [], attributes: attrs, skills: ['011-9-102'] },
    { id: 'b', name: '死者', color: '#f00', tags: [], attributes: attrs, hp: 0, dead: true, deathPlace: { mapId: m.id, x: 3, y: 2 } },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '队友', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '死者', color: '#f00', x: 3, y: 2, corpse: true },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '队友' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });

  assert.equal(api.trialAttackTargets().some((t) => t.tokenId === 'tb'), false, '尸体不进攻击候选');
  assert.match(api.trialRescue('tb', { roll: 30 }) ?? '', /死了|救不回来/);
});

test('非战斗状态：濒死挂「急救机器人正在赶来」，到点自动拉起', () => {
  const now = 1_000_000;
  assert.match(api.robotIncoming(now).label, /急救机器人/);
  assert.equal(api.robotArrived(api.robotIncoming(now).endsAt, now), false, '刚挂上时还没到');
  assert.equal(api.robotArrived(api.robotIncoming(now).endsAt, now + api.ROBOT_ETA_MS), true, '到点就到了');

  const w = api.emptyWorld();
  const m = api.newMap('战斗', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [
    { id: 'a', name: '队友', color: '#fff', tags: [], attributes: attrs },
    { id: 'b', name: '伤员', color: '#f00', tags: [], attributes: attrs, hp: 0 },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '队友', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '伤员', color: '#f00', x: 3, y: 2, status: api.robotIncoming(now) },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  // 自由行动：不是战斗模式
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '队友' }], current: 0, combat: false, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });

  api.tickRobots(now + 1000);
  assert.equal(api.findMap(api.getWorld(), m.id).tokens.find((t) => t.id === 'tb').status.label.startsWith('急救机器人'), true, '没到点不动');

  api.tickRobots(now + api.ROBOT_ETA_MS);
  const tb = api.findMap(api.getWorld(), m.id).tokens.find((t) => t.id === 'tb');
  assert.equal(tb.status, undefined, '到点清掉状态');
  assert.equal(api.getWorld().party.find((p) => p.id === 'b').hp, api.RESCUED_HP, '机器人把人拉起来，1 HP');
});

test('尸体能搬，搬了位置记录跟着走', () => {
  const w = api.emptyWorld();
  const m = api.newMap('战斗', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [{ id: 'b', name: '死者', color: '#f00', tags: [], dead: true, deathPlace: { mapId: m.id, x: 3, y: 2 } }];
  m.tokens = [{ id: 'tb', pcId: 'b', name: '死者', color: '#f00', x: 3, y: 2, corpse: true }];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  assert.equal(api.moveMapToken(m.id, 'tb', { x: 7, y: 6 }), null, '尸体可以直接抬走');
  const world = api.getWorld();
  assert.deepEqual(world.party.find((p) => p.id === 'b').deathPlace, { mapId: m.id, x: 7, y: 6 }, '记录位置跟着尸体');
});

test('行动点按人记：一个人用掉不影响另一个人', () => {
  // actionsLeft 只看账本，不碰地图；给个占位 mapId 就够。
  api.setUI({ trial: {
    mapId: 'x', combat: true, current: 0, moved: {}, turned: {}, turn: 1,
    msg: '', markSymbol: '!', markText: '', markMode: false,
    players: [
      { tokenId: 'ta', pcId: 'a', name: '医生' },
      { tokenId: 'tb', pcId: 'b', name: '伤员' },
    ],
    acted: { ta: true },
  } });
  // 甲用掉了行动点
  assert.equal(api.actionsLeft(api.getUI().trial), 0);
  // 轮到乙：乙这一回合还没动过，点数得是满的
  api.setUI({ trial: { ...api.getUI().trial, current: 1 } });
  assert.equal(api.actionsLeft(api.getUI().trial), 1);
});
