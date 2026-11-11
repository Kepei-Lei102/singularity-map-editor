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
  stdin: { contents: `export * from './src/rules/jump'; export * from './src/rules/interaction'; export * from './src/rules/judgments'; export * from './src/core/defaults'; export * from './src/core/schema.js'; export * from './src/runtime/trial'; export * from './src/core/store'; export * from './src/runtime/actions'; export * from './src/scene/architecture'; export * from './src/scene/sight';`, resolveDir: root },
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

function setup({ hp, hpMax } = {}) {
  const w = api.emptyWorld();
  const m = api.newMap('跳跃测试', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  m.fog = m.fog.map(() => 1);
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: { ...ATTRS }, skills: [], ...(hp !== undefined ? { hp, hpMax } : {}) }];
  m.tokens = [{ id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2 }];
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0, combat: true,
    moved: {}, turned: {}, acted: {}, turn: 1, movePoints: {}, charge: {}, msg: '', markSymbol: '!', markText: '', markMode: false } });
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
  assert.ok(ev.deltas.some((d) => d.kind === 'moved'));
  assert.match(ev.note, /超过 10/);
  assert.match(w.log.at(-1).text, /濒死/);
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
  assert.ok(ev.deltas.some((d) => d.kind === 'moved'));
});
