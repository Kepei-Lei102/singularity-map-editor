import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-vision-algo-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/actions'; export * from './src/defaults'; export * from './src/store'; export * from './src/perception';`, resolveDir: root },
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

function fixture() {
  const world = api.emptyWorld();
  const map = api.newMap('走廊', '测试', 0, 40, 5, 'floor', false);
  map.autoFog = true;
  map.objects = [];
  map.spawn = { x: 1, y: 2 };
  world.party = [{ id: 'pc', name: '甲', color: '#fff', tags: [], sex: '男' }];
  map.tokens = [{ id: 'tk', pcId: 'pc', name: '甲', color: '#fff', x: 1, y: 2 }];
  world.maps = [map];
  // 先定算法再重算，避免上一个用例留下的 legacy 把格子先标成「见过」
  api.setUI({ mapId: map.id, trial: null, selection: null, mode: 'edit', visionAlgo: 'rulebook' });
  api.replaceWorld(world);
  return { world, map };
}

test('规则书视野：15 格看得见，第 16 格看不见', () => {
  const { map } = fixture();
  api.setVisionAlgo('rulebook');
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.fog[2 * 40 + 16], 1);  // 距 15
  assert.equal(m.fog[2 * 40 + 17], 0);  // 距 16
  assert.equal(m.fog[2 * 40 + 1], 1);   // 自己脚下
});

test('切回老口径：空地不衰减，看得更远', () => {
  const { map } = fixture();
  api.setVisionAlgo('legacy');
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.fog[2 * 40 + 17], 1); // 老口径空地不累加，第 16 格仍可见
});

test('切换当场重算，不用改世界', () => {
  const { map } = fixture();
  api.setVisionAlgo('rulebook');
  const a = api.findMap(api.getWorld(), map.id).fog[2 * 40 + 17];
  api.setVisionAlgo('legacy');
  const b = api.findMap(api.getWorld(), map.id).fog[2 * 40 + 17];
  assert.equal(a, 0);
  assert.equal(b, 1);
});
