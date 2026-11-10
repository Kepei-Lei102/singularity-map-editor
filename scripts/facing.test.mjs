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
  stdin: { contents: `export * from './src/runtime/trial'; export * from './src/core/defaults'; export * from './src/core/store'; export * from './src/runtime/actions';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.location = { search: '', origin: 'http://localhost' };
globalThis.window = { setTimeout: () => 0, open: () => ({ closed: false, postMessage() {} }) };
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

test('自由行动：按方向直接走，朝向跟着变', () => {
  const { map } = fixture();
  const before = token(map);
  assert.equal(before.facing, undefined);
  api.trialMove(0, -1);
  const t = token(map);
  assert.deepEqual([t.x, t.y], [5, 4]);
  assert.equal(t.facing, '北');
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
