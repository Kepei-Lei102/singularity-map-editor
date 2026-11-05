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
  stdin: { contents: `export * from './src/actions'; export * from './src/defaults'; export * from './src/store'; export * from './src/architecture'; export { checkArchitecture } from './src/schema.js';`, resolveDir: root },
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
  map.subdivisions = [];
  map.objects = [];
  world.maps = [map];
  api.replaceWorld(world);
  api.setUI({ mapId: map.id, trial: null, selection: null, mode: 'edit' });
  return { world, map };
}

test('放薄墙时自动细分经过的主格，不再要求先手动细分', () => {
  const { map } = fixture();
  assert.deepEqual(map.subdivisions, []);
  const error = api.addArchitectureWall(map.id, { x: 3, y: 1 }, { x: 3, y: 4 }, 'wall', 120);
  assert.equal(error, null);
  const after = api.findMap(api.getWorld(), map.id);
  assert.ok(after.subdivisions.length > 0);
  // 墙穿过 y=1..4 两行，落在这两行对应的主格上
  assert.ok(after.subdivisions.includes(0));
  assert.ok(after.subdivisions.includes(10));
  const wall = api.architectureWalls(after)[0];
  assert.ok(wall);
  assert.equal(api.wallCovered(after, wall), true);
  assert.doesNotThrow(() => api.checkArchitecture(after));
});

test('玻璃墙同样自动细分', () => {
  const { map } = fixture();
  const error = api.addArchitectureWall(map.id, { x: 6, y: 0 }, { x: 6, y: 9 }, 'glass', 120);
  assert.equal(error, null);
  const after = api.findMap(api.getWorld(), map.id);
  assert.ok(after.subdivisions.length >= 3);
  assert.doesNotThrow(() => api.checkArchitecture(after));
});

test('已经细分过的区域不会重复添加', () => {
  const { map } = fixture();
  assert.equal(api.subdivideRegion(map.id, { x: 0, y: 0, w: 10, h: 10 }), null);
  const before = api.findMap(api.getWorld(), map.id).subdivisions.length;
  const error = api.addArchitectureWall(map.id, { x: 3, y: 1 }, { x: 3, y: 4 }, 'wall', 120);
  assert.equal(error, null);
  const after = api.findMap(api.getWorld(), map.id);
  assert.equal(after.subdivisions.length, before);
});

test('非细分墙（普通地形墙）不受影响', () => {
  const { map } = fixture();
  api.paintCells?.(map.id, { x: 1, y: 1, w: 1, h: 1 }, 'wall');
  const after = api.findMap(api.getWorld(), map.id);
  assert.equal(after.subdivisions.length, 0);
});
