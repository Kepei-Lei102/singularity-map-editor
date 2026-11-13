import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-facing-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/runtime/trial'; export * from './src/runtime/sync'; export * from './src/core/defaults'; export * from './src/core/store'; export * from './src/runtime/actions';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.location = { search: '', origin: 'http://localhost' };
const windows = [];
globalThis.window = { setTimeout: () => 0, open: () => { const win = { closed: false, got: [], postMessage(m) { this.got.push(m); } }; windows.push(win); return win; } };
globalThis.BroadcastChannel = class { postMessage() {} };
const api = createRequire(import.meta.url)(bundle);
after(() => rm(temp, { recursive: true, force: true }));

function fixture({ combat = false, otherAt = null } = {}) {
  const world = api.emptyWorld();
  const map = api.newMap('测试', '测试', 0, 10, 10, 'floor', false);
  map.autoFog = false;
  map.objects = [];
  map.spawn = { x: 5, y: 5 };
  world.party = [{ id: 'pc', name: '甲', color: '#fff', tags: [], sex: '男' }];
  map.tokens = [{ id: 't1', pcId: 'pc', name: '甲', color: '#fff', x: 5, y: 5 }];
  if (otherAt) map.tokens.push({ id: 't2', pcId: null, name: '乙', color: '#000', x: otherAt.x, y: otherAt.y });
  world.maps = [map];
  api.replaceWorld(world);
  api.setUI({
    mapId: map.id, mode: 'edit',
    trial: { mapId: map.id, players: [{ tokenId: 't1', pcId: 'pc', name: '甲' }], current: 0, combat, moved: {}, turned: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false },
  });
  return { map };
}

const token = (map) => api.findMap(api.getWorld(), map.id).tokens.find((t) => t.id === 't1');

test('方向键映射 4 向', () => {
  assert.equal(api.dirOf(0, -1), '北');
  assert.equal(api.dirOf(0, 1), '南');
  assert.equal(api.dirOf(1, 0), '东');
  assert.equal(api.dirOf(-1, 0), '西');
});

test('自由行动：第一次按方向只转身，第二次同方向才走', () => {
  const { map } = fixture();
  const before = token(map);
  assert.equal(before.facing, undefined);
  api.trialMove(0, -1);
  let t = token(map);
  assert.deepEqual([t.x, t.y], [5, 5], '第一下不移动');
  assert.equal(t.facing, '北');
  assert.match(api.getUI().trial.msg, /转向北/);
  api.trialMove(0, -1);
  t = token(map);
  assert.deepEqual([t.x, t.y], [5, 4], '第二下才走');
  assert.equal(t.facing, '北');
});

test('自由行动：走起来之后同方向继续走，不用每步都确认', () => {
  const { map } = fixture();
  api.trialMove(0, -1);
  api.trialMove(0, -1);
  api.trialMove(0, -1);
  const t = token(map);
  assert.deepEqual([t.x, t.y], [5, 3]);
});

test('自由行动：玩家窗口收到转向回执是成功，不是失败', () => {
  const { map } = fixture();
  api.openPlayerWindow('pc', true);
  const win = windows.at(-1);
  const move = (dx, dy) => api.onMove({ type: 'move', dx, dy, __ts: 'ts-map', seq: 's1', from: api.SESSION, inst: 'inst', born: 1 }, win);

  win.got.length = 0;
  move(0, -1); // 第一下：只转向
  const first = win.got.find((m) => m.type === 'move-result');
  assert.equal(first.ok, true, '转身必须回成功');
  assert.equal(first.kind, 'turn');
  assert.match(first.msg, /转向北/);
  assert.deepEqual([token(map).x, token(map).y], [5, 5]);

  win.got.length = 0;
  move(0, -1); // 第二下：走
  const second = win.got.find((m) => m.type === 'move-result');
  assert.equal(second.ok, true);
  assert.equal(second.kind, 'move');
  assert.deepEqual([token(map).x, token(map).y], [5, 4]);
});

test('自由行动：要检定的宽坑开判定也不算失败', () => {
  const { map } = fixture();
  api.update((d) => {
    d.maps[0].cells[4 * 10 + 5] = 'hole'; // 北边两格都是坑
    d.maps[0].cells[3 * 10 + 5] = 'hole';
    d.party[0].attributes = { 力量: 50, 敏捷: 50, 意志: 50, 观察: 50, 智慧: 50, 魅力: 50 };
  });
  api.openPlayerWindow('pc', true);
  const win = windows.at(-1);
  const move = (dx, dy) => api.onMove({ type: 'move', dx, dy, __ts: 'ts-map', seq: 's3', from: api.SESSION, inst: 'inst', born: 1 }, win);

  move(0, -1); // 转向
  move(0, -1); // 坑前提示
  win.got.length = 0;
  move(0, -1); // 第二确认：开跳跃判定，不位移
  const judged = win.got.find((m) => m.type === 'move-result');
  assert.equal(judged.ok, true, '开判定不是失败');
  assert.equal(judged.kind, 'prompt');
  assert.match(judged.msg, /判定/);
  assert.ok(api.getUI().pendingJudgment, '确实开了判定');
  assert.deepEqual([token(map).x, token(map).y], [5, 5], '判定前不移动');
});

test('自由行动：坑前确认和跳过去成功都不该是红条', () => {
  const { map } = fixture();
  api.update((d) => { d.maps[0].cells[4 * 10 + 5] = 'hole'; }); // 北边一格是坑
  api.openPlayerWindow('pc', true);
  const win = windows.at(-1);
  const move = (dx, dy) => api.onMove({ type: 'move', dx, dy, __ts: 'ts-map', seq: 's2', from: api.SESSION, inst: 'inst', born: 1 }, win);

  move(0, -1); // 转向
  win.got.length = 0;
  move(0, -1); // 坑前提示：等再按一次
  const prompt = win.got.find((m) => m.type === 'move-result');
  assert.equal(prompt.ok, true, '起跳确认不是失败');
  assert.equal(prompt.kind, 'prompt');
  assert.match(prompt.msg, /再按一次同方向/);

  win.got.length = 0;
  move(0, -1); // 跳过去
  const jump = win.got.find((m) => m.type === 'move-result');
  assert.equal(jump.ok, true, '跳过去成功不是失败');
  assert.equal(jump.kind, 'move');
  assert.deepEqual([token(map).x, token(map).y], [5, 3]);
});

test('战斗中：第一次按方向只转身，第二次才移动', () => {
  const { map } = fixture({ combat: true, otherAt: null });
  api.trialMove(0, -1);
  let t = token(map);
  assert.deepEqual([t.x, t.y], [5, 5]); // 没动
  assert.equal(t.facing, '北');
  api.trialMove(0, -1);
  t = token(map);
  assert.deepEqual([t.x, t.y], [5, 4]); // 走了
  assert.equal(t.facing, '北');
});

test('战斗中换方向先转身：面朝北按 D 只转向不动', () => {
  const { map } = fixture({ combat: true });
  api.trialMove(0, -1); api.trialMove(0, -1); // 朝北走一步到 (5,4)
  api.trialMove(1, 0);                        // 朝东：只转身
  const t = token(map);
  assert.equal(t.facing, '东');
  assert.deepEqual([t.x, t.y], [5, 4]);
});

test('缠斗时一回合只能转一次身', () => {
  const { map } = fixture({ combat: true, otherAt: { x: 6, y: 5 } });
  api.trialMove(0, -1); // 转向北：这一回合的转身额度用掉（不移动）
  assert.equal(token(map).facing, '北');
  api.trialMove(0, 1);  // 想转南：被缠斗限制
  const t = token(map);
  assert.equal(t.facing, '北');
  assert.deepEqual([t.x, t.y], [5, 5]);
  assert.match(api.getUI().trial.msg, /缠斗/);
});

test('没被缠住时战斗中也能连续转身', () => {
  const { map } = fixture({ combat: true });
  api.trialMove(1, 0);
  api.trialMove(0, -1);
  assert.equal(token(map).facing, '北');
});

test('结束回合清掉转身记录，可以再转', () => {
  const { map } = fixture({ combat: true, otherAt: { x: 6, y: 5 } });
  api.trialMove(1, 0);
  api.trialEndTurn();
  assert.equal(api.getUI().trial.turn, 2);
  api.trialMove(0, -1);
  assert.equal(token(map).facing, '北');
});
