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
  stdin: { contents: `export * from './src/scene/sight'; export { sightCtxFor } from './src/scene/sightIndex'; export { architectureGeometry } from './src/scene/architecture'; export { pcWithin } from './src/scene/perception';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const { eyeHeight, coneFor, cellSightCost, canSee, inCone, visionOf, visiblePoint, sightCacheFor, sightCtxFor, VISION_BUDGET, BASE_CELL_COST, objectSightCost, architectureGeometry, pcWithin } = await import(bundle);
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

test('过滤目标自身几何时，墙索引也排除自己的构件', () => {
  const map = mkMap(14, 8);
  // 建筑的 a/b 是 1/3 格坐标：x=4.5 是第 1.5 格，x=7.5 是第 2.5 格。
  map.architecture = { walls: [
    { id: 'w1', a: { x: 4.5, y: 6 }, b: { x: 4.5, y: 21 }, thickness: 0.25, material: 'wall' },
    { id: 'w2', a: { x: 7.5, y: 6 }, b: { x: 7.5, y: 21 }, thickness: 0.25, material: 'wall' },
  ], doors: [] };
  const eye = { x: 0.5, y: 4, sex: '男' };
  const cache = sightCacheFor(world, map, eye, sightCtxFor(world, map));
  const geometry = architectureGeometry(map, true);
  const filtered = geometry.filter((r) => r.objectId !== 'w1');
  const target = { x: 2.5, y: 4 }; // 站在 w2 上，视线要先穿过同一目标物件的 w1
  assert.equal(visiblePoint(world, map, eye, target, filtered, cache), true, '过滤几何路径应该看得见');
  assert.equal(visiblePoint(world, map, eye, target, undefined, cache, { excludeObjectId: 'w1' }), true, '索引路径排除 w1 后应该看得见');
  assert.equal(visiblePoint(world, map, eye, target, undefined, cache), false, '不排除时 w1 会挡住');
});

test('共用 ctx 的 SightCache 带几何和墙索引，点判定结果不变', () => {
  const map = mkMap(12, 9);
  map.architecture = { walls: [{ id: 'w1', a: { x: 4.5, y: 2 }, b: { x: 4.5, y: 7 }, thickness: 0.25, material: 'wall' }], doors: [] };
  const eye = { x: 1, y: 1, sex: '男', facing: '东' };
  const cache = sightCacheFor(world, map, eye, sightCtxFor(world, map));
  assert.ok(cache.geometry && cache.walls, '带 ctx 的 cache 应该复用几何和墙索引');
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
    const t = { x: x + 0.5, y: y + 0.5 };
    assert.equal(visiblePoint(world, map, eye, t, undefined, cache), visiblePoint(world, map, eye, t), `(${x}, ${y})`);
  }
});

function pcFixture() {
  const w = { ...world, party: [{ id: 'p', name: '甲', sex: '男', heightCm: 173, color: '' }] };
  return w;
}

test('开着的门仍然看得见：cache 几何不包含 opened door 的构件', () => {
  for (const state of [0, 1]) {
    const map = mkMap(20, 10);
    map.architecture = { walls: [{ id: 'w1', a: { x: 9, y: 6 }, b: { x: 9, y: 27 }, thickness: 0.25, material: 'wall' }], doors: [] };
    map.tokens = [{ id: 't1', pcId: 'p', name: '甲', color: '', x: 1, y: 4 }];
    map.objects = [{
      id: 'd1', kind: 'object', name: '门', x: 2, y: 3, w: 2, h: 2, height: 2.4, color: '', icon: '',
      states: ['关闭', '打开'], state, opening: { wallId: 'w1', offset: 6, width: 6, openStates: [1] },
    }];
    const w = pcFixture();
    const eye = { x: 1.5, y: 4.5, sex: '男' };
    const cache = sightCacheFor(w, map, eye, sightCtxFor(w, map));
    const hit = pcWithin(w, map, map.objects[0], 30, cache);
    assert.equal(hit?.id, 't1', state === 1 ? '开着的门应该看得见' : '关着的门应该看得见');
  }
});

test('玻璃不挡“看见建筑本身”：索引路径保持旧过滤口径', () => {
  const map = mkMap(25, 8);
  map.tokens = [{ id: 't1', pcId: 'p', name: '甲', color: '', x: 1, y: 4 }];
  map.architecture = { walls: [12, 18, 24, 30, 36, 42].map((x, i) => ({
    id: 'glass' + i, a: { x, y: 6 }, b: { x, y: 21 }, thickness: 0.25, material: 'glass',
  })), doors: [] };
  map.objects = [{
    id: 'target', kind: 'object', name: '目标墙', x: 3, y: 3, w: 2, h: 2, height: 2.4, color: '', icon: '',
    states: ['固定'], state: 0,
    geometry: { kind: 'wall', a: { x: 45, y: 6 }, b: { x: 45, y: 21 }, thickness: 0.25, material: 'wall' },
  }];
  const w = pcFixture();
  const eye = { x: 1.5, y: 4.5, sex: '男' };
  const cache = sightCacheFor(w, map, eye, sightCtxFor(w, map));
  const hit = pcWithin(w, map, map.objects[0], 30, cache);
  assert.equal(hit?.id, 't1', '六面玻璃不该把建筑本身的可见性累加掉');
});

test('SightCache 在边界/整点上也一致', () => {
  const map = mkMap(12, 9);
  map.architecture = { walls: [{ id: 'w1', a: { x: 4.5, y: 2 }, b: { x: 4.5, y: 7 }, thickness: 0.25, material: 'wall' }], doors: [] };
  const eye = { x: 1.5, y: 4.5, sex: '男' };
  const cache = sightCacheFor(world, map, eye, sightCtxFor(world, map));
  const points = [
    { x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 11, y: 8 }, { x: 11.5, y: 8.5 },
    { x: 6, y: 4 }, { x: 6.5, y: 4 }, { x: 6, y: 4.5 }, { x: 0, y: 8 },
    { x: 12, y: 8 }, { x: 11, y: 9 },
  ];
  for (const t of points) {
    assert.equal(visiblePoint(world, map, eye, t, undefined, cache), visiblePoint(world, map, eye, t), `(${t.x}, ${t.y})`);
  }
});

test('SightCache 在墙分桶边界也一致', () => {
  const map = mkMap(20, 20);
  // 建筑坐标是 1/3 格：x=24 就是第 8 格，正好落在 8 格分桶边界上。
  map.architecture = { walls: [{ id: 'w1', a: { x: 24, y: 6 }, b: { x: 24, y: 60 }, thickness: 0.25, material: 'wall' }], doors: [] };
  const eye = { x: 1.5, y: 10, sex: '男' };
  const cache = sightCacheFor(world, map, eye, sightCtxFor(world, map));
  assert.ok(cache.walls, '跨桶测试必须有墙索引');
  for (const t of [
    { x: 7.5, y: 10 }, { x: 8, y: 10 }, { x: 8.5, y: 10 },
    { x: 7.5, y: 8 }, { x: 8, y: 8 }, { x: 8.5, y: 8 },
    { x: 7.5, y: 12 }, { x: 8, y: 12 }, { x: 8.5, y: 12 },
  ]) {
    assert.equal(visiblePoint(world, map, eye, t, undefined, cache), visiblePoint(world, map, eye, t), `(${t.x}, ${t.y})`);
  }
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


test('部分小格墙、其余空白：整格不按 99，但空白小格也挡视线', () => {
  const map = mkMap(20, 3);
  setFine(map, 4, 1, '');
  map.fineCells[(1 * 3 + 0) * map.width * 3 + 4 * 3] = 'wall'; // 上排左 1/3 墙
  const cost = cellSightCost(world, map, 1.6);
  assert.ok(Math.abs(cost[1 * map.width + 4] - 0.1) < 1e-6, '没有整格 99');
  // 中间那条是空白小格；按“空白=墙”的新口径，射线不能穿过。
  assert.equal(visiblePoint(world, map, { x: 1, y: 1, sex: '男' }, { x: 7.5, y: 1.5 }), false);
});

test('空白/未登记的大格和 9 个空小格都挡视线', () => {
  const map = mkMap(20, 3);
  map.cells[1 * map.width + 4] = '';
  for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) map.fineCells[(1 * 3 + sy) * map.width * 3 + 4 * 3 + sx] = '';
  const cost = cellSightCost(world, map, 1.6);
  assert.ok(cost[1 * map.width + 4] >= 99);
  assert.equal(visiblePoint(world, map, { x: 1, y: 1, sex: '男' }, { x: 7.5, y: 1.5 }), false);

  map.cells[1 * map.width + 4] = 'void'; // 未登记 id
  for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) map.fineCells[(1 * 3 + sy) * map.width * 3 + 4 * 3 + sx] = 'void';
  assert.ok(cellSightCost(world, map, 1.6)[1 * map.width + 4] >= 99);
  assert.equal(visiblePoint(world, map, { x: 1, y: 1, sex: '男' }, { x: 7.5, y: 1.5 }), false);
});


test('混合小格仍按整格多数派（整格一个系数，不做 1/3 累加）', () => {
  const grassFloor = mkMap(20, 3);
  setTerrain(grassFloor, 4, 1, 'floor');
  grassFloor.fineCells[(1 * 3 + 0) * grassFloor.width * 3 + 4 * 3] = 'grass';
  assert.ok(Math.abs(cellSightCost(world, grassFloor, 1.6)[1 * grassFloor.width + 4] - 0.1) < 1e-6);

  const floorGrass = mkMap(20, 3);
  setTerrain(floorGrass, 4, 1, 'grass');
  floorGrass.fineCells[(1 * 3 + 0) * floorGrass.width * 3 + 4 * 3] = 'floor';
  assert.ok(Math.abs(cellSightCost(world, floorGrass, 1.6)[1 * floorGrass.width + 4] - 0.8) < 1e-6);

  const windowFloor = mkMap(20, 3);
  setTerrain(windowFloor, 4, 1, 'floor');
  windowFloor.fineCells[(1 * 3 + 0) * windowFloor.width * 3 + 4 * 3] = 'window';
  assert.ok(Math.abs(cellSightCost(world, windowFloor, 1.6)[1 * windowFloor.width + 4] - 0.1) < 1e-6);
});

test('8 小墙 + 1 空 / 1 未登记，墙和空格分别精确挡', () => {
  for (const tail of ['', 'void']) {
    const map = mkMap(20, 3);
    // 大格 (4,1) 中间一排全空，上下两排各 3 + 2 个墙；共 8 墙 + 1 空/未登记。
    for (let sx = 0; sx < 3; sx++) map.fineCells[(1 * 3 + 0) * map.width * 3 + 4 * 3 + sx] = 'wall';
    for (let sx = 0; sx < 3; sx++) map.fineCells[(1 * 3 + 2) * map.width * 3 + 4 * 3 + sx] = 'wall';
    for (let sx = 0; sx < 2; sx++) map.fineCells[(1 * 3 + 1) * map.width * 3 + 4 * 3 + sx] = 'wall';
    map.fineCells[(1 * 3 + 1) * map.width * 3 + 4 * 3 + 2] = tail;
    assert.ok(Math.abs(cellSightCost(world, map, 1.6)[1 * map.width + 4] - 0.1) < 1e-6);
    assert.equal(visiblePoint(world, map, { x: 1, y: 1, sex: '男' }, { x: 7.5, y: 1.5 }), false, tail || '空');
  }

  const wallBase = mkMap(20, 3);
  setTerrain(wallBase, 4, 1, 'wall');
  wallBase.fineCells[(1 * 3 + 1) * wallBase.width * 3 + 4 * 3] = '';
  assert.ok(cellSightCost(world, wallBase, 1.6)[1 * wallBase.width + 4] >= 99);
});


test('floor 大格 9 小格全擦空：整格按墙算', () => {
  const map = mkMap(20, 3);
  setFine(map, 4, 1, '');
  const cost = cellSightCost(world, map, 1.6);
  assert.ok(cost[1 * map.width + 4] >= 99);
  assert.equal(visiblePoint(world, map, { x: 1, y: 1, sex: '男' }, { x: 7.5, y: 1.5 }), false);
});

test('目标点落在空白子格：不可见；空白不在射线上的 floor 子格仍可见', () => {
  const targetBlank = mkMap(20, 3);
  targetBlank.fineCells[(1 * 3 + 1) * targetBlank.width * 3 + 4 * 3] = '';
  assert.equal(visiblePoint(world, targetBlank, { x: 1, y: 1, sex: '男' }, { x: 4.1, y: 1.5 }), false);

  const offRay = mkMap(20, 3);
  offRay.fineCells[(1 * 3 + 0) * offRay.width * 3 + 4 * 3] = ''; // 上排空白，射线走中间 floor
  assert.equal(visiblePoint(world, offRay, { x: 1, y: 1, sex: '男' }, { x: 4.1, y: 1.5 }), true);
});
