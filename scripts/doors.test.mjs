// 开门 / 撬锁：第一条落到物件状态的事件账本。
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-doors-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: {
    contents: `export * from './src/core/store';
export * from './src/core/defaults';
export * from './src/core/schema.js';
export * from './src/runtime/sync';
export * from './src/runtime/trial';
export * from './src/rules/judgments';
export * from './src/rules/events';`,
    resolveDir: root,
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.location = { search: '', origin: 'http://localhost' };
const windows = [];
globalThis.window = {
  setTimeout: () => 0,
  open: () => { const win = { closed: false, got: [], postMessage(m) { win.got.push(m); } }; windows.push(win); return win; },
};
globalThis.BroadcastChannel = class { postMessage() {} };
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
const api = createRequire(import.meta.url)(bundle);
after(() => rm(temp, { recursive: true, force: true }));

const WALL = (id) => ({
  id, kind: 'object', name: '墙', x: 1, y: 2, w: 2, h: 1, height: 2.4, color: '#8b8175', icon: '',
  states: ['固定'], state: 0, notes: '', hidden: false, secrets: [], media: [],
  geometry: { kind: 'wall', a: { x: 3, y: 6 }, b: { x: 9, y: 6 }, thickness: 100, material: 'wall' },
});
const DOOR = (lock) => ({
  id: 'door1', kind: 'object', name: '门', x: 1, y: 2, w: 1, h: 1, height: 2.4, color: '#8b8175', icon: '',
  states: ['关闭', '打开'], state: 0, blocksWhen: [0], notes: '', hidden: false, secrets: [], media: [],
  opening: { wallId: 'wall1', offset: 0, width: 3, openStates: [1] },
  ...(lock ? { lock } : {}),
});

/** 一间房、一扇门、一个贴身的角色。默认角色有【开锁副手】，智慧 60 → 12，敏捷 40 → 8。 */
function stage({ lock = null, skills = ['001-9-204'], token = { x: 1, y: 1 }, open = false, extraWall = false } = {}) {
  const w = api.emptyWorld();
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], sex: '男', skills, attributes: { 力量: 60, 敏捷: 40, 意志: 50, 观察: 50, 智慧: 60, 魅力: 50 } }];
  const m = w.maps[0];
  m.fog = m.fog.map(() => 1);
  m.objects = [WALL('wall1'), DOOR(lock)];
  if (extraWall) m.objects.push({
    id: 'wall2', kind: 'object', name: '隔墙', x: 0, y: 0, w: 1, h: 3, height: 2.4, color: '#8b8175', icon: '',
    states: ['固定'], state: 0, notes: '', hidden: false, secrets: [], media: [],
    geometry: { kind: 'wall', a: { x: 3, y: 0 }, b: { x: 3, y: 9 }, thickness: 100, material: 'wall' },
  });
  m.objects[1].state = open ? 1 : 0;
  m.tokens = [{ id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: token.x, y: token.y, ...(token.facing ? { facing: token.facing } : {}) }];
  api.replaceWorld(w);
  api.setUI({ mapId: m.id });
  api.beginSandbox();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0 } });
  return { w, m, doorId: 'door1' };
}
function stop() { api.endSandbox(); api.setUI({ trial: null }); windows.forEach((win) => { win.got.length = 0; }); }
function door() { return api.getWorld().maps[0].objects.find((o) => o.id === 'door1'); }
function lastEvent() { return (api.getWorld().events ?? []).at(-1); }

function rollMsg(value, values) {
  return { type: 'judge-roll', id: api.getUI().pendingJudgment.id, title: api.getUI().pendingJudgment.title, sides: 20, value, values, tens: null, units: null, material: 'wood', seed: 1, rollId: 'r1', from: api.SESSION };
}
function settle(values) {
  return api.settlePendingJudgment({ rollId: 'r1', sides: 20, value: values[0], values, tens: null, units: null, material: 'wood', seed: 1 }, false);
}

test('schema 认门锁：合法的过，坏字段报错', () => {
  const w = api.emptyWorld();
  w.party = [];
  const base = { id: 'box', kind: 'object', name: '箱子', x: 1, y: 1, w: 1, h: 1, height: 0.5, color: '#fff', icon: '', states: ['关'], state: 0, notes: '', hidden: false, secrets: [], media: [] };
  w.maps[0].objects = [{ ...base, lock: { kind: 'physical', locked: true, keyable: true } }];
  assert.doesNotThrow(() => api.checkWorld(w));
  w.maps[0].objects[0].lock.kind = 'magic';
  assert.throws(() => api.checkWorld(w), /lock\.kind/);
});

test('开门：没锁直接开，记一条带 delta 的事件（不掷骰）', () => {
  stage();
  try {
    assert.deepEqual(api.trialDoors().map((d) => d.name), ['门']);
    assert.equal(api.trialOpenDoor('door1'), null);
    assert.equal(door().state, 1, '门真的开了');
    const ev = lastEvent();
    assert.equal(ev.action.name, '开门');
    assert.equal(ev.action.source, '临场');
    assert.equal(ev.target.kind, 'object');
    assert.equal(ev.check, undefined, '开门不掷骰');
    assert.deepEqual(ev.deltas, [{ kind: 'object', id: 'door1', name: '门', path: '状态', from: '关闭', to: '打开' }]);
    const log = api.getWorld().log.at(-1);
    assert.equal(log.eventId, ev.id, '日志指回事件');
    assert.match(log.text, /开门/);
  } finally { stop(); }
});

test('锁着的门不能直接开；按不开锁也不该凭空打开', () => {
  stage({ lock: { kind: 'physical', locked: true, keyable: true } });
  try {
    assert.match(api.trialOpenDoor('door1') ?? '', /锁着/);
    assert.equal(door().state, 0);
    assert.equal(lastEvent(), undefined, '拒绝时不留事件');
  } finally { stop(); }
});

test('巧力撬锁：玩家窗口掷智慧＋敏捷两颗，都过才开', () => {
  stage({ lock: { kind: 'physical', locked: true, keyable: true } });
  try {
    api.openPlayerWindow('a', true);
    const win = windows.at(-1);
    win.got.length = 0;
    assert.equal(api.trialPickLock('door1', 'pick'), null);
    const p = api.getUI().pendingJudgment;
    assert.deepEqual(p.check.attrs.map((a) => a.attr), ['智慧', '敏捷']);
    assert.equal(p.check.merge, 'all');
    assert.equal(p.check.dc, 20);
    assert.equal(p.door.method, 'pick');
    assert.ok(win.got.some((m) => m.type === 'judge-request'), '骰盘进了他的窗口');

    api.onJudgeRoll(rollMsg(14, [14, 16]), win);
    assert.equal(api.getUI().judgmentResult.values.length, 2);
    assert.equal(settle([14, 16]), null);
    assert.equal(door().state, 1, '锁开了，门也开了');
    assert.equal(door().lock.locked, false);
    const ev = lastEvent();
    assert.equal(ev.action.name, '撬锁');
    assert.equal(ev.check.merge, 'all');
    assert.equal(ev.check.success, true);
    assert.equal(ev.check.attrs.length, 2);
    assert.deepEqual(ev.check.attrs.map((a) => a.attr), ['智慧', '敏捷']);
    assert.equal(ev.check.rolledBy, 'player');
    assert.equal(ev.deltas.length, 2, '门状态 + 锁具各一条');
    assert.equal(api.getWorld().judgments.at(-1).roll.persona, 'player');
    assert.ok(win.got.some((m) => m.type === 'judge-cancel'));
  } finally { stop(); }
});

test('一个大成功顶俩：智慧掷 20、敏捷没过也算撬开', () => {
  stage({ lock: { kind: 'physical', locked: true, keyable: true } });
  try {
    api.openPlayerWindow('a', true);
    const win = windows.at(-1);
    assert.equal(api.trialPickLock('door1', 'pick'), null);
    api.onJudgeRoll(rollMsg(20, [20, 2]), win);
    assert.equal(settle([20, 2]), null);
    assert.equal(door().state, 1);
    const ev = lastEvent();
    assert.equal(ev.check.success, true);
    assert.equal(ev.check.tier, 'crit');
    assert.equal(ev.check.level, null, 'D20 的大成功没有特大');
    assert.match(ev.note, /没有留痕/);
  } finally { stop(); }
});

test('两颗都没过：门纹丝不动，不写假 delta', () => {
  stage({ lock: { kind: 'physical', locked: true, keyable: true } });
  try {
    api.openPlayerWindow('a', true);
    const win = windows.at(-1);
    assert.equal(api.trialPickLock('door1', 'pick'), null);
    api.onJudgeRoll(rollMsg(2, [2, 2]), win);
    assert.equal(settle([2, 2]), null);
    assert.equal(door().state, 0);
    assert.equal(door().lock.locked, true);
    assert.equal(door().lock.keyable, true);
    const ev = lastEvent();
    assert.equal(ev.check.success, false);
    assert.deepEqual(ev.deltas, [], '没变化就不写变化');
    assert.match(ev.note, /没动/);
  } finally { stop(); }
});

test('智慧过了、敏捷没过：还是要失败——「都要过」不是「过一个」', () => {
  stage({ lock: { kind: 'physical', locked: true, keyable: true } });
  try {
    api.openPlayerWindow('a', true);
    const win = windows.at(-1);
    assert.equal(api.trialPickLock('door1', 'pick'), null);
    api.onJudgeRoll(rollMsg(14, [14, 2]), win);
    assert.equal(settle([14, 2]), null);
    assert.equal(door().state, 0, '敏捷那颗没过，门不该开');
    assert.equal(door().lock.locked, true);
    const ev = lastEvent();
    assert.equal(ev.check.success, false);
    assert.equal(ev.check.tier, null);
    assert.deepEqual(ev.deltas, []);
  } finally { stop(); }
});

test('骰子数量对不上：拒绝结算，门和锁都不动', () => {
  stage({ lock: { kind: 'physical', locked: true, keyable: true } });
  try {
    api.openPlayerWindow('a', true);
    const win = windows.at(-1);
    assert.equal(api.trialPickLock('door1', 'pick'), null);
    api.onJudgeRoll(rollMsg(14, [14]), win);
    assert.match(settle([14]) ?? '', /骰子数量/);
    assert.equal(door().state, 0);
    assert.equal(door().lock.locked, true);
    assert.equal(api.getUI().pendingJudgment.id, api.getUI().judgmentResult.judgmentId, '判定还挂着，没被半截结掉');
  } finally { stop(); }
});

test('掷出 1：锁芯卡死——门仍锁着，但配不出钥匙了', () => {
  stage({ lock: { kind: 'physical', locked: true, keyable: true } });
  try {
    api.openPlayerWindow('a', true);
    const win = windows.at(-1);
    assert.equal(api.trialPickLock('door1', 'pick'), null);
    api.onJudgeRoll(rollMsg(1, [1, 8]), win);
    assert.equal(settle([1, 8]), null);
    assert.equal(door().state, 0, '卡死不等于打开');
    assert.equal(door().lock.locked, true);
    assert.equal(door().lock.keyable, false);
    const ev = lastEvent();
    assert.equal(ev.check.tier, 'fumble');
    assert.deepEqual(ev.deltas, [{ kind: 'object', id: 'door1', name: '门', path: '锁具', from: '锁着', to: '卡死' }]);
    assert.match(ev.note, /卡死/);
    // 巧力不再给，但强行打开还在：卡死不是把门焊死
    assert.match(api.trialPickLock('door1', 'pick') ?? '', /卡死/);
    assert.equal(api.trialPickLock('door1', 'force', { rolls: [15, 15] }), null);
    assert.equal(door().state, 1, '强行打开仍然有效');
    assert.equal(lastEvent().action.name, '暴力开锁');
  } finally { stop(); }
});

test('没解锁【开锁副手】：巧力不给，暴力可以（力量＋敏捷，会响）', () => {
  stage({ lock: { kind: 'physical', locked: true, keyable: true }, skills: [] });
  try {
    assert.equal(api.trialDoors()[0].canPick, false);
    assert.match(api.trialPickLock('door1', 'pick') ?? '', /开锁副手/);
    api.openPlayerWindow('a', true);
    const win = windows.at(-1);
    assert.equal(api.trialPickLock('door1', 'force'), null);
    assert.deepEqual(api.getUI().pendingJudgment.check.attrs.map((a) => a.attr), ['力量', '敏捷']);
    api.onJudgeRoll(rollMsg(12, [12, 12]), win);
    assert.equal(settle([12, 12]), null);
    assert.equal(door().state, 1);
    const ev = lastEvent();
    assert.equal(ev.action.name, '暴力开锁');
    assert.match(ev.note, /动静/);
  } finally { stop(); }
});

test('玩家不在电脑前：见证者现掷，也落成正式判定（persona=witness）', () => {
  stage({ lock: { kind: 'physical', locked: true, keyable: true } });
  try {
    assert.equal(api.trialPickLock('door1', 'force', { rolls: [15, 15] }), null);
    assert.equal(api.getUI().pendingJudgment, null);
    assert.equal(door().state, 1);
    assert.equal(api.getWorld().judgments.at(-1).roll.persona, 'witness');
    assert.equal(lastEvent().check.rolledBy, 'witness');
  } finally { stop(); }
});

test('不贴身/看不见：HUD 不列，动作也拒绝', () => {
  stage({ lock: { kind: 'physical', locked: true, keyable: true }, token: { x: 10, y: 10 } });
  try {
    assert.deepEqual(api.trialDoors(), []);
    assert.match(api.trialOpenDoor('door1') ?? '', /贴身/);
    assert.match(api.trialPickLock('door1', 'force') ?? '', /贴身/);
  } finally { stop(); }
});

test('贴身但被墙挡住视线：不列、也不给操作', () => {
  stage({ lock: { kind: 'physical', locked: true, keyable: true }, token: { x: 0, y: 1 }, extraWall: true });
  try {
    assert.deepEqual(api.trialDoors(), []);
    assert.match(api.trialOpenDoor('door1') ?? '', /看不见/);
  } finally { stop(); }
});

test('身体朝着别处也照样能开门：门不在背后就不给开，那是攻击的规矩，不是门的', () => {
  stage({ token: { x: 1, y: 1, facing: '东' } });
  try {
    assert.equal(api.trialDoors().length, 1);
    assert.equal(api.trialOpenDoor('door1'), null);
    assert.equal(door().state, 1);
  } finally { stop(); }
});

test('电子锁这轮不给撬，明确说还没接', () => {
  stage({ lock: { kind: 'electronic', locked: true, keyable: true } });
  try {
    assert.match(api.trialPickLock('door1', 'force') ?? '', /电子锁/);
  } finally { stop(); }
});
