import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-anchor-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/scene/architecture'; export * from './src/core/defaults'; export * from './src/core/schema.js'; export * from './src/runtime/actions';`, resolveDir: root },
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

test('物件实际矩形：锚点按 1/3 格偏移，尺寸不变', () => {
  const r = api.objectRect({ x: 1, y: 1, w: 2, h: 1, anchor: { x: 2, y: 1 } });
  assert.ok(Math.abs(r.x - (1 + 2 / 3)) < 1e-9);
  assert.ok(Math.abs(r.y - (1 + 1 / 3)) < 1e-9);
  assert.equal(r.w, 2); assert.equal(r.h, 1);
  assert.deepEqual(api.objectRect({ x: 3, y: 4, w: 1, h: 1 }), { x: 3, y: 4, w: 1, h: 1 });
});

test('指针位置换算成锚点 0/1/2', () => {
  assert.deepEqual(api.anchorFromPoint({ x: 5.1, y: 2.2 }), { x: 0, y: 0 });
  assert.deepEqual(api.anchorFromPoint({ x: 5.4, y: 2.5 }), { x: 1, y: 1 });
  assert.deepEqual(api.anchorFromPoint({ x: 5.9, y: 2.99 }), { x: 2, y: 2 });
});

function fixture() {
  const world = api.emptyWorld();
  const map = api.newMap('测试', '测试', 0, 10, 10, 'floor', false);
  map.autoFog = false;
  map.objects = [];
  world.maps = [map];
  return { world, map };
}

test('带锚点的物件按实际矩形挡路（旧的整格判定会漏）', () => {
  const { world, map } = fixture();
  const o = api.newObject('object', 2, 2, 1, 1);
  o.height = 1; o.anchor = { x: 0, y: 2 };
  map.objects = [o];
  // y=2.2 的一条横向路径：整格占位（2..3）会挡，锚点下移 2/3 后（2.67..3.67）不挡
  assert.equal(api.characterPathClear(world, map, { x: 2.2, y: 2.2 }, { x: 3.2, y: 2.2 }), true);
  o.anchor = undefined;
  assert.equal(api.characterPathClear(world, map, { x: 2.2, y: 2.2 }, { x: 3.2, y: 2.2 }), false);
});

test('锚点让物件能贴到 1/3 格：x=2.7 处挡住', () => {
  const { world, map } = fixture();
  const o = api.newObject('object', 2, 2, 1, 1);
  o.height = 1; o.anchor = { x: 2, y: 0 };
  map.objects = [o];
  // 物件实际占 2.67..3.67；路径贴着 3.0 走会被扫到
  assert.equal(api.characterPathClear(world, map, { x: 3.1, y: 2.1 }, { x: 3.1, y: 2.9 }), false);
});

test('校验：锚点只能是 0/1/2，且不能把物件推出地图', () => {
  const { world, map } = fixture();
  const o = api.newObject('object', 2, 2, 1, 1);
  o.anchor = { x: 1, y: 1 };
  map.objects = [o];
  assert.doesNotThrow(() => api.checkWorld(world));

  o.anchor = { x: 3, y: 0 };
  assert.throws(() => api.checkWorld(world), /anchor/);

  o.anchor = { x: 1, y: 0 }; o.x = 9; // 宽 1 格贴到右边界，再偏移就出图
  assert.throws(() => api.checkWorld(world), /推出地图/);
});
