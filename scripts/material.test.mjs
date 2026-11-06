import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-material-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/scene/material'; export * from './src/scene/terrain'; export * from './src/scene/memory'; export * from './src/core/defaults'; export * from './src/core/schema.js'; export * from './src/runtime/actions'; export * from './src/core/store'; export * from './src/runtime/sync';`, resolveDir: root },
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

function fixture(pcId) {
  const world = api.emptyWorld();
  const map = api.newMap('测试', '测试', 0, 10, 10, 'floor', false);
  map.autoFog = false;
  map.fog.fill(1);
  map.seen.cells = map.cells.slice();
  world.maps = [map];
  if (pcId) {
    world.party = [{ id: pcId, name: '甲', tags: [], color: '#fff' }];
    map.tokens = [{ id: 't1', pcId, name: '甲', color: '#fff', x: 1, y: 1 }];
  }
  api.replaceWorld(world);
  return { world, map };
}

test('材质层：大格材质、子格覆盖，以及退回大格', () => {
  const { map } = fixture();
  api.paintMaterialCells(map.id, [[2, 2]], 'wood');
  let m = api.findMap(api.getWorld(), map.id);
  assert.equal(api.materialAtCell(m, 2 * m.width + 2), 'wood');
  assert.equal(api.materialAtSubcell(m, 6, 6), 'wood'); // 没细分，读大格
  api.paintMaterialSubcells(map.id, [[21, 21]], 'stone'); // 主格 (7,7)，自动细分
  m = api.findMap(api.getWorld(), map.id);
  assert.ok(m.subdivisions.includes(7 * m.width + 7));
  assert.equal(api.materialAtSubcell(m, 21, 21), 'stone');
  assert.equal(api.materialAtSubcell(m, 22, 21), ''); // 同格没覆盖，也没有大格材质
});

test('大格材质会清掉这一格下的子格材质覆盖', () => {
  const { map } = fixture();
  api.paintMaterialSubcells(map.id, [[21, 21]], 'stone');
  api.paintMaterialCells(map.id, [[7, 7]], 'wood');
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(api.materialAtSubcell(m, 21, 21), 'wood');
  assert.equal(m.materialSubCells[api.subKey(m, 21, 21)], undefined);
});

test('橡皮擦材质不碰地形，擦完退回地形颜色', () => {
  const { map } = fixture();
  api.paintTerrainSubcells(map.id, [[21, 21]], 'grass');
  api.paintMaterialSubcells(map.id, [[21, 21]], 'stone');
  api.paintMaterialSubcells(map.id, [[21, 21]], null);
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(api.materialAtSubcell(m, 21, 21), '');
  assert.equal(api.terrainAtSubcell(m, 21, 21), 'grass');
});

test('材质层存档结构校验通过；未知世界会补默认材质表', () => {
  const { world, map } = fixture();
  api.paintMaterialCells(map.id, [[1, 1], [2, 1]], 'wood');
  api.paintMaterialSubcells(map.id, [[21, 21]], 'stone');
  const w = api.getWorld();
  assert.doesNotThrow(() => api.checkWorld(w));
  const old = structuredClone(w);
  delete old.materials;
  const migrated = api.migrateWorld(old);
  assert.ok(migrated.materials.some((m) => m.id === 'wood'));
});

test('玩家同步：只发看得见的材质和记得的材质', () => {
  const pcId = 'a';
  const { map } = fixture(pcId);
  api.paintMaterialCells(map.id, [[1, 1], [8, 8]], 'wood');
  // 8,8 看不见：从玩家包里去掉；1,1 看得见：发出去。
  api.update((d) => { const m = api.findMap(d, map.id); m.fog[8 * m.width + 8] = 0; m.seen.cells[8 * m.width + 8] = ''; });
  const pm = api.playerWorld(api.getWorld(), map.id, pcId);
  assert.equal(pm.materials.some((m) => m.id === 'wood'), true);
  assert.equal(Object.values(pm.maps[0].materialCells ?? {}).includes('wood'), true);
  assert.equal(Object.keys(pm.maps[0].materialCells ?? {}).length, 1);
  assert.equal(pm.maps[0].materialCells[8 * pm.maps[0].width + 8], undefined);
});

test('玩家记得的材质：离开视野后从 seen.materialCells 取，不读实时层', () => {
  const pcId = 'a';
  const { map } = fixture(pcId);
  api.paintMaterialCells(map.id, [[1, 1]], 'wood');
  api.update((d) => { const m = api.findMap(d, map.id); m.fog[1 * m.width + 1] = 2; });
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.seen.materialCells[1 * m.width + 1], 'wood');
  // 看不见时改实时层，记忆仍保留上一次看见的样子。
  api.paintMaterialCells(map.id, [[1, 1]], 'stone');
  const pm = api.playerWorld(api.getWorld(), map.id, pcId);
  const seen = pm.maps[0].seen;
  assert.equal(seen.materialCells[1 * pm.maps[0].width + 1], 'wood');
});

test('扩图会平移材质层；取消细分会清掉子格材质覆盖', () => {
  const { map } = fixture();
  api.paintMaterialCells(map.id, [[2, 2]], 'wood');
  api.reshapeMaps([map.id], 1, 0, 0, 0);
  let m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.width, 11);
  assert.equal(m.materialCells[(2 + 1) + 2 * m.width], 'wood');
  assert.equal(m.materialCells[2 + 2 * 10], undefined);
  assert.doesNotThrow(() => api.checkWorld(api.getWorld()));
  api.paintMaterialSubcells(map.id, [[21, 21]], 'stone');
  m = api.findMap(api.getWorld(), map.id);
  const key = api.subKey(m, 21, 21);
  assert.equal(m.materialSubCells[key], 'stone');
  assert.equal(api.subdivideRegion(map.id, { x: 7, y: 7, w: 1, h: 1 }, true), null);
  m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.materialSubCells[key], undefined);
  assert.doesNotThrow(() => api.checkWorld(api.getWorld()));
});
