// 电子锁：玩家窗口输密码 → 主持人裁定反馈/后果 → 一条事件。
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-codes-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: {
    contents: `export * from './src/core/store';
export * from './src/core/defaults';
export * from './src/core/schema.js';
export * from './src/runtime/sync';
export * from './src/runtime/trial';
export * from './src/rules/events';
export * from './src/scene/identity';`,
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
const DOOR = (code) => ({
  id: 'door1', kind: 'object', name: '门', x: 1, y: 2, w: 1, h: 1, height: 2.4, color: '#8b8175', icon: '',
  states: ['关闭', '打开'], state: 0, blocksWhen: [0], notes: '', hidden: false, secrets: [], media: [],
  opening: { wallId: 'wall1', offset: 0, width: 3, openStates: [1] },
  lock: { kind: 'electronic', locked: true, keyable: true, ...(code === undefined ? {} : { code }) },
});

/** 一间房、一扇电子锁门、一个贴身的角色。 */
function stage({ code = '4821', combat = false } = {}) {
  const w = api.emptyWorld();
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], sex: '男', skills: [], attributes: { 力量: 60, 敏捷: 40, 意志: 50, 观察: 50, 智慧: 60, 魅力: 50 } }];
  const m = w.maps[0];
  m.fog = m.fog.map(() => 1);
  m.objects = [WALL('wall1'), DOOR(code)];
  m.tokens = [{ id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 1, y: 1 }];
  api.replaceWorld(w);
  api.setUI({ mapId: m.id });
  api.beginSandbox();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0, combat } });
  return { w, m };
}
function stop() { api.endSandbox(); api.setUI({ trial: null }); windows.forEach((win) => { win.got.length = 0; }); }
function door() { return api.getWorld().maps[0].objects.find((o) => o.id === 'door1'); }
function lastEvent() { return (api.getWorld().events ?? []).at(-1); }
function submit(win, id, code) {
  api.onCodeSubmit({
    type: 'code-submit', id, code, __ts: 'ts-map', seq: 's1',
    from: api.SESSION, inst: 'inst', born: 1,
  }, win);
}

test('电子锁：玩家窗口输密码，主持人写反馈并解锁开门，只落一条事件', () => {
  stage();
  try {
    api.openPlayerWindow('a', true);
    const win = windows.at(-1);
    assert.equal(api.trialAskCode('door1'), null);
    const p = api.getUI().pendingCode;
    assert.ok(p, '主持人有一笔等密码');
    assert.equal(p.fromWindow, true);
    assert.equal(p.expectedCode, '4821');
    assert.equal(p.code, null);
    const req = win.got.find((m) => m.type === 'code-request');
    assert.ok(req, '玩家窗口收到输密码请求');
    assert.equal(req.request.name, '门');
    assert.equal('expectedCode' in req.request, false);
    assert.equal('code' in req.request, false);
    assert.equal(api.getUI().pendingCode.code, null);

    submit(win, p.id, '4821');
    assert.equal(api.getUI().pendingCode.code, '4821');
    assert.equal(lastEvent(), undefined, '反馈卡消费之前不落账');

    assert.equal(api.trialSettleCode(p.id, { text: '灯亮两格，锁开了', pushToPlayer: true, consequence: 'unlock-open' }), null);
    assert.equal(api.getUI().pendingCode, null);
    assert.equal(door().lock.locked, false);
    assert.equal(door().state, 1);
    const ev = lastEvent();
    assert.equal(ev.action.name, '输入密码');
    assert.equal(ev.target.id, 'door1');
    assert.match(ev.note, /灯亮两格/);
    assert.match(ev.note, /锁解开并开门/);
    assert.equal(JSON.stringify(ev).includes('4821'), false, '事件里不写密码原文');
    const fed = win.got.find((m) => m.type === 'code-result');
    assert.ok(fed, '玩家窗口收到反馈');
    assert.equal(fed.text, '灯亮两格，锁开了');
  } finally { stop(); }
});

test('电子锁：只口头反馈也能落账，玩家窗口只收到空的收尾消息', () => {
  stage();
  try {
    api.openPlayerWindow('a', true);
    const win = windows.at(-1);
    assert.equal(api.trialAskCode('door1'), null);
    const p = api.getUI().pendingCode;
    submit(win, p.id, '0000');
    assert.equal(api.trialSettleCode(p.id, { text: '没反应', pushToPlayer: false, consequence: 'stay' }), null);
    assert.equal(door().lock.locked, true);
    assert.equal(door().state, 0);
    const ev = lastEvent();
    assert.equal(ev.deltas.length, 0);
    assert.match(ev.note, /没反应/);
    const fed = win.got.find((m) => m.type === 'code-result');
    assert.ok(fed, '收掉输入框');
    assert.equal(fed.text, undefined);
  } finally { stop(); }
});

test('电子锁：没有玩家窗口时主持人代输，也能落后果', () => {
  stage({ code: null });
  try {
    assert.equal(api.trialAskCode('door1'), null);
    const p = api.getUI().pendingCode;
    assert.equal(p.fromWindow, false);
    assert.equal(p.expectedCode, null);
    assert.equal(api.trialSubmitCode(p.id, 'A-1'), null);
    assert.equal(p.code, null, '返回的是快照，UI 里已经有 code');
    assert.equal(api.getUI().pendingCode.code, 'A-1');
    assert.equal(api.trialSettleCode(p.id, { text: '门开了', pushToPlayer: false, consequence: 'unlock' }), null);
    assert.equal(door().lock.locked, false);
    assert.equal(door().state, 0, '只解锁，门没开');
    assert.match(lastEvent().note, /只解锁/);
  } finally { stop(); }
});

test('电子锁：卡死和报警按钮走不同后果，alarm 不写假 delta', () => {
  stage();
  try {
    api.openPlayerWindow('a', true);
    const win = windows.at(-1);
    assert.equal(api.trialAskCode('door1'), null);
    let p = api.getUI().pendingCode;
    submit(win, p.id, '9999');
    assert.equal(api.trialSettleCode(p.id, { text: '锁舌卡住', pushToPlayer: true, consequence: 'jam' }), null);
    assert.equal(door().lock.keyable, false);
    assert.equal(door().lock.locked, true);
    assert.equal(lastEvent().deltas.at(-1).path, '锁具');

    assert.equal(api.trialAskCode('door1'), null); // 门还关着，锁还锁着；jam 之后可以再开一笔
    p = api.getUI().pendingCode;
    submit(win, p.id, '1111');
    assert.equal(api.trialSettleCode(p.id, { text: '报警了', pushToPlayer: true, consequence: 'alarm' }), null);
    assert.equal(lastEvent().deltas.length, 0);
    assert.match(lastEvent().note, /触发报警/);
  } finally { stop(); }
});

test('电子锁：推到窗口却没写反馈会被拒；战斗中不接密码锁', () => {
  stage();
  try {
    api.openPlayerWindow('a', true);
    const win = windows.at(-1);
    assert.equal(api.trialAskCode('door1'), null);
    const p = api.getUI().pendingCode;
    submit(win, p.id, '4821');
    assert.match(api.trialSettleCode(p.id, { text: '  ', pushToPlayer: true, consequence: 'unlock-open' }) ?? '', /写一句反馈/);
    assert.equal(api.getUI().pendingCode.id, p.id, '拒绝后这笔还挂着');
    assert.equal(lastEvent(), undefined);
  } finally { stop(); }

  stage({ combat: true });
  try {
    assert.match(api.trialAskCode('door1') ?? '', /战斗/);
    assert.equal(api.getUI().pendingCode, null);
  } finally { stop(); }
});

test('电子锁：密码字段只存在主持人侧；玩家对象渲染不带 code', () => {
  stage({ code: '4821' });
  try {
    const doorObj = door();
    assert.equal(api.playerObject(doorObj, 'a').lock.code, undefined, '玩家渲染数据剥掉密码');
    assert.equal(doorObj.lock.code, '4821');
  } finally { stop(); }
});

test('schema 认电子锁 code，坏类型报错', () => {
  const w = api.emptyWorld();
  w.party = [];
  const base = { id: 'lockbox', kind: 'object', name: '锁箱', x: 1, y: 1, w: 1, h: 1, height: 0.5, color: '#fff', icon: '', states: ['关'], state: 0, notes: '', hidden: false, secrets: [], media: [] };
  w.maps[0].objects = [{ ...base, lock: { kind: 'electronic', locked: true, keyable: true, code: 'A-1' } }];
  assert.doesNotThrow(() => api.checkWorld(w));
  w.maps[0].objects[0].lock.code = 4821;
  assert.throws(() => api.checkWorld(w), /lock\.code/);
});


test('电子锁：不是绑定窗口塞来的密码不认', () => {
  stage();
  try {
    api.openPlayerWindow('a', true);
    const win = windows.at(-1);
    assert.equal(api.trialAskCode('door1'), null);
    const p = api.getUI().pendingCode;
    const fake = { closed: false, postMessage() {} };
    submit(fake, p.id, '4821');
    assert.equal(api.getUI().pendingCode.code, null);
    submit(win, p.id, '4821');
    assert.equal(api.getUI().pendingCode.code, '4821');
  } finally { stop(); }
});

test('电子锁：输入后人被挪走，主持人落账前会拒绝', () => {
  stage();
  try {
    api.openPlayerWindow('a', true);
    const win = windows.at(-1);
    assert.equal(api.trialAskCode('door1'), null);
    const p = api.getUI().pendingCode;
    submit(win, p.id, '4821');
    api.update((d) => { d.maps[0].tokens[0].x = 9; d.maps[0].tokens[0].y = 9; });
    assert.match(api.trialSettleCode(p.id, { text: '开', pushToPlayer: true, consequence: 'unlock-open' }) ?? '', /贴身|变了/);
    assert.equal(api.getUI().pendingCode.id, p.id);
    assert.equal(lastEvent(), undefined);
  } finally { stop(); }
});

test('电子锁：没输入密码不能落账；推窗口必须写反馈', () => {
  stage();
  try {
    assert.equal(api.trialAskCode('door1'), null);
    const p = api.getUI().pendingCode;
    assert.match(api.trialSettleCode(p.id, { text: '', pushToPlayer: false, consequence: 'stay' }) ?? '', /还没输入密码/);
    assert.equal(api.trialSubmitCode(p.id, '1234'), null);
    assert.match(api.trialSettleCode(p.id, { text: ' ', pushToPlayer: true, consequence: 'stay' }) ?? '', /写一句反馈/);
    assert.equal(lastEvent(), undefined);
  } finally { stop(); }
});


test('电子锁：玩家载荷里的 pendingCode 只有门名/提交状态，没有密码', () => {
  stage({ code: '4821' });
  try {
    api.openPlayerWindow('a', true);
    const win = windows.at(-1);
    assert.equal(api.trialAskCode('door1'), null);
    const p = api.getUI().pendingCode;
    api.send({ type: 'world' });
    const worldMsg = win.got.filter((m) => m.type === 'world').at(-1);
    assert.ok(worldMsg.world.pendingCode, '玩家窗口知道自己在等密码');
    assert.equal(worldMsg.world.pendingCode.name, '门');
    assert.equal(worldMsg.world.pendingCode.submitted, false);
    assert.equal('code' in worldMsg.world.pendingCode, false);
    assert.equal('expectedCode' in worldMsg.world.pendingCode, false);
    submit(win, p.id, '4821');
    api.send({ type: 'world' });
    const after = win.got.filter((m) => m.type === 'world').at(-1);
    assert.equal(after.world.pendingCode.submitted, true);
    assert.equal('code' in after.world.pendingCode, false);
  } finally { stop(); }
});
