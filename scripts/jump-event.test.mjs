import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(root, '.jump-event-test-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/rules/jump'; export * from './src/rules/interaction'; export * from './src/rules/judgments'; export * from './src/core/defaults'; export * from './src/core/schema.js'; export * from './src/runtime/sync'; export * from './src/runtime/trial'; export * from './src/core/store'; export * from './src/runtime/actions'; export * from './src/scene/architecture'; export * from './src/scene/sight';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.location = { search: '', origin: 'http://localhost' };
const windows = [];
globalThis.window = { setTimeout: () => 0, open: () => { const win = { closed: false, got: [], postMessage(m) { win.got.push(m); } }; windows.push(win); return win; } };
globalThis.BroadcastChannel = class { postMessage() {} };
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
const api = createRequire(import.meta.url)(bundle);
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

const ATTRS = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };

function setup({ hp, hpMax, window = true, combat = true } = {}) {
  const w = api.emptyWorld();
  const m = api.newMap('跳跃测试', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  m.fog = m.fog.map(() => 1);
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: { ...ATTRS }, skills: [], ...(hp !== undefined ? { hp, hpMax } : {}) }];
  m.tokens = [{ id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2 }];
  w.maps = [m];
  api.replaceWorld(w);
  api.setUI({ mapId: m.id });
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0, combat,
    moved: {}, turned: {}, acted: {}, turn: 1, movePoints: {}, charge: {}, msg: '', markSymbol: '!', markText: '', markMode: false } });
  // 让这个角色有试玩窗口，两阶段才走玩家窗口那条路；测试里 window.open 是假的。
  if (window) api.openPlayerWindow('a', true);
  return { w: api.getWorld(), m: api.getWorld().maps[0] };
}

const jumpDown = (extra = {}) => ({
  tokenId: 'ta', dx: 0, dy: 1, kind: 'down', cells: 6, fall: 6,
  attr: null, landing: { x: 2, y: 3 }, injury: 'heavy', moveMultiplier: 1, forcedFall: true, ...extra,
});

test('必摔：摔伤骰 12 超过 10，HP 归零 → 濒死，账本一条总事件', () => {
  setup();
  assert.equal(api.settleJump(jumpDown(), [], { injuryRoll: 12, injuryBy: 'player' }), '');
  const w = api.getWorld();
  const tok = w.maps[0].tokens[0];
  assert.deepEqual({ x: tok.x, y: tok.y }, { x: 2, y: 3 });
  assert.equal(w.party[0].hp, 0);
  assert.equal(tok.status.label, '濒死');
  assert.equal(tok.status.roundsLeft, 3);
  assert.equal(w.events.length, 1);
  const ev = w.events[0];
  assert.equal(ev.action.name, '往下跳 6 格');
  assert.equal(ev.check, undefined);
  assert.deepEqual(ev.damage, { kind: 'fall', sides: 12, roll: 12, by: 'player', tier: 'heavy' });
  assert.ok(ev.deltas.some((d) => d.kind === 'hp' && d.from === 6 && d.to === 0));
  assert.ok(ev.deltas.some((d) => d.kind === 'status' && d.to === '濒死'));
  const moved = ev.deltas.find((d) => d.kind === 'moved');
  assert.deepEqual({ from: moved.from, to: moved.to }, { from: { x: 2, y: 2 }, to: { x: 2, y: 3 } });
  assert.match(ev.note, /超过 10/);
  assert.match(w.log.at(-1).text, /濒死/);
  assert.match(w.log.at(-1).text, /失败/);
  assert.doesNotThrow(() => api.checkWorld(w), '账本要能过 schema');
});

test('摔伤超过 10 但 HP 还剩：不进濒死，只扣血', () => {
  setup({ hp: 20, hpMax: 20 });
  api.settleJump(jumpDown(), [], { injuryRoll: 12, injuryBy: 'player' });
  const w = api.getWorld();
  assert.equal(w.party[0].hp, 8);
  const tok = w.maps[0].tokens[0];
  assert.equal(tok.status, undefined);
  assert.equal(tok.down, undefined);
  assert.equal(w.events[0].damage.roll, 12);
  assert.match(w.events[0].note, /没进濒死/);
});

test('摔伤不超过 10 且 HP 归零：按钝器口径昏厥', () => {
  setup();
  api.settleJump(jumpDown({ injury: 'medium' }), [], { injuryRoll: 8, injuryBy: 'player' });
  const w = api.getWorld();
  assert.equal(w.party[0].hp, 0);
  const tok = w.maps[0].tokens[0];
  assert.equal(tok.down, true);
  assert.equal(tok.status, undefined);
  assert.ok(w.events[0].deltas.some((d) => d.kind === 'status' && d.to === '昏厥'));
});

test('两颗骰一颗一颗走：属性骰失败后开摔伤骰，最后一条事件', () => {
  setup();
  const err = api.openJudgment({
    title: '跳跃：往下 6 格', ruling: '没过就摔。', sides: 20, subjectId: 'a',
    place: { mapId: api.getWorld().maps[0].id, x: 2.5, y: 2.5 },
    jump: { tokenId: 'ta', dx: 0, dy: 1, kind: 'down', cells: 6, fall: 6, attr: '敏捷', dice: 'single', landing: { x: 2, y: 3 }, injury: 'heavy', moveMultiplier: 1 },
  });
  assert.equal(err, null);
  // 敏捷 30 → 区值 6，DC 20；掷 5 失败。
  assert.equal(api.settlePendingJudgment({ rollId: 'r1', sides: 20, value: 5, values: [5], tens: null, units: null, material: 'wood', seed: 1 }, false), null);
  assert.equal((api.getWorld().events ?? []).length, 0, '第一颗骰不落总事件');
  assert.equal((api.getWorld().judgments ?? []).length, 1, '第一颗骰单独广播');
  const fall = api.getUI().pendingJudgment;
  assert.ok(fall && fall.fall, '应该开第二棒摔伤骰');
  assert.equal(fall.sides, 12);
  assert.match(fall.title, /摔伤骰/);
  assert.equal(api.findMap(api.getWorld(), api.getWorld().maps[0].id).tokens[0].y, 2, '结算前不挪棋子');

  assert.equal(api.settlePendingJudgment({ rollId: 'r2', sides: 12, value: 12, values: [12], tens: null, units: null, material: 'wood', seed: 2 }, false), null);
  assert.equal(api.getUI().pendingJudgment, null);
  const w = api.getWorld();
  assert.equal(w.judgments.length, 2, '两颗骰各自广播');
  assert.equal(w.events.length, 1, '最后合成一条总事件');
  const ev = w.events[0];
  assert.equal(ev.check.success, false);
  assert.deepEqual(ev.damage, { kind: 'fall', sides: 12, roll: 12, by: 'player', tier: 'heavy' });
  assert.ok(ev.deltas.some((d) => d.kind === 'hp' && d.to === 0));
  assert.ok(ev.deltas.some((d) => d.kind === 'status' && d.to === '濒死'));
  assert.ok(ev.deltas.some((d) => d.kind === 'moved'));
  assert.equal(w.log.at(-1).eventId, ev.id, '总事件是最后一条日志，两颗骰都在它前面');
  assert.doesNotThrow(() => api.checkWorld(w));
});

test('已濒死再摔：不重置倒计时，note 不写成昏厥', () => {
  setup({ hp: 0, hpMax: 6 });
  api.update((d) => {
    const t = d.maps[0].tokens[0];
    t.status = { label: '濒死', roundsLeft: 1 };
  });
  assert.equal(api.settleJump(jumpDown({ injury: 'medium' }), [], { injuryRoll: 8, injuryBy: 'player' }), '');
  const w = api.getWorld();
  const tok = w.maps[0].tokens[0];
  assert.equal(tok.status.label, '濒死');
  assert.equal(tok.status.roundsLeft, 1, '不该重置成 3');
  assert.ok(!w.events[0].deltas.some((d) => d.kind === 'status'), '状态没变就不写 delta');
  assert.match(w.events[0].note, /本来就已经是濒死/);
});

test('非战斗高摔：账本挂急救机器人，不写假的“→濒死”', () => {
  setup({ hp: 0, hpMax: 6, combat: false });
  api.update((d) => {
    const t = d.maps[0].tokens[0];
    t.hp = 0;
    t.status = { label: '急救机器人正在赶来', endsAt: Date.now() + 60000 };
  });
  assert.equal(api.settleJump(jumpDown({ injury: 'heavy' }), [], { injuryRoll: 12, injuryBy: 'player' }), '');
  const ev = api.getWorld().events[0];
  const tok = api.getWorld().maps[0].tokens[0];
  assert.equal(tok.status.label, '急救机器人正在赶来');
  assert.ok(!ev.deltas.some((d) => d.kind === 'status'), '状态实际没变，不许写 delta');
  assert.match(ev.note, /状态已经是「急救机器人正在赶来」/);
  assert.doesNotMatch(ev.note, /→ 濒死/);
});

test('非战斗高摔且原无状态：账本挂急救机器人，不是“濒死”', () => {
  setup({ hp: 0, hpMax: 6, combat: false });
  assert.equal(api.settleJump(jumpDown({ injury: 'heavy' }), [], { injuryRoll: 12, injuryBy: 'player' }), '');
  const ev = api.getWorld().events[0];
  const tok = api.getWorld().maps[0].tokens[0];
  assert.equal(tok.status.label, '急救机器人正在赶来');
  const status = ev.deltas.find((d) => d.kind === 'status');
  assert.equal(status.from, null);
  assert.equal(status.to, '急救机器人正在赶来');
  assert.match(ev.note, /→ 急救机器人正在赶来/);
});

test('已昏厥再摔：状态不变，note 不写“实扣 0”', () => {
  setup({ hp: 0, hpMax: 6 });
  api.update((d) => {
    const t = d.maps[0].tokens[0];
    t.down = true;
    t.hp = 0;
  });
  assert.equal(api.settleJump(jumpDown({ injury: 'medium' }), [], { injuryRoll: 8, injuryBy: 'player' }), '');
  const ev = api.getWorld().events[0];
  assert.ok(!ev.deltas.some((d) => d.kind === 'status'), '状态没变就不写 delta');
  assert.match(ev.note, /本来就已经是昏厥/);
  assert.doesNotMatch(ev.note, /实扣 0/);
});

test('没有试玩窗口：第一颗失败后由见证者现掷摔伤骰，仍有一条总事件', () => {
  setup({ window: false });
  api.openJudgment({
    title: '跳跃：往下 6 格', ruling: '', sides: 20, subjectId: 'a',
    jump: { tokenId: 'ta', dx: 0, dy: 1, kind: 'down', cells: 6, fall: 6, attr: '敏捷', dice: 'single', landing: { x: 2, y: 3 }, injury: 'heavy', moveMultiplier: 1 },
  });
  assert.equal(api.settlePendingJudgment({ rollId: 'nw1', sides: 20, value: 5, values: [5], tens: null, units: null, material: 'wood', seed: 3 }, false), null);
  const w = api.getWorld();
  assert.equal(api.getUI().pendingJudgment, null);
  assert.equal((w.events ?? []).length, 1);
  assert.equal(w.events[0].damage.by, 'witness');
  assert.ok(w.events[0].damage.roll >= 1);
});

test('第一颗广播前先查棋子：删了棋子就不广播、不落账、也不留死 pending', () => {
  setup();
  api.openJudgment({
    title: '跳跃：往下 6 格', ruling: '', sides: 20, subjectId: 'a',
    jump: { tokenId: 'ta', dx: 0, dy: 1, kind: 'down', cells: 6, fall: 6, attr: '敏捷', dice: 'single', landing: { x: 2, y: 3 }, injury: 'heavy', moveMultiplier: 1 },
  });
  api.update((d) => { d.maps[0].tokens = []; });
  const err = api.settlePendingJudgment({ rollId: 'dead1', sides: 20, value: 5, values: [5], tens: null, units: null, material: 'wood', seed: 4 }, false);
  assert.match(err ?? '', /找不到跳跃对象/);
  assert.equal(api.getUI().pendingJudgment, null);
  assert.equal((api.getWorld().judgments ?? []).length, 0, '一个骰子都不许广播');
  assert.equal((api.getWorld().events ?? []).length, 0);
});

test('第二颗广播前先查棋子：删了棋子就不发第二颗、不留 pending', () => {
  setup();
  api.openJudgment({
    title: '跳跃：往下 6 格', ruling: '', sides: 20, subjectId: 'a',
    jump: { tokenId: 'ta', dx: 0, dy: 1, kind: 'down', cells: 6, fall: 6, attr: '敏捷', dice: 'single', landing: { x: 2, y: 3 }, injury: 'heavy', moveMultiplier: 1 },
  });
  assert.equal(api.settlePendingJudgment({ rollId: 'dg1', sides: 20, value: 5, values: [5], tens: null, units: null, material: 'wood', seed: 5 }, false), null);
  assert.ok(api.getUI().pendingJudgment?.fall);
  api.update((d) => { d.maps[0].tokens = []; });
  const err = api.settlePendingJudgment({ rollId: 'dg2', sides: 12, value: 12, values: [12], tens: null, units: null, material: 'wood', seed: 6 }, false);
  assert.match(err ?? '', /找不到棋子/);
  assert.equal(api.getUI().pendingJudgment, null);
  assert.equal((api.getWorld().judgments ?? []).length, 1, '第二颗不许广播');
  assert.equal((api.getWorld().events ?? []).length, 0);
});

test('见证者代掷劣势跳：两颗一起结算，取低', () => {
  setup();
  api.openJudgment({
    title: '跳跃：劣势代掷', ruling: '', sides: 20, subjectId: 'a',
    jump: { tokenId: 'ta', dx: 0, dy: 1, kind: 'down', cells: 4, fall: 4, attr: '敏捷', dice: 'disadvantage', landing: { x: 2, y: 3 }, injury: 'medium', moveMultiplier: 1 },
  });
  assert.equal(api.settlePendingJudgment({ rollId: 'so1', sides: 20, value: 5, values: [20, 5], tens: null, units: null, material: 'wood', seed: 8 }, true), null);
  const w = api.getWorld();
  assert.equal((w.events ?? []).length, 1);
  assert.equal(w.events[0].damage.by, 'witness');
  assert.equal(w.events[0].check.attrs[0].used, 5, '劣势取低');
  assert.deepEqual(w.judgments[0].roll.values, [20, 5], '两颗都要留');
  assert.equal(w.judgments[0].roll.persona, 'witness');
});

test('玩家骰型只看公开字段，不靠被剥掉的 jump', () => {
  assert.equal(api.playerDiceMode({}), 'single');
  assert.equal(api.playerDiceMode({ dice: 'disadvantage' }), 'disadvantage');
  assert.equal(api.playerDiceMode({ jump: { dice: 'advantage' } }), 'advantage');
  assert.equal(api.playerDiceMode({ check: { attrs: [{ attr: '敏捷', dice: 'single' }], dc: 20, merge: 'single' }, dice: 'advantage' }), 'single');
});

test('优/劣势跳跃：玩家收到 dice，正式判定留两颗', () => {
  setup();
  windows.forEach((w) => { w.got.length = 0; });
  api.openJudgment({
    title: '跳跃：劣势', ruling: '', sides: 20, subjectId: 'a',
    jump: { tokenId: 'ta', dx: 0, dy: 1, kind: 'down', cells: 4, fall: 4, attr: '敏捷', dice: 'disadvantage', landing: { x: 2, y: 3 }, injury: 'medium', moveMultiplier: 1 },
  });
  api.pushJudgmentRequest('a');
  const req = windows.flatMap((w) => w.got).filter((m) => m.type === 'judge-request').at(-1);
  assert.ok(req, '应该有 judge-request');
  assert.equal(req.judgment.dice, 'disadvantage');
  assert.equal(req.judgment.jump, undefined, '不许把落点给玩家');
  assert.equal(api.settlePendingJudgment({ rollId: 'adv1', sides: 20, value: 5, values: [20, 5], tens: null, units: null, material: 'wood', seed: 7 }, false), null);
  const j = api.getWorld().judgments[0];
  assert.deepEqual(j.roll.values, [20, 5], '两次骰都要留');
  assert.deepEqual(j.roll.attrs, ['敏捷', '敏捷']);
  assert.equal(api.getUI().pendingJudgment?.fall?.check.used, 5, '劣势取低');
});

test('跳跃成功：账本记属性骰和移动，不记摔伤', () => {
  setup();
  const req = { tokenId: 'ta', dx: 1, dy: 0, kind: 'across', cells: 2, fall: 1, attr: '敏捷', dice: 'single', landing: { x: 4, y: 2 }, injury: 'light', moveMultiplier: 1 };
  assert.equal(api.settleJump(req, [20], { checkBy: 'player' }), '');
  const w = api.getWorld();
  const tok = w.maps[0].tokens[0];
  assert.deepEqual({ x: tok.x, y: tok.y }, { x: 4, y: 2 });
  assert.equal(w.events.length, 1);
  const ev = w.events[0];
  assert.equal(ev.check.success, true);
  assert.equal(ev.check.tier, 'crit');
  assert.equal(ev.damage, undefined);
  const moved = ev.deltas.find((d) => d.kind === 'moved');
  assert.deepEqual({ from: moved.from, to: moved.to }, { from: { x: 2, y: 2 }, to: { x: 4, y: 2 } });
});
