// 取消判定要通知玩家窗口：不然他的骰盘一直挂着，掷了也没人接。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-cancel-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: {
    contents: `export * from './src/core/store';
export * from './src/core/defaults';
export * from './src/runtime/sync';
export * from './src/runtime/trial';
export * from './src/rules/judgments';`,
    resolveDir: root,
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.location = { search: '', origin: 'http://localhost' };
// 每个窗口单独记账：这样才能验「只发给该收的那个人」。
const windows = [];
globalThis.window = {
  setTimeout: () => 0,
  open: () => { const win = { closed: false, got: [], postMessage(m) { win.got.push(m); } }; windows.push(win); return win; },
};
globalThis.BroadcastChannel = class { postMessage() {} };
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
const api = createRequire(import.meta.url)(bundle);
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

function party() {
  const w = api.emptyWorld();
  w.party = [
    { id: 'a', name: '甲', color: '#fff', tags: [], sex: '男' },
    { id: 'b', name: '乙', color: '#fff', tags: [], sex: '女' },
  ];
  api.replaceWorld(w);
}
const clear = () => windows.forEach((win) => { win.got.length = 0; });

test('judge-cancel 只发给那个角色自己的窗口', () => {
  party();
  api.openPlayerWindow('a');
  api.openPlayerWindow('b');
  clear();

  api.pushJudgeCancel('a', 'j1');
  assert.equal(windows[0].got.length, 1);
  assert.equal(windows[0].got[0].type, 'judge-cancel');
  assert.equal(windows[0].got[0].id, 'j1');
  assert.equal(windows[1].got.length, 0, 'b 的窗口不该收到 a 的取消消息');
});

test('玩家自己掷的正式判定也能广播（persona 是「谁掷的」，不是只有见证者才算数）', () => {
  party();
  const ctx = api.worldContext();
  const roll = { id: 'r1', sides: 20, value: 10, material: 'wood', persona: 'player', seed: 1 };
  const base = { title: '观察', ruling: '', recipients: [], roll };
  assert.equal(api.publishJudgment(base, ctx), null, '玩家掷的判定必须能广播');
  assert.equal(api.publishJudgment({ ...base, title: '代掷', roll: { ...roll, id: 'r2', persona: 'witness' } }, ctx), null);
  assert.match(api.publishJudgment({ ...base, title: '坏数据', roll: { ...roll, id: 'r3', persona: 'god' } }, ctx) ?? '', /骰子记录无效/);
  // 宽进会把 ['player'] 转成 'player' 混过去；现在必须严格比字符串
  assert.match(api.publishJudgment({ ...base, title: '坏数组', roll: { ...roll, id: 'r4', persona: ['player'] } }, ctx) ?? '', /骰子记录无效/);
  assert.match(api.publishJudgment(base, ctx) ?? '', /已经发布过/);
});

test('取消判定并通知：主持端清掉等骰子的状态，玩家窗口收到 judge-cancel', () => {
  party();
  api.openPlayerWindow('a');
  const win = windows.at(-1); // 上一轮的窗口还留着，别数错
  clear();
  api.setUI({ pendingJudgment: { id: 'j9', title: '观察检定', subjectId: 'a' } });

  const msg = api.cancelPendingJudgment();
  assert.equal(msg, null, '取消成功');
  assert.equal(api.getUI().pendingJudgment, null, '主持端不再等这颗骰子');
  assert.equal(win.got.length, 1);
  assert.equal(win.got[0].type, 'judge-cancel');
  assert.equal(win.got[0].id, 'j9');
});

test('掷骰只认绑给判定角色的窗口：别的玩家窗口、无来源的广播都塞不进来', () => {
  party();
  api.openPlayerWindow('a');
  const winA = windows.at(-1);
  api.openPlayerWindow('b');
  const winB = windows.at(-1);
  api.openJudgment({ title: '观察', ruling: '', sides: 20, subjectId: 'a' });
  const id = api.getUI().pendingJudgment.id;
  const msg = { id, title: '观察', sides: 20, value: 12, tens: null, units: null, material: 'wood', seed: 1, rollId: 'r1', from: api.SESSION };
  api.onJudgeRoll(msg, winB);
  assert.equal(api.getUI().judgmentResult, null, '乙的窗口不能替甲掷');
  api.onJudgeRoll(msg, null);
  assert.equal(api.getUI().judgmentResult, null, '没有来源的广播不能落成结果');
  api.onJudgeRoll(msg, winA);
  assert.equal(api.getUI().judgmentResult?.value, 12);
});

test('确认广播后主持端和玩家窗口一起收盘（玩家亲手掷）', () => {
  party();
  api.openPlayerWindow('a');
  const win = windows.at(-1);
  win.got.length = 0;
  api.openJudgment({ title: '观察', ruling: '', sides: 20, subjectId: 'a' });
  const id = api.getUI().pendingJudgment.id;
  api.onJudgeRoll({ id, title: '观察', sides: 20, value: 12, tens: null, units: null, material: 'wood', seed: 1, rollId: 'r1', from: api.SESSION }, win);
  assert.equal(api.settlePendingJudgment({ rollId: 'r1', sides: 20, value: 12, tens: null, units: null, material: 'wood', seed: 1 }, false), null);
  assert.equal(api.getUI().pendingJudgment, null);
  assert.equal(api.getUI().judgmentResult, null);
  assert.equal(api.getWorld().judgments.length, 1);
  assert.equal(api.getWorld().judgments[0].roll.persona, 'player');
  assert.equal(win.got.filter((m) => m.type === 'judge-cancel' && m.id === id).length, 1);
});

test('见证者代掷结算后玩家窗口也收盘，骰子记账是 witness', () => {
  party();
  api.openPlayerWindow('a');
  const win = windows.at(-1);
  win.got.length = 0;
  api.openJudgment({ title: '观察', ruling: '', sides: 20, subjectId: 'a' });
  const id = api.getUI().pendingJudgment.id;
  assert.equal(api.standInForJudgment(), null);
  assert.equal(api.settlePendingJudgment({ rollId: 'r2', sides: 20, value: 15, tens: null, units: null, material: 'wood', seed: 2 }, true), null);
  assert.equal(api.getUI().pendingJudgment, null);
  assert.equal(api.getWorld().judgments[0].roll.persona, 'witness');
  assert.equal(win.got.filter((m) => m.type === 'judge-cancel' && m.id === id).length, 1);
});

test('结束试玩：主持端的待掷判定跟着作废，试玩窗口收盘、真实窗口不受影响', () => {
  party();
  api.openPlayerWindow('a');
  const real = windows.at(-1);
  api.beginSandbox();
  try {
    api.setUI({ trial: { mapId: api.getWorld().maps[0].id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0 } });
    api.openPlayerWindow('a', true);
    const trialWin = windows.at(-1);
    api.openJudgment({ title: '试玩判定', ruling: '', sides: 20, subjectId: 'a' });
    assert.ok(api.getUI().pendingJudgment);
    real.got.length = 0;
    trialWin.got.length = 0;
    api.pushJudgmentRequest('a');
    assert.ok(trialWin.got.some((m) => m.type === 'judge-request'), '试玩窗口收到骰盘');
    assert.equal(real.got.filter((m) => m.type === 'judge-request').length, 0, '真实窗口不该收到试玩判定');
    real.got.length = 0;
    trialWin.got.length = 0;
    api.endTrial();
    assert.equal(api.getUI().pendingJudgment, null);
    assert.equal(api.getUI().judgmentResult, null);
    assert.ok(trialWin.got.some((m) => m.type === 'judge-cancel'), '试玩窗口收到收盘');
    assert.equal(real.got.filter((m) => m.type === 'judge-cancel').length, 0, '真实窗口不该收到试玩的判定消息');
  } finally {
    api.endSandbox();
    api.setUI({ trial: null });
  }
});

test('换工程：主持端的待掷判定清掉，玩家窗口收到 clear', () => {
  party();
  api.openPlayerWindow('a');
  const win = windows.at(-1);
  win.got.length = 0;
  api.openJudgment({ title: '旧工程判定', ruling: '', sides: 20, subjectId: 'a' });
  api.replaceWorld(api.emptyWorld());
  assert.equal(api.getUI().pendingJudgment, null);
  assert.equal(api.getUI().judgmentResult, null);
  assert.ok(win.got.some((m) => m.type === 'clear'), '玩家窗口收到 clear');
});

test('换上下文后结算被拒：不静默写进另一个世界，也不清 pending', () => {
  party();
  api.openPlayerWindow('a');
  const win = windows.at(-1);
  win.got.length = 0;
  api.openJudgment({ title: '正式判定', ruling: '', sides: 20, subjectId: 'a' });
  api.beginSandbox(); // 上下文变成 :trial
  try {
    const id = api.getUI().pendingJudgment.id;
    api.onJudgeRoll({ id, title: '正式判定', sides: 20, value: 9, tens: null, units: null, material: 'wood', seed: 1, rollId: 'r1', from: api.SESSION }, win);
    assert.equal(api.getUI().judgmentResult, null, '跨上下文的骰子不许落成结果');
    const err = api.settlePendingJudgment({ rollId: 'r1', sides: 20, value: 9, tens: null, units: null, material: 'wood', seed: 1 }, false);
    assert.match(err ?? '', /切换/);
    assert.ok(api.getUI().pendingJudgment, 'pending 不能被清掉');
    assert.equal((api.getWorld().judgments ?? []).length, 0, '不许写进沙盒');
    assert.equal(win.got.filter((m) => m.type === 'judge-cancel').length, 0);
  } finally {
    api.endSandbox();
  }
});

test('开始试玩：之前在真实世界里等着的判定被取消并通知玩家窗口', () => {
  party();
  api.setUI({ mapId: api.getWorld().maps[0].id });
  api.openPlayerWindow('a');
  const win = windows.at(-1);
  win.got.length = 0;
  api.openJudgment({ title: '正式判定', ruling: '', sides: 20, subjectId: 'a' });
  api.startTrial();
  try {
    assert.equal(api.getUI().pendingJudgment, null);
    assert.ok(win.got.some((m) => m.type === 'judge-cancel'), '真实窗口收到取消');
  } finally {
    api.endTrial();
  }
});

test('world 推送也按上下文分账：试玩中真实窗口的 pendingJudgment 是空的', () => {
  party();
  api.openPlayerWindow('a');
  const real = windows.at(-1);
  api.beginSandbox();
  try {
    api.setUI({ trial: { mapId: api.getWorld().maps[0].id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0 } });
    api.openPlayerWindow('a', true);
    const trialWin = windows.at(-1);
    api.openJudgment({ title: '试玩判定', ruling: '', sides: 20, subjectId: 'a' });
    real.got.length = 0;
    trialWin.got.length = 0;
    api.send({ type: 'world', world: api.getWorld() });
    const realWorld = real.got.find((m) => m.type === 'world');
    const trialWorld = trialWin.got.find((m) => m.type === 'world');
    assert.ok(realWorld && trialWorld);
    assert.equal(realWorld.world.pendingJudgment ?? null, null, '真实窗口不该看到试玩判定');
    assert.equal(trialWorld.world.pendingJudgment?.id, api.getUI().pendingJudgment.id);
    assert.equal(trialWorld.world.pendingJudgment?.context, undefined, '不给玩家看内部上下文');
  } finally {
    api.endSandbox();
    api.setUI({ trial: null });
  }
});

test('跨上下文结算不许先落地：跳跃判定不会在另一个世界里挪棋子', () => {
  party();
  api.setUI({ mapId: api.getWorld().maps[0].id });
  api.update((d) => { d.maps[0].tokens.push({ id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 1, y: 1 }); });
  api.openJudgment({ title: '跳跃', ruling: '', sides: 20, subjectId: 'a', jump: { tokenId: 'ta', landing: { x: 2, y: 2 }, dice: 'single' } });
  const before = api.getWorld().maps[0].tokens.find((t) => t.id === 'ta').x;
  api.beginSandbox();
  try {
    const err = api.settlePendingJudgment({ rollId: 'r9', sides: 20, value: 11, tens: null, units: null, material: 'wood', seed: 9 }, false);
    assert.match(err ?? '', /切换/, '必须先挡住，而不是去另一个世界落地');
    assert.equal(api.getWorld().maps[0].tokens.find((t) => t.id === 'ta').x, before);
    assert.ok(api.getUI().pendingJudgment);
  } finally {
    api.endSandbox();
  }
});
