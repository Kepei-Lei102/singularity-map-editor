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
  stdin: { contents: `export * from './src/rules/combat'; export * from './src/rules/interaction'; export * from './src/core/defaults'; export * from './src/core/schema.js'; export * from './src/runtime/trial'; export * from './src/core/store'; export * from './src/runtime/actions'; export * from './src/scene/architecture'; export * from './src/scene/sight'; export * from './src/scene/memory';`, resolveDir: root },
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

test('NPC 血条：没填默认 10，hp 硬夹在 [0, hpMax]', () => {
  assert.deepEqual(api.npcHpPool({}), { hp: 10, max: 10 });
  assert.deepEqual(api.npcHpPool({ hpMax: 0 }), { hp: 10, max: 10 });
  assert.deepEqual(api.npcHpPool({ hp: 15, hpMax: 10 }), { hp: 10, max: 10 });
  assert.deepEqual(api.npcHpPool({ hp: -3, hpMax: 10 }), { hp: 0, max: 10 });
  assert.deepEqual(api.npcHpPool({ hp: 15, hpMax: 20 }), { hp: 15, max: 20 });
  assert.deepEqual(api.npcHpPool({ hpMax: 0, down: true }), { hp: 0, max: 10 }, '倒地没填 hp 不能满血');
  assert.deepEqual(api.npcHpPool({ hpMax: 0, status: { label: '濒死', roundsLeft: 3 } }), { hp: 0, max: 10 });
  assert.deepEqual(api.npcHpPool({ hpMax: 0, status: { label: '急救机器人正在赶来', endsAt: 1 } }), { hp: 0, max: 10 });
  assert.deepEqual(api.npcHpPool({ hp: 5, hpMax: 10, down: true }), { hp: 5, max: 10 }, '明确填了 hp 就尊重它');
});

test('normalizeNpcHp 防御 malformed 旧档', () => {
  assert.doesNotThrow(() => api.normalizeNpcHp(null));
  assert.doesNotThrow(() => api.normalizeNpcHp({ maps: null }));
  assert.doesNotThrow(() => api.normalizeNpcHp({ maps: [null, { tokens: null }, { tokens: [null, {}] }] }));
});

test('migrateWorld 防御非数组 log', () => {
  const w = api.emptyWorld();
  w.log = null;
  assert.doesNotThrow(() => api.migrateWorld(w));
  assert.ok(Array.isArray(w.log));
  assert.match(w.log.at(-1).text, /事件日志损坏/);
});

test('migrateWorld 对缺失 log 不误报损坏', () => {
  const w = api.emptyWorld();
  delete w.log;
  assert.doesNotThrow(() => api.migrateWorld(w));
  assert.ok(Array.isArray(w.log));
  assert.equal(w.log.length, 0, '只是缺字段，不该提示损坏');
});

test('迁移 warning：hp10.6/hpMax10.3 写回 10/10 并提示，down 不误报', () => {
  const w = api.emptyWorld();
  const m = api.newMap('边界', '现实', 1, 10, 10, 'floor', false);
  m.tokens = [
    { id: 'f1', pcId: null, name: '小数缩水', color: '#888', x: 2, y: 2, hp: 10.6, hpMax: 10.3 },
    { id: 'd1', pcId: null, name: '倒地小数上限', color: '#888', x: 3, y: 2, down: true, hp: 1, hpMax: 0.4 },
    { id: 'd2', pcId: null, name: '倒地大血', color: '#888', x: 4, y: 2, down: true, hp: 80 },
    { id: 'd3', pcId: null, name: '倒地没填', color: '#888', x: 5, y: 2, down: true },
    { id: 'd4', pcId: null, name: '倒地超上限', color: '#888', x: 6, y: 2, down: true, hp: 15, hpMax: 10 },
  ];
  w.maps = [m];
  const mw = api.migrateWorld(w);
  const byId = new Map(mw.maps[0].tokens.map((t) => [t.id, t]));
  assert.equal(byId.get('f1').hp, 10);
  assert.equal(byId.get('f1').hpMax, 10);
  assert.equal(byId.get('d1').hp, 1);
  assert.equal(byId.get('d1').hpMax, 1);
  assert.equal(byId.get('d2').hp, 10);
  assert.equal(byId.get('d2').hpMax, 10);
  assert.equal(byId.get('d3').hp, 0);
  assert.equal(byId.get('d3').hpMax, 10);
  assert.equal(byId.get('d4').hp, 10);
  assert.equal(byId.get('d4').hpMax, 10);
  const note = mw.log.filter((x) => x.text.includes('旧档 NPC 血条')).map((x) => x.text).join('\n');
  assert.match(note, /小数缩水（hp 11 超过上限 10）/);
  assert.match(note, /倒地大血（hp 80，按默认上限 10）/);
  assert.match(note, /倒地超上限（hp 15 超过上限 10）/);
  assert.doesNotMatch(note, /倒地小数上限/);
  assert.doesNotMatch(note, /倒地没填/);
});

test('迁移 warning 不误报 round 后没缩水的上限', () => {
  const w = api.emptyWorld();
  const m = api.newMap('小数上限', '现实', 1, 10, 10, 'floor', false);
  m.tokens = [
    { id: 'n5', pcId: null, name: '小数上限', color: '#888', x: 2, y: 2, hp: 1, hpMax: 0.4 },
    { id: 'n8', pcId: null, name: '半整数上限', color: '#888', x: 3, y: 2, hp: 11, hpMax: 10.5 },
  ];
  w.maps = [m];
  const mw = api.migrateWorld(w);
  const byId = new Map(mw.maps[0].tokens.map((t) => [t.id, t]));
  assert.equal(byId.get('n5').hp, 1);
  assert.equal(byId.get('n5').hpMax, 1);
  assert.equal(byId.get('n8').hp, 11);
  assert.equal(byId.get('n8').hpMax, 11);
  assert.equal(mw.log.some((x) => x.text.includes('旧档 NPC 血条')), false, 'round 后没缩水就不提示');
});

test('raw 缺省 NPC：attackTargets 直接按默认 10，不依赖 store 归一', () => {
  const w = api.emptyWorld();
  const m = api.newMap('raw', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  const attacker = { id: 'ta', pcId: 'a', name: '打手', color: '#fff', x: 2, y: 2 };
  const npc = { id: 'npc', pcId: null, name: '路人', color: '#888', x: 2, y: 3 };
  m.tokens = [attacker, npc];
  w.maps = [m];
  const target = api.attackTargets(w, m, attacker, () => true).find((x) => x.tokenId === 'npc');
  assert.equal(target.hp, 10, 'raw 棋子没填 hp/hpMax 也应显示 10');
  assert.equal(target.canHit, true);
});

test('update 立刻把会话里的 NPC 血条归一', () => {
  const w = api.emptyWorld();
  const m = api.newMap('归一', '现实', 1, 10, 10, 'floor', false);
  m.tokens = [{ id: 'npc', pcId: null, name: '路人', color: '#888', x: 2, y: 2 }];
  w.maps = [m];
  api.replaceWorld(w);
  api.update((d) => {
    const t = d.maps[0].tokens.find((x) => x.id === 'npc');
    t.hp = 5; t.hpMax = 0;
  });
  const t = api.getWorld().maps[0].tokens.find((x) => x.id === 'npc');
  assert.equal(t.hpMax, 10);
  assert.equal(t.hp, 5);
});

test('update 归一幂等；PC token 的 raw hp/hpMax 会被清掉', () => {
  const w = api.emptyWorld();
  const m = api.newMap('幂等', '现实', 1, 10, 10, 'floor', false);
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 } }];
  m.tokens = [
    { id: 'npc', pcId: null, name: '路人', color: '#888', x: 2, y: 2 },
    { id: 'pc', pcId: 'a', name: '甲', color: '#fff', x: 3, y: 2, hp: 3, hpMax: 0 },
  ];
  w.maps = [m];
  api.replaceWorld(w);
  api.update((d) => {
    const npc = d.maps[0].tokens.find((x) => x.id === 'npc');
    npc.hp = 5; npc.hpMax = 0;
    const pc = d.maps[0].tokens.find((x) => x.id === 'pc');
    pc.hp = 3; pc.hpMax = 0;
  });
  const after = api.getWorld().maps[0].tokens;
  assert.equal(after.find((x) => x.id === 'npc').hp, 5);
  assert.equal(after.find((x) => x.id === 'npc').hpMax, 10);
  assert.equal(after.find((x) => x.id === 'pc').hp, undefined);
  assert.equal(after.find((x) => x.id === 'pc').hpMax, undefined);
  const before = JSON.stringify(after);
  api.update((d) => { d.maps[0].tokens.find((x) => x.id === 'npc').name = '改名'; });
  const second = api.getWorld().maps[0].tokens;
  assert.equal(second.find((x) => x.id === 'npc').hp, 5);
  assert.equal(second.find((x) => x.id === 'npc').hpMax, 10);
  assert.notEqual(JSON.stringify(second), before, '名字确实改了');
});

test('NPC 上限输入：空/0回默认，正小数按四舍五入，至少 1', () => {
  assert.equal(api.parseNpcHpMaxInput(''), 10);
  assert.equal(api.parseNpcHpMaxInput('   '), 10);
  assert.equal(api.parseNpcHpMaxInput('0'), 10);
  assert.equal(api.parseNpcHpMaxInput('-3'), 10);
  assert.equal(api.parseNpcHpMaxInput('abc'), 10);
  assert.equal(api.parseNpcHpMaxInput('0.4'), 1);
  assert.equal(api.parseNpcHpMaxInput('1.6'), 2);
  assert.equal(api.parseNpcHpMaxInput('10.4'), 10);
  assert.equal(api.parseNpcHpMaxInput('20'), 20);
  assert.equal(api.clampHpToMax(undefined, 20), undefined);
  assert.equal(api.clampHpToMax(10, 20), 10);
  assert.equal(api.clampHpToMax(25, 20), 20);
  assert.equal(api.clampHpToMax(10, 10), 10);
});

test('读档迁移：NPC 血条写回成确定值，PC token 的 raw HP 清掉', () => {
  const w = api.emptyWorld();
  const m = api.newMap('旧档', '现实', 1, 10, 10, 'floor', false);
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 } }];
  m.tokens = [
    { id: 'n1', pcId: null, name: '零上限', color: '#888', x: 2, y: 2, hp: 5, hpMax: 0 },
    { id: 'n2', pcId: null, name: '只有HP', color: '#888', x: 3, y: 2, hp: 80 },
    { id: 'n3', pcId: null, name: '倒地没填', color: '#888', x: 4, y: 2, down: true },
    { id: 'n4', pcId: null, name: '濒死没填', color: '#888', x: 5, y: 2, status: { label: '濒死', roundsLeft: 3 } },
    { id: 'n5', pcId: null, name: '小数上限', color: '#888', x: 6, y: 2, hp: 1, hpMax: 0.4 },
    { id: 'n6', pcId: null, name: '正常上限', color: '#888', x: 7, y: 2, hp: 15, hpMax: 20 },
    { id: 'n7', pcId: null, name: '超上限', color: '#888', x: 9, y: 2, hp: 15, hpMax: 10 },
    { id: 'p1', pcId: 'a', name: '甲', color: '#fff', x: 8, y: 2, hp: 3, hpMax: 0 },
  ];
  w.maps = [m];
  const mw = api.migrateWorld(w);
  assert.doesNotThrow(() => api.checkWorld(mw, true), '迁移日志要能过严格 schema');
  const migrated = mw.maps[0].tokens;
  const byId = new Map(migrated.map((t) => [t.id, t]));
  assert.equal(byId.get('n1').hpMax, 10);
  assert.equal(byId.get('n1').hp, 5);
  assert.equal(byId.get('n2').hpMax, 10, '旧档只填 hp 的 NPC 按默认上限 10');
  assert.equal(byId.get('n2').hp, 10, '80 被夹到 10，不猜旧档意图');
  assert.equal(byId.get('n3').hp, 0, '倒地没填 hp 归 0，不能满血躺着');
  assert.equal(byId.get('n3').hpMax, 10);
  assert.equal(byId.get('n4').hp, 0, '濒死没填 hp 归 0');
  assert.equal(byId.get('n4').hpMax, 10);
  assert.equal(byId.get('n5').hpMax, 1);
  assert.equal(byId.get('n5').hp, 1);
  assert.equal(byId.get('n6').hpMax, 20);
  assert.equal(byId.get('n6').hp, 15);
  assert.equal(byId.get('n7').hpMax, 10);
  assert.equal(byId.get('n7').hp, 10);
  assert.equal(byId.get('p1').hp, undefined, 'PC 的血走角色卡，token 上的 hp 清掉');
  assert.equal(byId.get('p1').hpMax, undefined);
  assert.match(mw.log.at(-1).text, /旧档 NPC 血条/);
  assert.match(mw.log.at(-1).text, /只有HP.*hp 80/);
  assert.match(mw.log.at(-1).text, /超上限.*超过上限 10/);
  const logLen = mw.log.length;
  api.migrateWorld(mw);
  assert.equal(mw.log.length, logLen, '第二次迁移不再重复提示');
});

test('攻击：95–99 大成功，1D8 变 2D8', () => {
  for (const roll of [95, 96, 97, 98, 99]) {
    const r = api.rollAttack(roll, 8, () => 6);
    assert.equal(r.hit, true);
    assert.equal(r.band, 'great');
    assert.equal(r.dice, 2, '大成功伤害骰数量翻倍');
    assert.equal(r.rolls.length, 2);
    assert.equal(r.rounds.length, 2, '大成功拆两轮');
    assert.deepEqual(r.rounds.map((x) => x.dice), [1, 1]);
    assert.deepEqual(r.rounds.map((x) => x.damage), [6, 6]);
    assert.equal(r.damage, 12);
    assert.equal(r.crit, true);
  }
});

test('攻击：00 是特大成功，1D8 变 4D8', () => {
  const r = api.rollAttack(100, 8, () => 6);
  assert.equal(r.hit, true);
  assert.equal(r.band, 'super');
  assert.equal(r.dice, 4, '特大成功伤害骰 ×4');
  assert.equal(r.rounds.length, 4, '特大成功拆四轮');
  assert.deepEqual(r.rounds.map((x) => x.damage), [6, 6, 6, 6]);
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

function opportunityFight({ skills = [], weakness, hp = 50, hpMax = 50, moverNpc = false, twoEnemies = false, enemyNpc = false } = {}) {
  const w = api.emptyWorld();
  const m = api.newMap('借机技能', '现实', 1, 12, 12, 'floor', false);
  m.objects = [];
  m.fog = m.fog.map(() => 1);
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [
    { id: 'a', name: '走的人', color: '#fff', tags: [], attributes: attrs, hp, hpMax },
    { id: 'b', name: '敌人', color: '#f00', tags: [], attributes: attrs, skills, me: 5 },
    ...(twoEnemies ? [{ id: 'c', name: '敌人二号', color: '#0f0', tags: [], attributes: attrs, me: 5 }] : []),
  ];
  m.tokens = [
    moverNpc
      ? { id: 'ta', pcId: null, name: '走的人', color: '#fff', x: 2, y: 2, hp, hpMax, ...(weakness ? { weakness } : {}) }
      : { id: 'ta', pcId: 'a', name: '走的人', color: '#fff', x: 2, y: 2, ...(weakness ? { weakness } : {}) },
    enemyNpc
      ? { id: 'tb', pcId: null, name: '敌人', color: '#f00', x: 2, y: 4 }
      : { id: 'tb', pcId: 'b', name: '敌人', color: '#f00', x: 2, y: 4 },
    ...(twoEnemies ? [{ id: 'tc', pcId: 'c', name: '敌人二号', color: '#0f0', x: 4, y: 2 }] : []),
  ];
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '走的人' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialMove(0, -1);
  api.trialMove(0, -1);
  return m;
}

test('借机攻击接入 009：已知物理弱点命中就眩晕，不扣 ME', () => {
  opportunityFight({ skills: ['009-9-003'], weakness: { physical: true } });
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 3 }), null);
  const a = api.getWorld().maps[0].tokens.find((k) => k.id === 'ta');
  assert.equal(a.status.label, '眩晕');
  assert.equal(a.status.skipTurns, 1);
  assert.equal(api.getWorld().party.find((p) => p.id === 'a').hp, 47);
  assert.equal(api.getWorld().party.find((p) => p.id === 'b').me, 5, '009 是被动，不扣 ME');
  assert.match(api.getUI().trial.msg, /眩晕打击/);
  const ev = api.getWorld().events.at(-1);
  assert.equal(ev.action.name, '借机攻击');
  assert.ok(ev.deltas.some((d) => d.kind === 'status' && d.from === null && d.to === '眩晕'));
});

test('借机攻击接入 009：伤害骰出 8 也眩晕', () => {
  opportunityFight({ skills: ['009-9-003'] });
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 8 }), null);
  const a = api.getWorld().maps[0].tokens.find((k) => k.id === 'ta');
  assert.equal(a.status.label, '眩晕');
});

test('借机攻击没有 009：伤害骰出 8 也不眩晕', () => {
  opportunityFight({ weakness: { physical: true } });
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 8 }), null);
  const a = api.getWorld().maps[0].tokens.find((k) => k.id === 'ta');
  assert.equal(a.status, undefined);
});

test('借机攻击 009：目标已眩晕时伤害骰 ×5', () => {
  opportunityFight({ skills: ['009-9-003'] });
  api.update((d) => {
    d.maps[0].tokens.find((k) => k.id === 'ta').status = { label: '眩晕', skipTurns: 1, blocksAction: true };
  });
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 8 }), null);
  const w = api.getWorld();
  assert.equal(w.party.find((p) => p.id === 'a').hp, 10, '普通命中 1 颗 ×5 颗，每颗 8');
  assert.equal(w.maps[0].tokens.find((k) => k.id === 'ta').status.label, '眩晕');
  assert.match(api.getUI().trial.msg, /5 颗伤害骰/);
  assert.match(api.getUI().trial.msg, /眩晕刷新/, '被动命中 8 时应刷新眩晕而不是新挂');
});

test('借机攻击 009：大成功打已眩晕目标，伤害骰 10 颗', () => {
  opportunityFight({ skills: ['009-9-003'], hp: 100, hpMax: 100 });
  api.update((d) => {
    d.maps[0].tokens.find((k) => k.id === 'ta').status = { label: '眩晕', skipTurns: 1, blocksAction: true };
  });
  assert.equal(api.trialOpportunityAttack({ roll: 96, roller: () => 8 }), null);
  const w = api.getWorld();
  assert.equal(w.party.find((p) => p.id === 'a').hp, 20, '大成功 2 颗 ×5 = 10 颗，每颗 8');
  assert.match(api.getUI().trial.msg, /10 颗伤害骰/);
  assert.match(w.events.at(-1).note, /两轮：40 \+ 40/, '借机大成功也按轮落账');
});

test('借机攻击大成功打残血：UI 报掷出和实扣，事件摘要写实扣', () => {
  opportunityFight({ hp: 2, hpMax: 20 });
  assert.equal(api.trialOpportunityAttack({ roll: 95, roller: () => 4 }), null);
  const w = api.getWorld();
  assert.equal(w.party.find((p) => p.id === 'a').hp, 0);
  assert.match(api.getUI().trial.msg, /伤害 8（实扣 2）/);
  assert.match(w.events.at(-1).note, /两轮：2（目标倒下，1 轮未结算）/);
});

test('借机攻击 009：已眩晕目标被打到 0 仍按昏厥，不叠眩晕', () => {
  opportunityFight({ skills: ['009-9-003'], hp: 4, hpMax: 4 });
  api.update((d) => {
    d.maps[0].tokens.find((k) => k.id === 'ta').status = { label: '眩晕', skipTurns: 1, blocksAction: true };
  });
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 8 }), null);
  const w = api.getWorld();
  const a = w.maps[0].tokens.find((k) => k.id === 'ta');
  assert.equal(w.party.find((p) => p.id === 'a').hp, 0);
  assert.equal(a.down, true);
  assert.equal(a.status, undefined);
});

test('借机攻击把 PC 打到 0：标昏厥，不再挂眩晕', () => {
  opportunityFight({ skills: ['009-9-003'], weakness: { physical: true }, hp: 4, hpMax: 4 });
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 8 }), null);
  const w = api.getWorld();
  const a = w.maps[0].tokens.find((k) => k.id === 'ta');
  assert.equal(w.party.find((p) => p.id === 'a').hp, 0);
  assert.equal(a.down, true);
  assert.equal(a.status, undefined);
  assert.match(api.getUI().trial.msg, /昏厥/);
});

test('借机攻击不把濒死 NPC 改成昏厥', () => {
  opportunityFight({ moverNpc: true, hp: 4, hpMax: 4 });
  api.update((d) => {
    d.maps[0].tokens.find((k) => k.id === 'ta').status = { label: '濒死', roundsLeft: 3 };
  });
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 4 }), null);
  const w = api.getWorld();
  const ta = w.maps[0].tokens.find((k) => k.id === 'ta');
  assert.equal(ta.hp, 0);
  assert.equal(ta.status.label, '濒死');
  assert.equal(ta.down, undefined);
  const ev = w.events.at(-1);
  assert.equal(ev.deltas.some((d) => d.kind === 'status'), false, '濒死不该记成昏厥');
});

test('借机攻击打已昏厥且挂状态的 NPC：清旧状态并记 from→null', () => {
  opportunityFight({ moverNpc: true, hp: 4, hpMax: 4 });
  api.update((d) => {
    const ta = d.maps[0].tokens.find((k) => k.id === 'ta');
    ta.down = true;
    ta.status = { label: '眩晕', skipTurns: 1, blocksAction: true };
  });
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 4 }), null);
  const w = api.getWorld();
  const ta = w.maps[0].tokens.find((k) => k.id === 'ta');
  assert.equal(ta.hp, 0);
  assert.equal(ta.down, true);
  assert.equal(ta.status, undefined);
  const ev = w.events.at(-1);
  assert.ok(ev.deltas.some((d) => d.kind === 'status' && d.from === '眩晕' && d.to === null));
  assert.doesNotMatch(api.getUI().trial.msg, /，昏厥/, '已经昏厥的目标不再重复提示昏厥');
});

test('借机攻击多个敌人：每个敌人一条事件，顺序跟着 enemies', () => {
  opportunityFight({ twoEnemies: true });
  const opp = api.getUI().trial.opportunity;
  assert.deepEqual(opp.enemies, ['tb', 'tc']);
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 4 }), null);
  const w = api.getWorld();
  const evs = w.events.slice(-2);
  assert.deepEqual(evs.map((e) => e.actor.id), ['b', 'c']);
  assert.equal(evs[1].target.id, 'a');
  assert.equal(w.party.find((p) => p.id === 'a').hp, 42);
  assert.match(api.getUI().trial.msg, /敌人二号/);
});

test('借机攻击者是没有角色卡的 NPC：事件 actor 记 npc/token id', () => {
  opportunityFight({ enemyNpc: true });
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 4 }), null);
  const ev = api.getWorld().events.at(-1);
  assert.deepEqual(ev.actor, { kind: 'npc', id: 'tb', name: '敌人' });
  assert.deepEqual(ev.target, { kind: 'pc', id: 'a', name: '走的人' });
  assert.ok(ev.deltas.some((d) => d.kind === 'hp' && d.from === 50 && d.to === 46));
});

test('借机攻击打没填 hpMax 的 NPC：默认 10，伤害照扣', () => {
  opportunityFight({ moverNpc: true });
  api.update((d) => {
    const ta = d.maps[0].tokens.find((k) => k.id === 'ta');
    delete ta.hp;
    delete ta.hpMax;
  });
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 4 }), null);
  const w = api.getWorld();
  const ta = w.maps[0].tokens.find((k) => k.id === 'ta');
  assert.equal(ta.hp, 6);
  assert.equal(ta.hpMax, 10);
  const ev = w.events.at(-1);
  assert.ok(ev.deltas.some((d) => d.kind === 'hp' && d.from === 10 && d.to === 6));
  assert.equal(ev.note, undefined, '有血条就不该写“伤害没落地”');
});

test('借机攻击打 0 HP 的 NPC：仍结算，伤害不落地', () => {
  opportunityFight({ moverNpc: true, hp: 0, hpMax: 10 });
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 4 }), null);
  const w = api.getWorld();
  const ev = w.events.at(-1);
  assert.equal(ev.target.name, '走的人');
  assert.equal(ev.deltas.some((d) => d.kind === 'hp'), false, '0→0 不写 HP delta');
  assert.match(api.getUI().trial.msg, /没有掉血/);
});

test('借机攻击不打 PC 0 HP / 濒死目标', () => {
  // 没有状态、只是 0 HP
  opportunityFight({ hp: 0, hpMax: 4 });
  const before = (api.getWorld().events ?? []).length;
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 4 }), null);
  assert.match(api.getUI().trial.msg, /没有 HP/);
  assert.equal((api.getWorld().events ?? []).length, before, '拒绝的借机攻击不落事件');

  // 已经濒死
  opportunityFight({ hp: 0, hpMax: 4 });
  api.update((d) => {
    d.maps[0].tokens.find((k) => k.id === 'ta').status = { label: '濒死', roundsLeft: 3 };
  });
  const beforeDying = (api.getWorld().events ?? []).length;
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 4 }), null);
  assert.match(api.getUI().trial.msg, /濒死/);
  assert.equal((api.getWorld().events ?? []).length, beforeDying, 'PC 濒死也不结算借机攻击');

  // 已经昏厥但 HP>0：普通攻击和借机都不能打
  opportunityFight({ hp: 4, hpMax: 4 });
  api.update((d) => { d.maps[0].tokens.find((k) => k.id === 'ta').down = true; });
  const beforeDown = (api.getWorld().events ?? []).length;
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 4 }), null);
  assert.match(api.getUI().trial.msg, /昏厥/);
  assert.equal((api.getWorld().events ?? []).length, beforeDown, 'PC 昏厥也不结算借机攻击');

  // 只有 status:'昏厥' 标签、没有 down 字段，也要拦
  opportunityFight({ hp: 4, hpMax: 4 });
  api.update((d) => {
    d.maps[0].tokens.find((k) => k.id === 'ta').status = { label: '昏厥', skipTurns: 1 };
  });
  const beforeLabel = (api.getWorld().events ?? []).length;
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 4 }), null);
  assert.match(api.getUI().trial.msg, /昏厥/);
  assert.equal((api.getWorld().events ?? []).length, beforeLabel, 'PC status 昏厥也不结算');

  // down + 濒死同时存在：和普通攻击/canTarget 一样报濒死
  opportunityFight({ hp: 4, hpMax: 4 });
  api.update((d) => {
    const t = d.maps[0].tokens.find((k) => k.id === 'ta');
    t.down = true; t.status = { label: '濒死', roundsLeft: 3 };
  });
  const beforeBoth = (api.getWorld().events ?? []).length;
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 4 }), null);
  assert.match(api.getUI().trial.msg, /濒死/);
  assert.equal((api.getWorld().events ?? []).length, beforeBoth, 'PC down+濒死也不结算');
});

test('借机攻击目标已经是尸体：不结算、不写事件，收掉机会', () => {
  opportunityFight();
  api.update((d) => { d.maps[0].tokens.find((k) => k.id === 'ta').corpse = true; });
  const before = api.getWorld().events.length;
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 4 }), null);
  assert.equal(api.getUI().trial.opportunity, null);
  assert.match(api.getUI().trial.msg, /尸体/);
  assert.equal(api.getWorld().events.length, before);
  assert.equal(api.getWorld().party.find((p) => p.id === 'a').hp, 50);
});

test('借机攻击命中：落一条事件账本，记 actor/target 和 HP delta', () => {
  opportunityFight();
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 4 }), null);
  const ev = api.getWorld().events.at(-1);
  assert.equal(ev.action.name, '借机攻击');
  assert.deepEqual(ev.actor, { kind: 'pc', id: 'b', name: '敌人' });
  assert.deepEqual(ev.target, { kind: 'pc', id: 'a', name: '走的人' });
  assert.equal(ev.check.band, 'hit');
  assert.equal(ev.note, undefined, 'HP 已由 delta 渲染，note 不重复');
  assert.ok(ev.deltas.some((d) => d.kind === 'hp' && d.from === 50 && d.to === 46));
});

test('借机攻击落空：也记事件，但不写 HP delta', () => {
  opportunityFight();
  assert.equal(api.trialOpportunityAttack({ roll: 3 }), null);
  const w = api.getWorld();
  assert.equal(w.party.find((p) => p.id === 'a').hp, 50);
  const ev = w.events.at(-1);
  assert.equal(ev.action.name, '借机攻击');
  assert.equal(ev.check.band, 'miss');
  assert.equal(ev.deltas.length, 0);
});

test('借机攻击打有血条的 NPC：扣 token HP 并记 HP delta', () => {
  opportunityFight({ moverNpc: true, hp: 10, hpMax: 10 });
  assert.equal(api.trialOpportunityAttack({ roll: 50, roller: () => 4 }), null);
  const w = api.getWorld();
  const ta = w.maps[0].tokens.find((k) => k.id === 'ta');
  assert.equal(ta.hp, 6);
  const ev = w.events.at(-1);
  assert.deepEqual(ev.target, { kind: 'npc', id: 'ta', name: '走的人' });
  assert.ok(ev.deltas.some((d) => d.kind === 'hp' && d.from === 10 && d.to === 6));
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
  // 救治也进事件账本：失败一条、成功一条；成功那条记 HP 和状态变化。
  const events = api.getWorld().events ?? [];
  assert.equal(events.length, 2);
  const fail = events.find((e) => e.check && e.check.success === false);
  const ok = events.find((e) => e.check && e.check.success === true);
  assert.equal(fail.action.name, '救治');
  assert.equal(fail.check.scale, 'd100');
  assert.deepEqual(fail.deltas, []);
  assert.match(fail.note, /没醒过来/);
  assert.equal(ok.target.name, '伤员');
  assert.ok(ok.deltas.some((d) => d.kind === 'hp' && d.from === 0 && d.to === 1));
  assert.ok(ok.deltas.some((d) => d.kind === 'status' && d.from === '濒死' && d.to === null));
  assert.equal(ok.check.outcome, '救回来了');
  assert.doesNotThrow(() => api.checkWorld(api.getWorld()), '救治事件要能过 schema');
});

test('NPC 救治不超过 HP 上限', () => {
  const w = api.emptyWorld();
  const m = api.newMap('救治 NPC', '现实', 1, 10, 10, 'floor', false);
  m.objects = []; m.fog = m.fog.map(() => 1);
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [{ id: 'a', name: '医生', color: '#fff', tags: [], attributes: attrs, skills: ['011-9-102'] }];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '医生', color: '#fff', x: 2, y: 2 },
    { id: 'npc', pcId: null, name: '伤员', color: '#f00', x: 2, y: 3, hp: 20, hpMax: 10, down: true },
  ];
  w.maps = [m]; api.replaceWorld(w); api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '医生' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  assert.equal(api.trialRescue('npc', { roll: 60 }), null);
  const npc = api.getWorld().maps[0].tokens.find((k) => k.id === 'npc');
  assert.equal(npc.hp, 10, '超过上限的 20 先被夹到 10');
  assert.equal(npc.hpMax, 10);
  assert.equal(npc.down, undefined);
  assert.equal(npc.status, undefined);
});

test('救治 hp 高于 1 的 NPC：保留原 HP，不写 HP delta', () => {
  const w = api.emptyWorld();
  const m = api.newMap('救治保持', '现实', 1, 10, 10, 'floor', false);
  m.objects = []; m.fog = m.fog.map(() => 1);
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [{ id: 'a', name: '医生', color: '#fff', tags: [], attributes: attrs, skills: ['011-9-102'] }];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '医生', color: '#fff', x: 2, y: 2 },
    { id: 'npc', pcId: null, name: '伤员', color: '#f00', x: 2, y: 3, hp: 6, hpMax: 10, down: true },
  ];
  w.maps = [m]; api.replaceWorld(w); api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '医生' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  assert.equal(api.trialRescue('npc', { roll: 60 }), null);
  const npc = api.getWorld().maps[0].tokens.find((k) => k.id === 'npc');
  assert.equal(npc.hp, 6, '原本 6 HP 不被拉回 1');
  assert.equal(npc.hpMax, 10);
  assert.equal(npc.down, undefined);
  assert.equal(npc.status, undefined);
  const ev = api.getWorld().events.at(-1);
  assert.equal(ev.deltas.some((d) => d.kind === 'hp'), false, 'HP 没变就不写 HP delta');
  assert.ok(ev.deltas.some((d) => d.kind === 'status' && d.to === null));
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

test('NPC 没填 hpMax：默认 10，攻击按 10 扣', () => {
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
  assert.equal(ev.hpBefore, 10);
  assert.equal(ev.hpAfter, 5);
  assert.equal(ev.hpMax, 10);
  assert.equal(api.findMap(api.getWorld(), m.id).tokens.find(k => k.id === 'npc').hp, 5);
});

test('0 HP 的 NPC 仍可被攻击，但伤害不落地、不显示 −N', () => {
  const w = api.emptyWorld();
  const m = api.newMap('打 0 血 NPC', '现实', 1, 12, 12, 'floor', false);
  m.objects = []; m.fog = m.fog.map(() => 1);
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [{ id: 'a', name: '打手', color: '#fff', tags: [], attributes: attrs }];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '打手', color: '#fff', x: 2, y: 2 },
    { id: 'npc', pcId: null, name: '倒地的路人', color: '#888', x: 2, y: 3, hp: 0, hpMax: 10, down: true },
  ];
  w.maps = [m]; api.replaceWorld(w); api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '打手' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  const target = api.trialAttackTargets().find((x) => x.tokenId === 'npc');
  assert.equal(target.hp, 0);
  assert.equal(target.canHit, true, 'NPC 0 HP 仍可被攻击');
  assert.equal(api.trialAttack('npc', { roll: 50, roller: () => 3 }), null);
  const ev = api.getUI().trial.event;
  assert.equal(ev.hpBefore, 0);
  assert.equal(ev.hpAfter, 0);
  assert.equal(api.damageLanded(ev), false);
  assert.match(ev.note, /数值没有变化/);
});

test('濒死的 NPC 仍可被攻击，但倒计时不重置', () => {
  const w = api.emptyWorld();
  const m = api.newMap('打濒死 NPC', '现实', 1, 12, 12, 'floor', false);
  m.objects = []; m.fog = m.fog.map(() => 1);
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [{ id: 'a', name: '打手', color: '#fff', tags: [], attributes: attrs }];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '打手', color: '#fff', x: 2, y: 2 },
    { id: 'npc', pcId: null, name: '濒死路人', color: '#888', x: 2, y: 3, hp: 0, hpMax: 10, status: { label: '濒死', roundsLeft: 2 } },
  ];
  w.maps = [m]; api.replaceWorld(w); api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '打手' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  const target = api.trialAttackTargets().find((x) => x.tokenId === 'npc');
  assert.equal(target.canHit, true, '濒死 NPC 仍可被攻击');
  assert.equal(api.trialAttack('npc', { roll: 50, roller: () => 3 }), null);
  const w2 = api.getWorld();
  const npc = w2.maps[0].tokens.find((k) => k.id === 'npc');
  assert.equal(npc.hp, 0);
  assert.equal(npc.status.roundsLeft, 2, '倒计时不能被这一下重置');
  assert.match(w2.events.at(-1).note, /倒计时没有重置/);
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
    { id: 'tb', pcId: 'b', name: '伤员', color: '#f00', x: 3, y: 2, down: true, status: api.robotIncoming(now) },
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
  assert.equal(tb.down, undefined, '机器人到场也解除 PC 昏厥');
  assert.equal(api.getWorld().party.find((p) => p.id === 'b').hp, api.RESCUED_HP, '机器人把人拉起来，1 HP');
  assert.match(api.getWorld().log.at(-1).text, /1 HP/);
});

test('急救机器人拉起 NPC：到 1 HP，解除昏厥', () => {
  const now = 1_000_000;
  const w = api.emptyWorld();
  const m = api.newMap('机器人 NPC', '现实', 1, 10, 10, 'floor', false);
  m.objects = []; m.fog = m.fog.map(() => 1);
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [{ id: 'a', name: '队友', color: '#fff', tags: [], attributes: attrs }];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '队友', color: '#fff', x: 2, y: 2 },
    { id: 'npc', pcId: null, name: '路人', color: '#888', x: 3, y: 2, hpMax: 0, down: true, status: api.robotIncoming(now) },
  ];
  w.maps = [m]; api.replaceWorld(w); api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '队友' }], current: 0, combat: false, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.tickRobots(now + api.ROBOT_ETA_MS);
  const npc = api.getWorld().maps[0].tokens.find((k) => k.id === 'npc');
  assert.equal(npc.status, undefined);
  assert.equal(npc.down, undefined, '机器人到场也要解除昏厥');
  assert.equal(npc.hp, api.RESCUED_HP);
  assert.equal(npc.hpMax, 10);
});

test('急救机器人不把已经高于 1 HP 的 NPC 拉回 1', () => {
  const now = 1_000_000;
  const w = api.emptyWorld();
  const m = api.newMap('机器人高血', '现实', 1, 10, 10, 'floor', false);
  m.objects = []; m.fog = m.fog.map(() => 1);
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [{ id: 'a', name: '队友', color: '#fff', tags: [], attributes: attrs }];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '队友', color: '#fff', x: 2, y: 2 },
    { id: 'npc', pcId: null, name: '路人', color: '#888', x: 3, y: 2, hp: 6, hpMax: 10, down: true, status: api.robotIncoming(now) },
  ];
  w.maps = [m]; api.replaceWorld(w); api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '队友' }], current: 0, combat: false, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.tickRobots(now + api.ROBOT_ETA_MS);
  const npc = api.getWorld().maps[0].tokens.find((k) => k.id === 'npc');
  assert.equal(npc.hp, 6, '保留已经更高的 HP');
  assert.equal(npc.down, undefined);
  assert.match(api.getWorld().log.at(-1).text, /6 HP/);
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

test('整轮才结算：只有最后一名玩家结束才扣流血', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('整轮', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [
    { id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs, hp: 10, hpMax: 10 },
    { id: 'b', name: '乙', color: '#f00', tags: [], attributes: attrs, hp: 10, hpMax: 10 },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '乙', color: '#f00', x: 3, y: 2 },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }, { tokenId: 'tb', pcId: 'b', name: '乙' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.update((d) => { d.maps[0].tokens.find((k) => k.id === 'ta').status = { label: '流血', roundsLeft: 2, damageDie: 6, damageTarget: 'hp' }; });
  assert.equal(api.trialStance('趴'), null, '流血不挡行动');

  api.trialEndTurn(() => 3);
  assert.equal(api.getWorld().party.find((p) => p.id === 'a').hp, 10, '第一个人结束不算整轮');
  assert.equal(api.getWorld().maps[0].tokens.find((k) => k.id === 'ta').status.roundsLeft, 2);
  assert.equal(api.getUI().trial.turn, 1);

  api.switchTrialPlayer(1);
  api.trialEndTurn(() => 3);
  assert.equal(api.getWorld().party.find((p) => p.id === 'a').hp, 7, '整轮结束扣 3 点');
  assert.equal(api.getUI().trial.turn, 2);
  assert.equal(api.getWorld().maps[0].tokens.find((k) => k.id === 'ta').status.roundsLeft, 1);

  api.switchTrialPlayer(0);
  api.trialEndTurn(() => 3);
  assert.equal(api.getWorld().party.find((p) => p.id === 'a').hp, 7);
  api.switchTrialPlayer(1);
  api.trialEndTurn(() => 3);
  assert.equal(api.getWorld().party.find((p) => p.id === 'a').hp, 4);
  assert.equal(api.getWorld().maps[0].tokens.find((k) => k.id === 'ta').status, undefined);
});

test('濒死倒计时按整轮：3 整轮才撕卡', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('濒死', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [
    { id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs },
    { id: 'b', name: '乙', color: '#f00', tags: [], attributes: attrs, hp: 0, hpMax: 6 },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '乙', color: '#f00', x: 3, y: 2, status: { label: '濒死', roundsLeft: 3 } },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }, { tokenId: 'tb', pcId: 'b', name: '乙' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  // 每个人结束一次才算一轮；主持人手动切人。
  for (let round = 0; round < 2; round++) {
    api.trialEndTurn(() => 1);
    api.switchTrialPlayer(1);
    api.trialEndTurn(() => 1);
    api.switchTrialPlayer(0);
  }
  api.trialEndTurn(() => 1);
  api.switchTrialPlayer(1);
  assert.equal(api.getWorld().party.find((p) => p.id === 'b').dead, undefined, '两轮半还不能撕卡');
  api.trialEndTurn(() => 1); // 第三整轮结束
  const w2 = api.getWorld();
  assert.equal(w2.party.find((p) => p.id === 'b').dead, true);
  assert.equal(w2.maps[0].tokens.find((k) => k.id === 'tb').corpse, true);
  assert.match(w2.log.at(-1).text, /濒死三回合无人救治/);
});

test('流血把 HP 扣到 0：进濒死，不是直接昏厥', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('流血', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs, hp: 2, hpMax: 10 }];
  m.tokens = [{ id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2, status: { label: '流血', roundsLeft: 1, damageDie: 6, damageTarget: 'hp' } }];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialEndTurn(() => 3);
  const w2 = api.getWorld();
  assert.equal(w2.party.find((p) => p.id === 'a').hp, 0);
  const st = w2.maps[0].tokens.find((k) => k.id === 'ta').status;
  assert.equal(st.label, '濒死');
  assert.equal(st.roundsLeft, 3);
  assert.equal(w2.party.find((p) => p.id === 'a').dead, undefined);
});

test('眩晕：跳过下个自己的回合，然后解除', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('眩晕', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [
    { id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs },
    { id: 'b', name: '乙', color: '#f00', tags: [], attributes: attrs },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '乙', color: '#f00', x: 3, y: 2, status: { label: '眩晕', roundsLeft: 1, skipTurns: 1 } },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }, { tokenId: 'tb', pcId: 'b', name: '乙' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialEndTurn(() => 1); // 甲结束
  api.switchTrialPlayer(1); // 轮到乙，眩晕跳过
  assert.equal(api.getUI().trial.current, 1);
  assert.match(api.getUI().trial.msg, /乙 眩晕，跳过这个回合/);
  assert.equal(api.actionsLeft(api.getUI().trial), 0);
  assert.match(api.trialStance('趴') ?? '', /眩晕中，暂时不能行动/);
  api.setUI({ trial: { ...api.getUI().trial, acted: {} } });
  assert.match(api.trialAttack('ta') ?? '', /眩晕中，暂时不能行动/);
  api.trialEndTurn(() => 1); // 乙结束，整轮结算但眩晕已用掉
  assert.equal(api.getWorld().maps[0].tokens.find((k) => k.id === 'tb').status, undefined);
  api.switchTrialPlayer(0);
  assert.equal(api.getUI().trial.current, 0);
});

test('单人眩晕：结束自己的回合就能解除，不会死锁', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('单人眩晕', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs }];
  m.tokens = [{ id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2 }];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.setTrialStatus('眩晕', 5); // 自定义输入也带默认 skipTurns/blocksAction
  const set = api.getWorld().maps[0].tokens.find((k) => k.id === 'ta').status;
  assert.equal(set.skipTurns, 1);
  assert.equal(set.blocksAction, true);
  api.switchTrialPlayer(0); // 点同一个人不消耗跳过次数
  assert.equal(api.getWorld().maps[0].tokens.find((k) => k.id === 'ta').status.skipTurns, 1);
  api.trialEndTurn(() => 1);
  assert.equal(api.getWorld().maps[0].tokens.find((k) => k.id === 'ta').status, undefined, '空格结束就解除');
  assert.equal(api.getUI().trial.turn, 2);
  assert.equal(api.actionsLeft(api.getUI().trial), 1);
});

test('眩晕的跳过次数不跟整轮倒计时一起减', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('眩晕计时', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [
    { id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs },
    { id: 'b', name: '乙', color: '#f00', tags: [], attributes: attrs },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '乙', color: '#f00', x: 3, y: 2, status: { label: '眩晕', roundsLeft: 2, skipTurns: 2, blocksAction: true } },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }, { tokenId: 'tb', pcId: 'b', name: '乙' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialEndTurn(() => 1); // 甲结束
  api.switchTrialPlayer(1); // 乙的回合被跳过，skip 2 -> 1
  assert.match(api.getUI().trial.msg, /乙 眩晕，跳过这个回合/);
  api.trialEndTurn(() => 1); // 乙结束，整轮结算
  const st = api.getWorld().maps[0].tokens.find((k) => k.id === 'tb').status;
  assert.equal(st.skipTurns, 1, 'switch 已经减过一次，整轮不该再减');
  assert.equal(st.roundsLeft, 2, '整轮结算不该动眩晕的 roundsLeft');
});

test('结束一个人的回合不替别人清行动点和蓄力', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('资源', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [
    { id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs },
    { id: 'b', name: '乙', color: '#f00', tags: [], attributes: attrs },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '乙', color: '#f00', x: 3, y: 2 },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }, { tokenId: 'tb', pcId: 'b', name: '乙' }], current: 0, combat: true, moved: {}, acted: { tb: true }, charge: { tb: { progress: 0, cells: 0 } }, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialEndTurn(() => 1);
  assert.equal(api.getUI().trial.acted.tb, true, '乙的行动点不能被甲的结束清掉');
  assert.equal(api.getUI().trial.charge.tb.progress, 0, '蓄力只在整轮边界涨');
  assert.equal(api.getUI().trial.turn, 1);
  api.switchTrialPlayer(1);
  assert.equal(api.actionsLeft(api.getUI().trial), 0, '乙这回合仍然没有行动点');
  api.trialEndTurn(() => 1); // 乙结束，整轮结束才清
  assert.equal(api.getUI().trial.acted.tb, undefined);
});

test('NPC 濒死到点变尸体；NPC 流血归零进濒死并写日志', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('NPC倒地', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs }];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2 },
    { id: 'npc1', pcId: null, name: '大机器人', color: '#f00', x: 4, y: 2, hp: 0, hpMax: 80, status: { label: '濒死', roundsLeft: 1 } },
    { id: 'npc2', pcId: null, name: '小机器人', color: '#0f0', x: 5, y: 2, hp: 2, hpMax: 5, status: { label: '流血', roundsLeft: 1, damageDie: 6, damageTarget: 'hp' } },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialEndTurn(() => 3);
  const w2 = api.getWorld();
  const t1 = w2.maps[0].tokens.find((k) => k.id === 'npc1');
  const t2 = w2.maps[0].tokens.find((k) => k.id === 'npc2');
  assert.equal(t1.corpse, true, 'NPC 濒死到点不能站着');
  assert.equal(t1.status, undefined);
  assert.equal(t2.hp, 0);
  assert.equal(t2.status.label, '濒死');
  assert.match(w2.log.map((x) => x.text).join('\n'), /大机器人 濒死到点，尸体留在原地/);
  assert.match(w2.log.map((x) => x.text).join('\n'), /小机器人 流血倒下，进入濒死/);
});

test('perRound 固定伤害也能走整轮结算', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('固定伤害', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs, hp: 10, hpMax: 10 }];
  m.tokens = [{ id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2, status: { label: '中毒', roundsLeft: 1, perRound: 2, damageTarget: 'hp', blocksAction: false } }];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialEndTurn(() => 1);
  assert.equal(api.getWorld().party.find((p) => p.id === 'a').hp, 8);
  assert.equal(api.getWorld().maps[0].tokens.find((k) => k.id === 'ta').status, undefined);
});

test('NPC 中毒按默认 10 扣；上限硬夹', () => {
  const w = api.emptyWorld();
  const m = api.newMap('NPC 中毒', '现实', 1, 12, 12, 'floor', false);
  m.objects = []; m.fog = m.fog.map(() => 1);
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs, hp: 10, hpMax: 10 }];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2 },
    { id: 'npc', pcId: null, name: 'NPC', color: '#888', x: 3, y: 2, status: { label: '中毒', roundsLeft: 1, perRound: 2, damageTarget: 'hp', blocksAction: false } },
  ];
  w.maps = [m]; api.replaceWorld(w); api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialEndTurn(() => 1);
  const w2 = api.getWorld();
  const npc = w2.maps[0].tokens.find((k) => k.id === 'npc');
  assert.equal(npc.hp, 8);
  assert.equal(npc.hpMax, 10);
});

test('眩晕挡住救治/感知/跑法，不只挡攻击和移动', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('眩晕挡动作', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [
    { id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs },
    { id: 'b', name: '乙', color: '#f00', tags: [], attributes: attrs, hp: 0, hpMax: 6 },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2, status: { label: '眩晕', roundsLeft: 1, skipTurns: 0, blocksAction: true } },
    { id: 'tb', pcId: 'b', name: '乙', color: '#f00', x: 3, y: 2, status: { label: '濒死', roundsLeft: 3 } },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  assert.match(api.trialRescue('tb', { roll: 30 }) ?? '', /眩晕中，暂时不能行动/);
  assert.match(api.trialSense('观察') ?? '', /眩晕中，暂时不能行动/);
  assert.equal(api.trialRun(null), null, '取消跑法不挡');
  assert.match(api.trialRun('jog') ?? '', /眩晕中，暂时不能行动/);
});

test('中毒按 ME 结算，整轮扣一次', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('中毒', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs, me: 5, meMax: 10, hp: 10, hpMax: 10 }];
  m.tokens = [{ id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2, status: { label: '中毒', roundsLeft: 1, damageDie: 6, damageTarget: 'me' } }];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialEndTurn(() => 3);
  const w2 = api.getWorld();
  assert.equal(w2.party.find((p) => p.id === 'a').me, 2);
  assert.equal(w2.party.find((p) => p.id === 'a').hp, 10);
  assert.equal(w2.maps[0].tokens.find((k) => k.id === 'ta').status, undefined);
});

test('中毒把 ME 扣到 0：挂被驱逐，不能行动，整轮不再倒计时', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('中毒归零', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs, me: 3, meMax: 10, hp: 10, hpMax: 10 }];
  m.tokens = [{ id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2, status: { label: '中毒', roundsLeft: 1, damageDie: 6, damageTarget: 'me' } }];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialEndTurn(() => 5);
  const w2 = api.getWorld();
  assert.equal(w2.party.find((p) => p.id === 'a').me, 0);
  const st = w2.maps[0].tokens.find((k) => k.id === 'ta').status;
  assert.equal(st.label, '被驱逐');
  assert.equal(st.blocksAction, true);
  assert.equal(st.endsWhenMePositive, true);
  assert.equal(st.roundsLeft, undefined, '不跟整轮倒计时');
  assert.match(api.trialStance('趴') ?? '', /被驱逐中，暂时不能行动/);
  assert.ok(w2.log.some((x) => /ME 归零，被驱逐/.test(x.text)));
  api.trialEndTurn(() => 5);
  assert.equal(api.getWorld().maps[0].tokens.find((k) => k.id === 'ta').status.label, '被驱逐', '第二整轮也不自动掉');
});

test('ME 恢复到 1：被驱逐自动解除', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('解除驱逐', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs, me: 2, meMax: 10, hp: 10, hpMax: 10 }];
  m.tokens = [{ id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2, status: { label: '中毒', roundsLeft: 1, damageDie: 6, damageTarget: 'me' } }];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialEndTurn(() => 5);
  assert.equal(api.getWorld().maps[0].tokens.find((k) => k.id === 'ta').status.label, '被驱逐');
  api.update((d) => { d.party.find((p) => p.id === 'a').me = 1; });
  const w2 = api.getWorld();
  assert.equal(w2.maps[0].tokens.find((k) => k.id === 'ta').status, undefined);
  assert.match(w2.log.at(-1).text, /ME 恢复到 1，解除被驱逐/);
});

test('PC 没填 ME：中毒 ME 伤害不落地，也不挂被驱逐', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('没填ME', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs, hp: 10, hpMax: 10 }];
  m.tokens = [{ id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2, status: { label: '中毒', roundsLeft: 1, damageDie: 6, damageTarget: 'me' } }];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialEndTurn(() => 5);
  const w2 = api.getWorld();
  assert.equal(w2.party.find((p) => p.id === 'a').me, undefined, '不要凭空写 0');
  assert.equal(w2.maps[0].tokens.find((k) => k.id === 'ta').status, undefined, '中毒一回合到期，也不该换成被驱逐');
  assert.ok(w2.log.some((x) => /没填 ME/.test(x.text)));
});

test('0 个玩家时空格不结算；尸体/昏厥自动算已结束', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('边界', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [
    { id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs },
    { id: 'b', name: '乙', color: '#f00', tags: [], attributes: attrs },
    { id: 'c', name: '丙', color: '#0f0', tags: [], attributes: attrs },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '乙', color: '#f00', x: 3, y: 2, down: true },
    { id: 'tc', pcId: 'c', name: '丙', color: '#0f0', x: 4, y: 2, corpse: true },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialEndTurn(() => 1);
  assert.equal(api.getUI().trial.turn, 1, '没有玩家不该推进回合');

  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }, { tokenId: 'tb', pcId: 'b', name: '乙' }, { tokenId: 'tc', pcId: 'c', name: '丙' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialEndTurn(() => 1);
  assert.equal(api.getUI().trial.turn, 2, '昏厥/尸体都自动算结束，不用切过去按空格');
});

test('结束回合后不能再动，重复空格不重复结算', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('回合锁', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [
    { id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs, hp: 10, hpMax: 10 },
    { id: 'b', name: '乙', color: '#f00', tags: [], attributes: attrs },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2, status: { label: '流血', roundsLeft: 2, damageDie: 6, damageTarget: 'hp' } },
    { id: 'tb', pcId: 'b', name: '乙', color: '#f00', x: 3, y: 2 },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }, { tokenId: 'tb', pcId: 'b', name: '乙' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialEndTurn(() => 3);
  assert.equal(api.getUI().trial.ended.ta, true);
  assert.equal(api.getUI().trial.turn, 1);
  assert.equal(api.actionsLeft(api.getUI().trial), 0);
  assert.match(api.trialStance('趴') ?? '', /这个回合已经结束了/);
  assert.match(api.trialAttack('tb') ?? '', /行动点|这个回合已经结束/, '不能再打');
  api.trialEndTurn(() => 3); // 重复按空格：不能重复结算
  assert.equal(api.getUI().trial.turn, 1);
  assert.equal(api.getWorld().party.find((p) => p.id === 'a').hp, 10);
  api.switchTrialPlayer(1);
  api.trialEndTurn(() => 3);
  assert.equal(api.getUI().trial.turn, 2);
  assert.equal(api.getWorld().party.find((p) => p.id === 'a').hp, 7);
  api.switchTrialPlayer(0);
  assert.equal(api.actionsLeft(api.getUI().trial), 1);
});

test('同轮救起的昏厥者还能拿到自己的回合', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('救起', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [
    { id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs },
    { id: 'b', name: '乙', color: '#f00', tags: [], attributes: attrs },
    { id: 'c', name: '丙', color: '#0f0', tags: [], attributes: attrs },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '乙', color: '#f00', x: 3, y: 2, down: true },
    { id: 'tc', pcId: 'c', name: '丙', color: '#0f0', x: 4, y: 2 },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }, { tokenId: 'tb', pcId: 'b', name: '乙' }, { tokenId: 'tc', pcId: 'c', name: '丙' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialEndTurn(() => 1); // 甲结束，乙昏厥自动算不行动
  api.switchTrialPlayer(2); // 丙
  api.update((d) => { delete d.maps[0].tokens.find((k) => k.id === 'tb').down; }); // 丙把乙救起来（只测 ended 不粘）
  api.trialEndTurn(() => 1); // 丙结束
  assert.equal(api.getUI().trial.turn, 1, '乙被救起后这轮还没结束，不能直接结算');
  api.switchTrialPlayer(1);
  assert.equal(api.actionsLeft(api.getUI().trial), 1, '乙还能行动');
});

test('整轮账本已经齐了再按空格不会重复结算', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('重复结算', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [
    { id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs, hp: 10, hpMax: 10 },
    { id: 'b', name: '乙', color: '#f00', tags: [], attributes: attrs },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2, status: { label: '流血', roundsLeft: 2, damageDie: 6, damageTarget: 'hp' } },
    { id: 'tb', pcId: 'b', name: '乙', color: '#f00', x: 3, y: 2 },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }, { tokenId: 'tb', pcId: 'b', name: '乙' }], current: 0, combat: true, moved: {}, ended: { ta: true, tb: true }, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialEndTurn(() => 3);
  assert.equal(api.getUI().trial.turn, 1);
  assert.equal(api.getWorld().party.find((p) => p.id === 'a').hp, 10);
});

test('昏厥/尸体挡住姿态、感知、跑法、救治', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('倒地动作', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs, skills: ['001-9-119'] }];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2, down: true },
    { id: 'tb', pcId: null, name: '乙', color: '#f00', x: 3, y: 2, status: { label: '濒死', roundsLeft: 3 } },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  assert.match(api.trialStance('趴') ?? '', /昏厥/);
  assert.match(api.trialSense('观察') ?? '', /昏厥/);
  assert.match(api.trialRun('jog') ?? '', /昏厥/);
  assert.match(api.trialRescue('tb', { roll: 30 }) ?? '', /昏厥/);

  api.update((d) => { const k = d.maps[0].tokens.find((x) => x.id === 'ta'); delete k.down; k.corpse = true; });
  assert.match(api.trialStance('趴') ?? '', /已经死了/);
  assert.match(api.trialSense('观察') ?? '', /已经死了/);
  assert.match(api.trialRun('jog') ?? '', /已经死了/);
  assert.match(api.trialRescue('tb', { roll: 30 }) ?? '', /已经死了/);
});

test('结束回合后姿态/攻击/感知/跑法/救治/移动都拒绝', () => {
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  const w = api.emptyWorld();
  const m = api.newMap('结束动作', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [
    { id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs, skills: ['001-9-119'] },
    { id: 'b', name: '乙', color: '#f00', tags: [], attributes: attrs },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '乙', color: '#f00', x: 3, y: 2 },
    { id: 'tc', pcId: null, name: '丙', color: '#0f0', x: 4, y: 2, status: { label: '濒死', roundsLeft: 3 } },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }, { tokenId: 'tb', pcId: 'b', name: '乙' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.trialEndTurn(() => 1);
  assert.match(api.trialStance('趴') ?? '', /这个回合已经结束了/);
  assert.match(api.trialAttack('tb') ?? '', /这个回合已经结束了/);
  assert.match(api.trialSense('观察') ?? '', /这个回合已经结束了/);
  assert.match(api.trialRun('jog') ?? '', /这个回合已经结束了/);
  assert.match(api.trialRescue('tc', { roll: 30 }) ?? '', /这个回合已经结束了/);
  const before = api.getWorld().maps[0].tokens.find((k) => k.id === 'ta');
  api.trialMove(0, -1);
  const after = api.getWorld().maps[0].tokens.find((k) => k.id === 'ta');
  assert.deepEqual([after.x, after.y], [before.x, before.y]);
  assert.match(api.getUI().trial.msg, /这个回合已经结束了/);
});
