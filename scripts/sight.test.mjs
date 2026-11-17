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
const { eyeHeight, coneFor, cellSightCost, canSee, inCone, visionOf, visiblePoint, sightCacheFor, VISION_BUDGET, BASE_CELL_COST, objectSightCost } = await import(bundle);
after(() => rm(temp, { recursive: true, force: true }));

const world = { terrains: [
  { id: 'floor', name: '地板', visionCoef: 0.1, blocksMove: false, color: '' },
  { id: 'grass', name: '草丛', visionCoef: 0.8, blocksMove: false, color: '' },
  { id: 'wall', name: '墙', visionCoef: 99, blocksMove: true, color: '' },
  { id: 'window', name: '窗', visionCoef: 0.5, blocksMove: true, color: '' },
  { id: 'hole', name: '洞', visionCoef: 0, blocksMove: true, color: '' },
] };
const mkMap = (w, h, fill = 'floor') => ({
  id: 'm', width: w, height: h,
  cells: new Array(w * h).fill(fill),
  fineCells: new Array(w * h * 9).fill(fill),
  d100: new Array(w * h).fill(0),
  objects: [], tokens: [], architecture: { walls: [], doors: [] },
});
const setTerrain = (map, x, y, id) => {
  map.cells[y * map.width + x] = id;
  setFine(map, x, y, id);
};
const setFine = (map, x, y, id) => {
  for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) map.fineCells[(y * 3 + sy) * map.width * 3 + x * 3 + sx] = id;
};

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
  setTerrain(map, 5, 1, 'grass');
  const cost = cellSightCost(world, map, 1.6);
  assert.ok(Math.abs(cost[1 * 20 + 5] - 0.8) < 1e-6); // Float32
  // 到 5 格：0.1×4 + 0.8 = 1.2，还够；到 8 格：+0.3 = 1.5，够；到 9 格：1.6 超
  assert.equal(canSee(cost, 20, 0, 1, 5, 1), true);
  assert.equal(canSee(cost, 20, 0, 1, 8, 1), true);
  assert.equal(canSee(cost, 20, 0, 1, 9, 1), false);
});

test('墙挡死，墙后一格都看不见', () => {
  const map = mkMap(20, 3);
  setTerrain(map, 3, 1, 'wall');
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

test('小格视野：挡死小块按 1/3 细化，衰减仍按整格', () => {
  const map = mkMap(20, 3);
  const key = 4 * 60 + 15; // 第 5 格中间那排、左边 1/3
  map.fineCells[key] = 'wall';
  const eye = { x: 1, y: 1, sex: '男' };
  assert.equal(visiblePoint(world, map, eye, { x: 7.5, y: 1.5 }), false);
  assert.equal(visiblePoint(world, map, eye, { x: 3.5, y: 1.5 }), true); // 墙前
  // 墙挪到下面一排，同一水平线就不再挡
  map.fineCells[key] = 'floor';
  map.fineCells[5 * 60 + 15] = 'wall';
  assert.equal(visiblePoint(world, map, eye, { x: 7.5, y: 1.5 }), true);
});

test('SightCache 与逐次建表逐点一致（带物件、小格、朝向）', () => {
  const map = mkMap(12, 9);
  map.objects = [{ id: 'o1', name: '箱子', kind: 'object', x: 3, y: 3, w: 2, h: 1, height: 1.4, color: '', icon: '', secrets: [], states: [], state: '', tags: [] }];
  // 4*36+13 → 主格 (4,1) 的中间子格。
  map.fineCells[4 * 36 + 13] = 'wall';
  const eye = { x: 1, y: 1, sex: '男', facing: '东' };
  // 绝对断言：这面墙后面的点子格挡死 → 一定看不见
  assert.equal(visiblePoint(world, map, eye, { x: 5.5, y: 1.5 }), false, '子格挡死后面必须看不见');
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


test('大格底是墙、9 小格全画成 floor：衰减按小格降回基线，不挡自己', () => {
  const map = mkMap(10, 3);
  setTerrain(map, 2, 1, 'wall'); // cells + fineCells 先都写成墙
  // 再把这一大格的 9 个小格改回 floor；base 仍是墙。
  for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
    map.fineCells[(1 * 3 + sy) * map.width * 3 + 2 * 3 + sx] = 'floor';
  }
  const cost = cellSightCost(world, map, 1.6);
  assert.ok(Math.abs(cost[1 * map.width + 2] - 0.1) < 1e-6);
  const eye = { x: 2, y: 1, sex: '男' };
  assert.equal(visiblePoint(world, map, eye, { x: 2.5, y: 1.5 }), true);
  assert.equal(visiblePoint(world, map, eye, { x: 3.5, y: 1.5 }), true);
});


test('多数小格是墙，但射线穿的是中间 floor 小格：不能被整格 99 挡死', () => {
  const map = mkMap(20, 3);
  // 大格 (4,1)：上排 3 + 下排 2 个 1/3 墙，中间一排 3 个 floor；base 仍是 floor。
  for (let sx = 0; sx < 3; sx++) map.fineCells[(1 * 3 + 0) * map.width * 3 + 4 * 3 + sx] = 'wall';
  for (let sx = 0; sx < 2; sx++) map.fineCells[(1 * 3 + 2) * map.width * 3 + 4 * 3 + sx] = 'wall';
  const cost = cellSightCost(world, map, 1.6);
  assert.ok(Math.abs(cost[1 * map.width + 4] - 0.1) < 1e-6, '有 floor 通道时整格应取 0.1');
  assert.equal(visiblePoint(world, map, { x: 1, y: 1, sex: '男' }, { x: 7.5, y: 1.5 }), true);
});


test('base 是墙时，窗/洞按自己的视线系数，不按墙挡死', () => {
  const map = mkMap(20, 3);
  setTerrain(map, 4, 1, 'wall');
  setFine(map, 4, 1, 'window');
  let cost = cellSightCost(world, map, 1.6);
  assert.ok(Math.abs(cost[1 * map.width + 4] - 0.5) < 1e-6);
  assert.equal(visiblePoint(world, map, { x: 1, y: 1, sex: '男' }, { x: 7.5, y: 1.5 }), true);

  setFine(map, 4, 1, 'hole');
  cost = cellSightCost(world, map, 1.6);
  assert.ok(Math.abs(cost[1 * map.width + 4] - 0.1) < 1e-6);
  assert.equal(visiblePoint(world, map, { x: 1, y: 1, sex: '男' }, { x: 7.5, y: 1.5 }), true);
});

test('草地大格里混一个 floor 小格，整格衰减仍是草地', () => {
  const map = mkMap(20, 3);
  setTerrain(map, 4, 1, 'grass');
  map.fineCells[(1 * 3 + 1) * map.width * 3 + 4 * 3 + 1] = 'floor';
  const cost = cellSightCost(world, map, 1.6);
  assert.ok(Math.abs(cost[1 * map.width + 4] - 0.8) < 1e-6);
});

test('base floor + 9 小格全墙时整格按挡死算', () => {
  const map = mkMap(20, 3);
  setFine(map, 4, 1, 'wall');
  const cost = cellSightCost(world, map, 1.6);
  assert.ok(Math.abs(cost[1 * map.width + 4] - 99) < 1e-6);
});


test('部分小格墙、其余空格：整格不按挡死，墙只精确挡那 1/3', () => {
  const map = mkMap(20, 3);
  setFine(map, 4, 1, '');
  map.fineCells[(1 * 3 + 0) * map.width * 3 + 4 * 3] = 'wall'; // 上排左 1/3 墙，中间射线走 floor 空格
  const cost = cellSightCost(world, map, 1.6);
  assert.ok(Math.abs(cost[1 * map.width + 4] - 0.1) < 1e-6);
  assert.equal(visiblePoint(world, map, { x: 1, y: 1, sex: '男' }, { x: 7.5, y: 1.5 }), true);
});
