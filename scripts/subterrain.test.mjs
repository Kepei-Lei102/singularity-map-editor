import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-subterrain-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/scene/terrain'; export * from './src/scene/architecture'; export * from './src/core/defaults'; export * from './src/core/schema.js'; export * from './src/runtime/actions'; export * from './src/core/store'; export * from './src/runtime/sync';`, resolveDir: root },
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
  const map = api.newMap('测试', '测试', 0, 10, 10, 'floor', false);
  map.autoFog = false;
  map.objects = [];
  world.maps = [map];
  api.replaceWorld(world);
  return { world, map };
}

test('子格地形：先看覆盖，没有退回大格', () => {
  const { world, map } = fixture();
  api.subdivideRegion(map.id, { x: 2, y: 2, w: 1, h: 1 });
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(api.terrainAtSubcell(m, 6, 6), 'floor');
  api.paintTerrainSubcells(map.id, [[6, 6]], 'grass');
  const after = api.findMap(api.getWorld(), map.id);
  assert.equal(api.terrainAtSubcell(after, 6, 6), 'grass');
  assert.equal(api.terrainAtSubcell(after, 7, 6), 'floor'); // 没覆盖的子格还是大格地形
  assert.equal(api.terrainAtSubcell(after, 3, 3), 'floor'); // 没细分的格子直接读大格
});

test('小格画笔落在没细分的格子会自动细分，并初始化迷雾/记忆', () => {
  const { map } = fixture();
  api.paintTerrainSubcells(map.id, [[21, 21]], 'grass'); // 主格 (7,7)
  const m = api.findMap(api.getWorld(), map.id);
  assert.ok(m.subdivisions.includes(7 * m.width + 7));
  const key = api.subKey(m, 21, 21);
  assert.equal(m.subCells[key], 'grass');
  assert.equal(m.subFog[key], m.fog[7 * m.width + 7]);
  assert.equal(m.seen.subCells[key], m.seen.cells[7 * m.width + 7]);
});

test('大格画笔会清掉这一格下的子格覆盖', () => {
  const { map } = fixture();
  api.paintTerrainSubcells(map.id, [[6, 6]], 'grass');
  api.paintTerrainCells(map.id, [[2, 2]], 'rug');
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.cells[2 * m.width + 2], 'rug');
  assert.equal(api.terrainAtSubcell(m, 6, 6), 'rug');
  assert.equal(m.subCells[api.subKey(m, 6, 6)], undefined);
});

test('不可通行的子格地形按 1/3 小格挡路', () => {
  const { world, map } = fixture();
  api.subdivideRegion(map.id, { x: 2, y: 2, w: 1, h: 1 });
  api.paintTerrainSubcells(map.id, [[7, 7]], 'wall'); // 主格 (2,2) 的中间小格
  const m = api.findMap(api.getWorld(), map.id);
  // 从西往东穿过这格：小格墙在 y=2.33..2.67，路径 y=2.2 被扫到
  assert.equal(api.characterPathClear(world, m, { x: 2.2, y: 2.2 }, { x: 3.8, y: 2.2 }), false);
  // 从上方绕开：y=1.5 碰不到这堵 1/3 小墙
  assert.equal(api.characterPathClear(world, m, { x: 1.5, y: 1.5 }, { x: 3.5, y: 1.5 }), true);
});

test('空白地形仍然算不可通行（和旧规则一致）', () => {
  const { world, map } = fixture();
  api.paintTerrainCells(map.id, [[3, 3]], null);
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(api.terrainBlocksPoint(world, m, 3.5, 3.5), true);
  assert.equal(api.characterPathClear(world, m, { x: 3.5, y: 3.5 }, { x: 3.5, y: 3.5 }), false);
});

test('子格地形只能落在细分过的格子里，校验会拒绝', () => {
  const good = api.emptyWorld();
  const gm = api.newMap('好图', '测试', 0, 10, 10, 'floor', false); gm.objects = [];
  gm.subdivisions = [4 * 10 + 4];
  gm.subCells = { [api.subKey(gm, 12, 12)]: 'grass' };
  good.maps = [gm];
  assert.doesNotThrow(() => api.checkWorld(good));

  const bad = api.emptyWorld();
  const bm = api.newMap('坏图', '测试', 0, 10, 10, 'floor', false); bm.objects = [];
  bm.subCells = { [api.subKey(bm, 0, 0)]: 'grass' }; // 没细分就写子格
  bad.maps = [bm];
  assert.throws(() => api.checkWorld(bad), /细分/);
});

test('改地图尺寸时子格地形跟着平移', () => {
  const { map } = fixture();
  api.paintTerrainSubcells(map.id, [[12, 9]], 'grass'); // 主格 (4,3)
  api.resizeMap(map.id, 12, 10); // 左边不扩，宽度 +2
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(api.terrainAtSubcell(m, 12, 9), 'grass');
  assert.equal(api.terrainAtSubcell(m, 15, 9), 'floor'); // 平移后仍在同一张图，读到新格底色
});

test('点亮后记忆里记的是实际子格地形', () => {
  const { map } = fixture();
  api.paintTerrainSubcells(map.id, [[6, 6]], 'grass');
  api.giveMapKnowledge(map.id);
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.seen.subCells[api.subKey(m, 6, 6)], 'grass');
});

test('玩家同步只带看得见的子格地形', () => {
  const { map } = fixture();
  api.update((d) => { const m = api.findMap(d, map.id); m.fog = m.fog.map(() => 1); });
  api.paintTerrainSubcells(map.id, [[6, 6]], 'grass');
  const m = api.findMap(api.getWorld(), map.id);
  const L = { fog: m.fog, subFog: m.subFog, seen: m.seen };
  const pm = api.playerMap(m, L);
  const key = api.subKey(m, 6, 6);
  assert.equal(pm.subCells[key], 'grass');
  // 变灰之后，实时子格地形不再发给玩家（玩家只拿记忆里的）
  api.update((d) => {
    const mm = api.findMap(d, map.id);
    mm.subFog[key] = 2; mm.fog[6 * mm.width + 6] = 2;
  });
  const m2 = api.findMap(api.getWorld(), map.id);
  const pm2 = api.playerMap(m2, { fog: m2.fog, subFog: m2.subFog, seen: m2.seen });
  assert.equal(pm2.subCells[key], undefined);
  assert.equal(pm2.seen.subCells[key], 'grass');

  // 只出现在子格地形里的材质，也要跟着玩家包一起发出去，不然渲染会变粉
  const pw = api.playerWorld(api.getWorld(), map.id);
  assert.ok(pw.terrains.some((t) => t.id === 'grass'));
});

test('旧版取消细分留下的孤儿子格会被清掉，导出不再报错', () => {
  const world = api.emptyWorld();
  const m = api.newMap('停车场1F', '现实', 1, 45, 32, 'floor', false);
  m.objects = [];
  const keep = 10 * 45 + 10;
  m.subdivisions = [keep];
  m.subCells = {
    [api.subKey(m, 30, 30)]: 'grass', // 父格 (10,10)，还在细分列表里
    [api.subKey(m, 0, 0)]: 'grass',   // 父格 (0,0)，旧版取消细分后残留
  };
  m.materialSubCells = { [api.subKey(m, 3, 3)]: 'wood' }; // 父格 (1,1)，同样残留
  world.maps = [m];
  assert.throws(() => api.checkWorld(world), /细分/);

  assert.equal(api.repairOrphanSubcells(world), 2);
  assert.equal(m.subCells[api.subKey(m, 0, 0)], undefined);
  assert.equal(m.subCells[api.subKey(m, 30, 30)], 'grass');
  assert.equal(m.materialSubCells[api.subKey(m, 3, 3)], undefined);
  assert.doesNotThrow(() => api.checkWorld(world));
});
