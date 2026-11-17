import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-wall-sub-test-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/runtime/actions'; export * from './src/core/defaults'; export * from './src/core/store'; export * from './src/scene/architecture'; export * from './src/scene/terrain'; export { checkArchitecture } from './src/core/schema';`, resolveDir: root },
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
  const map = api.newMap('测试图', '测试', 0, 10, 10, 'floor', false);
  map.autoFog = false;
  map.objects = [];
  world.maps = [map];
  api.replaceWorld(world);
  api.setUI({ mapId: map.id, trial: null, selection: null, mode: 'edit' });
  return { world, map };
}

test('放薄墙不再要求先细分，任意小格坐标都能落墙', () => {
  const { map } = fixture();
  const error = api.addArchitectureWall(map.id, { x: 3, y: 1 }, { x: 3, y: 4 }, 'wall', 120);
  assert.equal(error, null);
  const after = api.findMap(api.getWorld(), map.id);
  assert.equal(after.subdivisions, undefined);
  assert.equal(after.subCells, undefined);
  const wall = api.architectureWalls(after)[0];
  assert.ok(wall);
  assert.deepEqual(wall.a, { x: 3, y: 1 });
  assert.doesNotThrow(() => api.checkArchitecture(after));
});

test('玻璃墙同样不需要细分', () => {
  const { map } = fixture();
  const error = api.addArchitectureWall(map.id, { x: 6, y: 0 }, { x: 6, y: 9 }, 'glass', 120);
  assert.equal(error, null);
  const after = api.findMap(api.getWorld(), map.id);
  assert.equal(after.subdivisions, undefined);
  assert.doesNotThrow(() => api.checkArchitecture(after));
});

test('墙可以跨过任意主格，门洞仍然按小格长度校验', () => {
  const { map } = fixture();
  const error = api.addArchitectureWall(map.id, { x: 0, y: 3 }, { x: 9, y: 3 }, 'wall', 120);
  assert.equal(error, null);
  const after = api.findMap(api.getWorld(), map.id);
  const wall = api.architectureWalls(after)[0];
  assert.equal(api.addArchitectureDoor(map.id, wall.id, 2, 3), null);
  const withDoor = api.findMap(api.getWorld(), map.id);
  assert.doesNotThrow(() => api.checkArchitecture(withDoor));
});

test('普通地形墙和小格地形互不影响', () => {
  const { map } = fixture();
  api.paintTerrainSubcells(map.id, [[3, 3]], 'wall');
  const after = api.findMap(api.getWorld(), map.id);
  assert.equal(after.subdivisions, undefined);
  assert.equal(api.terrainAtSubcell(after, 3, 3), 'wall');
});
