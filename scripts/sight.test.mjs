import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-sight-test-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/scene/sight';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const { eyeHeight, coneFor, cellSightCost, canSee, inCone, visionOf, visionDetailOf, visiblePoint, sightCacheFor, VISION_BUDGET, BASE_CELL_COST, objectSightCost } = await import(bundle);
after(() => rm(temp, { recursive: true, force: true }));

const world = { terrains: [
  { id: 'floor', name: '地板', visionCoef: 0.1, blocksMove: false, color: '' },
  { id: 'grass', name: '草丛', visionCoef: 0.8, blocksMove: false, color: '' },
  { id: 'wall', name: '墙', visionCoef: 99, blocksMove: true, color: '' },
] };
const mkMap = (w, h, fill = 'floor') => ({
  id: 'm', width: w, height: h,
  cells: new Array(w * h).fill(fill),
  d100: new Array(w * h).fill(0),
  objects: [], tokens: [], architecture: { walls: [], doors: [] },
});

test('眼高：男 173、女 164 按 0.93 折算；蹲趴锁死', () => {
  assert.equal(eyeHeight({ sex: '男' }), 1.61);
  assert.equal(eyeHeight({ sex: '女' }), 1.53);
  assert.equal(eyeHeight({ heightCm: 190 }), 1.77);
  assert.equal(eyeHeight({ stance: '蹲', sex: '男' }), 0.9);
  assert.equal(eyeHeight({ stance: '趴' }), 0.3);
  // 坐跟蹲一样高；躺下就是趴
  assert.equal(eyeHeight({ stance: '坐', sex: '男' }), 0.9);
});

test('空地 15 格看得见，第 16 格看不见（预算 1.56，每格 0.1）', () => {
  const map = mkMap(20, 3);
  const cost = cellSightCost(world, map, 1.6);
  assert.equal(canSee(cost, map.width, 0, 1, 15, 1), true);   // 15 步 × 0.1 = 1.5 ≤ 1.56
  assert.equal(canSee(cost, map.width, 0, 1, 16, 1), false);  // 16 步 = 1.6 > 1.56
  assert.equal(VISION_BUDGET, 1.56);
  assert.equal(BASE_CELL_COST, 0.1);
});

test('草丛一格 0.8：视线在它后面很快就断', () => {
  const map = mkMap(20, 3);
  map.cells[1 * 20 + 5] = 'grass';
  const cost = cellSightCost(world, map, 1.6);
  assert.ok(Math.abs(cost[1 * 20 + 5] - 0.8) < 1e-6); // Float32
  // 到 5 格：0.1×4 + 0.8 = 1.2，还够；到 8 格：+0.3 = 1.5，够；到 9 格：1.6 超
  assert.equal(canSee(cost, 20, 0, 1, 5, 1), true);
  assert.equal(canSee(cost, 20, 0, 1, 8, 1), true);
  assert.equal(canSee(cost, 20, 0, 1, 9, 1), false);
});

test('墙挡死，墙后一格都看不见', () => {
  const map = mkMap(20, 3);
  map.cells[1 * 20 + 3] = 'wall';
  const cost = cellSightCost(world, map, 1.6);
  assert.equal(canSee(cost, 20, 0, 1, 3, 1), false);
  assert.equal(canSee(cost, 20, 0, 1, 4, 1), false);
});

test('物件按身高折算：桌子挡一部分，墙高挡死', () => {
  const eye = 1.6;
  const table = { id: 't', kind: 'object', name: '桌', x: 0, y: 0, w: 1, h: 1, height: 0.75, color: '', icon: '', states: ['正常'], state: 0, notes: '', hidden: false, secrets: [], media: [], enabled: true };
  const tall = { ...table, id: 'w', height: 2.4 };
  const low = { ...table, id: 'l', height: 0.2 };
  assert.ok(objectSightCost(table, eye) > 0 && objectSightCost(table, eye) < 99);
  assert.equal(objectSightCost(tall, eye), 99);
  assert.ok(objectSightCost(low, eye) < objectSightCost(table, eye));
  // 显式系数优先
  assert.equal(objectSightCost({ ...table, sightCost: 0.5 }, eye), 0.5);
});

test('D100 区收窄到 60°，D20 区 120°', () => {
  const map = mkMap(10, 10);
  assert.equal(coneFor(map, 5, 5), 120);
  map.d100[5 * 10 + 5] = 1;
  assert.equal(coneFor(map, 5, 5), 60);
});

test('锥形：朝北看不到身后', () => {
  assert.equal(inCone('北', 5, 5, 5, 3, 120), true);
  assert.equal(inCone('北', 5, 5, 5, 7, 120), false);   // 正后方
  assert.equal(inCone('北', 5, 5, 6, 7, 120), false);   // 南侧
  assert.equal(inCone('北', 5, 5, 6, 4, 120), true);    // 东北 45°
  assert.equal(inCone('北', 5, 5, 5, 5, 60), true);     // 同格
  assert.equal(inCone('北', 5, 5, 6, 4, 60), false);    // 45° 超出 60° 锥的半角 30°
});

test('visionOf：锥形 + 预算一起生效', () => {
  const map = mkMap(20, 20);
  const vis = visionOf(world, map, { x: 10, y: 10, facing: '北', sex: '男' });
  assert.equal(vis[9 * 20 + 10], 1);   // 北 1 格
  assert.equal(vis[12 * 20 + 10], 0);  // 南 2 格，在身后
  assert.equal(vis[10 * 20 + 10], 1);  // 自己那格
});

test('子格视野：衰减仍按整格，只有挡死小块按 1/3 细化', () => {
  const map = mkMap(20, 3);
  map.subdivisions = [1 * 20 + 5, 1 * 20 + 6];
  map.subCells = { [4 * 60 + 15]: 'wall' }; // 第 5 格中间那排、左边 1/3
  const eye = { x: 1, y: 1, sex: '男' };
  assert.equal(visiblePoint(world, map, eye, { x: 7.5, y: 1.5 }), false);
  assert.equal(visiblePoint(world, map, eye, { x: 3.5, y: 1.5 }), true); // 墙前
  const detail = visionDetailOf(world, map, eye);
  assert.equal(detail.sub[4 * 60 + 19], 0); // 墙后面的 1/3 小格
  // 墙挪到下面一排，同一水平线就不再挡
  map.subCells[5 * 60 + 15] = 'wall';
  delete map.subCells[4 * 60 + 15];
  assert.equal(visiblePoint(world, map, eye, { x: 7.5, y: 1.5 }), true);
});

test('SightCache 与逐次建表逐点一致（带物件、细分格、朝向）', () => {
  const map = mkMap(12, 9);
  map.objects = [{ id: 'o1', name: '箱子', kind: 'object', x: 3, y: 3, w: 2, h: 1, height: 1.4, color: '', icon: '', secrets: [], states: [], state: '', tags: [] }];
  map.subdivisions = [1 * 12 + 4, 2 * 12 + 5];
  map.subCells = { [4 * 36 + 15]: 'wall' };
  const eye = { x: 1, y: 1, sex: '男', facing: '东' };
  const cache = sightCacheFor(world, map, eye);
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
    const t = { x: x + 0.5, y: y + 0.5 };
    assert.equal(visiblePoint(world, map, eye, t, undefined, cache), visiblePoint(world, map, eye, t), `(${x}, ${y})`);
  }
});

test('越界点一律不可见：不再读到下一行第一格', () => {
  const map = mkMap(6, 6);
  const eye = { x: 5, y: 5 };
  assert.equal(visiblePoint(world, map, eye, { x: 6, y: 5 }), false);
  assert.equal(visiblePoint(world, map, eye, { x: 5, y: 6 }), false);
  assert.equal(visiblePoint(world, map, eye, { x: 3, y: 6 }), false);
});
