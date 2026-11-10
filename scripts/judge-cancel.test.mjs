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
export * from './src/runtime/trial';`,
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
