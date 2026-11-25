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
  stdin: { contents: `export * from './src/scene/terrain'; export * from './src/scene/architecture'; export * from './src/core/defaults'; export * from './src/core/grid'; export * from './src/core/schema.js'; export * from './src/runtime/actions'; export * from './src/core/store'; export * from './src/runtime/sync'; export * from './src/scene/memory'; export * from './src/scene/render'; export * from './src/runtime/importRabbithole';`, resolveDir: root },
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

test('小格地形：完整数组，读小格；没有覆盖就退回大格底', () => {
  const { map } = fixture();
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.fineCells.length, m.width * m.height * 9);
  assert.equal(api.terrainAtSubcell(m, 6, 6), 'floor');
  api.paintTerrainSubcells(map.id, [[6, 6]], 'grass');
  const after = api.findMap(api.getWorld(), map.id);
  assert.equal(api.terrainAtSubcell(after, 6, 6), 'grass');
  assert.equal(api.terrainAtSubcell(after, 7, 6), 'floor');
  assert.equal(after.subdivisions, undefined);
  assert.equal(after.subCells, undefined);
});

test('小格画笔不需要先细分，也不会产生旧字段', () => {
  const { map } = fixture();
  api.paintTerrainSubcells(map.id, [[21, 21]], 'grass'); // 主格 (7,7)
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(api.terrainAtSubcell(m, 21, 21), 'grass');
  assert.equal(m.cells[7 * m.width + 7], 'floor'); // 大格底仍是规则层的值
  assert.equal(m.subdivisions, undefined);
  assert.equal(m.subCells, undefined);
  assert.equal(m.subFog, undefined);
});

test('大格画笔把整格 3×3 小格一起铺成新地形', () => {
  const { map } = fixture();
  api.paintTerrainSubcells(map.id, [[6, 6]], 'grass');
  api.paintTerrainCells(map.id, [[2, 2]], 'rug');
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.cells[2 * m.width + 2], 'rug');
  for (let sy = 6; sy < 9; sy++) for (let sx = 6; sx < 9; sx++) assert.equal(api.terrainAtSubcell(m, sx, sy), 'rug');
});

test('不可通行的小格地形按 1/3 小格挡路', () => {
  const { world, map } = fixture();
  api.paintTerrainSubcells(map.id, [[7, 7]], 'wall'); // 主格 (2,2) 的中间小格
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(api.characterPathClear(world, m, { x: 2.2, y: 2.2 }, { x: 3.8, y: 2.2 }), false);
  assert.equal(api.characterPathClear(world, m, { x: 1.5, y: 1.5 }, { x: 3.5, y: 1.5 }), true);
});

test('空白地形仍然算不可通行（和旧规则一致）', () => {
  const { world, map } = fixture();
  api.paintTerrainCells(map.id, [[3, 3]], null);
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(api.terrainBlocksPoint(world, m, 3.5, 3.5), true);
  assert.equal(api.characterPathClear(world, m, { x: 3.5, y: 3.5 }, { x: 3.5, y: 3.5 }), false);
});

test('存档校验要求完整 fineCells，并接受任意小格地形', () => {
  const good = api.emptyWorld();
  const gm = api.newMap('好图', '测试', 0, 10, 10, 'floor', false); gm.objects = [];
  gm.fineCells[api.fineKeyOf(gm, 12, 12)] = 'grass';
  good.maps = [gm];
  assert.doesNotThrow(() => api.checkWorld(good));

  const bad = api.emptyWorld();
  const bm = api.newMap('坏图', '测试', 0, 10, 10, 'floor', false); bm.objects = [];
  delete bm.fineCells;
  bad.maps = [bm];
  assert.throws(() => api.checkWorld(bad), /fineCells/);
});

test('改地图尺寸时小格地形跟着平移', () => {
  const { map } = fixture();
  api.paintTerrainSubcells(map.id, [[12, 9]], 'grass'); // 主格 (4,3)
  api.resizeMap(map.id, 12, 10);
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(api.terrainAtSubcell(m, 12, 9), 'grass');
  assert.equal(api.terrainAtSubcell(m, 15, 9), 'floor');
});

test('点亮后记忆仍按大格记地形', () => {
  const { map } = fixture();
  api.paintTerrainSubcells(map.id, [[6, 6]], 'grass');
  api.giveMapKnowledge(map.id);
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.seen.cells[2 * m.width + 2], 'floor');
  assert.equal(m.seen.subCells, undefined);
});

test('玩家同步只带看得见的小格地形；变灰后只带大格记忆', () => {
  const { map } = fixture();
  api.update((d) => { const m = api.findMap(d, map.id); m.fog = m.fog.map(() => 1); });
  api.paintTerrainSubcells(map.id, [[6, 6]], 'grass');
  const m = api.findMap(api.getWorld(), map.id);
  const key = api.fineKeyOf(m, 6, 6);
  const pm = api.playerMap(m, { fog: m.fog, seen: m.seen });
  assert.equal(pm.fineCells[key], 'grass');
  const pw = api.playerWorld(api.getWorld(), map.id);
  assert.ok(pw.terrains.some((t) => t.id === 'grass'));

  api.update((d) => { const mm = api.findMap(d, map.id); mm.fog[2 * mm.width + 2] = 2; });
  const m2 = api.findMap(api.getWorld(), map.id);
  const pm2 = api.playerMap(m2, { fog: m2.fog, seen: m2.seen });
  assert.equal(pm2.fineCells[key], '');
  assert.equal(pm2.seen.cells[2 * m2.width + 2], 'floor');
});

test('v1 存档（粗格 + 稀疏子格）迁移成完整 fineCells，并丢掉旧字段', () => {
  const w = api.emptyWorld();
  w.version = 1;
  const m = api.newMap('旧图', '测试', 0, 10, 10, 'floor', false); m.objects = [];
  delete m.fineCells;
  m.subdivisions = [2 * 10 + 2];
  m.subCells = {
    [api.fineKeyOf(m, 6, 6)]: 'grass', // 父格 (2,2) 在 subdivisions 里，保留
    [api.fineKeyOf(m, 0, 0)]: 'wall',  // 父格 (0,0) 不在列表里：取消细分后的孤儿键，丢掉
  };
  m.materialSubCells = {
    [api.fineKeyOf(m, 6, 6)]: 'wood',
    [api.fineKeyOf(m, 21, 21)]: 'stone', // 父格 (7,7) 不在列表里，丢掉
  };
  m.seen.observed = {
    [api.fineKeyOf(m, 6, 6)]: 7, // 父格 (2,2) 有效
    [api.fineKeyOf(m, 21, 21)]: 8, // 父格 (7,7) 孤儿
  };
  m.seen.architectureRevs = { ...m.seen.observed };
  m.seen.observed['nope'] = 9; // 坏 key 也要清掉
  w.maps = [m];
  const migrated = api.migrateWorld(w);
  const mm = migrated.maps[0];
  assert.equal(migrated.version, 3);
  assert.equal(mm.fineCells.length, mm.width * mm.height * 9);
  assert.equal(api.terrainAtSubcell(mm, 6, 6), 'grass');
  assert.equal(api.terrainAtSubcell(mm, 7, 6), 'floor');
  assert.equal(mm.subdivisions, undefined);
  assert.equal(api.terrainAtSubcell(mm, 0, 0), 'floor');
  assert.equal(mm.fineMaterials[api.fineKeyOf(mm, 21, 21)], undefined);
  assert.equal(mm.seen.observed[api.fineKeyOf(mm, 6, 6)], 7);
  assert.equal(mm.seen.observed[api.fineKeyOf(mm, 21, 21)], undefined);
  assert.equal(mm.seen.architectureRevs[api.fineKeyOf(mm, 6, 6)], 7);
  assert.equal(mm.seen.architectureRevs[api.fineKeyOf(mm, 21, 21)], undefined);
  assert.equal(mm.seen.observed['nope'], undefined);
  assert.equal(mm.subCells, undefined);
  assert.equal(mm.materialSubCells, undefined);
  assert.doesNotThrow(() => api.checkWorld(migrated, true));
});


test('缩小时小格合并成大格：取多数派地形，没有细节退回大格底', () => {
  assert.equal(api.FINE_LOD_PX, 4);
  assert.equal(api.fineLodAt(0.3), true);
  assert.equal(api.fineLodAt(0.5), false);
  assert.equal(api.fineLodAt(0.1, true), false);
  const { map } = fixture();
  // 标记 5 个小格：多数派是 grass；同格剩下的 4 格仍是 floor。
  api.paintTerrainSubcells(map.id, [[6, 6], [7, 6], [8, 6], [6, 7], [7, 7]], 'grass');
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(api.aggregateTerrain(m, 2, 2), 'grass');
  // 3 个 grass 对 6 个 floor：多数派仍是 floor，缩小时不画成一整块草。
  api.paintTerrainCells(map.id, [[2, 2]], 'floor');
  api.paintTerrainSubcells(map.id, [[6, 6], [7, 6], [8, 6]], 'grass');
  const m2 = api.findMap(api.getWorld(), map.id);
  assert.equal(api.aggregateTerrain(m2, 2, 2), 'floor');
  assert.equal(api.aggregateTerrain(m2, 1, 1), 'floor');
});

test('缩小时材质也取多数派，纯色材质不会整层消失', () => {
  const { map } = fixture();
  api.paintMaterialSubcells(map.id, [[6, 6], [7, 6], [8, 6], [6, 7], [7, 7]], 'wood');
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(api.aggregateMaterial(m, 2, 2), 'wood');
  assert.equal(api.aggregateMaterial(m, 1, 1), '');
});


test('铺空白格会同步 3×3 小格，但不抹掉已有小格细节', () => {
  const world = api.emptyWorld();
  const map = api.newMap('空白图', '测试', 0, 4, 4, '', false);
  map.objects = [];
  world.maps = [map];
  api.replaceWorld(world);
  assert.equal(api.blankCellCount(map), 16);
  // 大格底为空、但 (1,1) 已有一格草：这不算空白格。
  api.paintTerrainSubcells(map.id, [[3, 3]], 'grass');
  assert.equal(api.blankCellCount(api.findMap(api.getWorld(), map.id)), 15);
  api.fillEmptyCells(map.id, 'floor');
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.cells[1 * m.width + 1], '');
  assert.equal(api.terrainAtSubcell(m, 3, 3), 'grass');
  assert.equal(m.cells[0], 'floor');
  assert.equal(api.terrainAtSubcell(m, 0, 0), 'floor');
  assert.equal(m.cells.every((c, i) => c === 'floor' || (i === 1 * m.width + 1 && c === '')), true);
  assert.equal(api.blankCellCount(m), 0);
  assert.equal(m.fineCells.every((c) => c === 'floor' || c === 'grass' || c === ''), true);
});

test('Rabbithole 导入后 fineCells 跟着 cells 重建，不会整图空白', async () => {
  const rh = {
    levels: [{ name: '一楼', rows: 1, cols: 1, cells: { '0,0': {} } }],
    rooms: [], objects: [], interactives: [], groups: [],
  };
  const file = new File([JSON.stringify(rh)], 'map.json', { type: 'application/json' });
  const { world } = await api.importRabbithole(file);
  const m = world.maps[0];
  assert.equal(m.fineCells.length, m.width * m.height * 9);
  assert.equal(api.terrainAtSubcell(m, 0, 0), 'yard'); // 一楼外圈
  assert.equal(m.fineCells.every((c) => c === ''), false);
});


test('9 个小格全被擦空时，LOD 不再回退大格底', () => {
  const { map } = fixture();
  const all = [];
  for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) all.push([2 * 3 + sx, 2 * 3 + sy]);
  api.paintTerrainSubcells(map.id, all, null);
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(api.aggregateTerrain(m, 2, 2), '');
  assert.equal(api.cellFloor(api.getWorld(), m, 2, 2), 'wall');
});


test('parseWorld 拒绝未知/缺失版本、坏 maps 条目和缺 party', () => {
  const v4 = api.emptyWorld(); v4.version = 4;
  assert.throws(() => api.parseWorld(JSON.stringify(v4)), /工程版本/);
  const noVersion = api.emptyWorld(); delete noVersion.version;
  assert.throws(() => api.parseWorld(JSON.stringify(noVersion)), /工程版本/);
  const badMaps = api.emptyWorld(); badMaps.maps = [null];
  assert.throws(() => api.parseWorld(JSON.stringify(badMaps)), /maps 列表/);
  const arrayMap = api.emptyWorld(); arrayMap.maps = [[]];
  assert.throws(() => api.parseWorld(JSON.stringify(arrayMap)), /maps 列表/);
  const missingFields = api.emptyWorld(); missingFields.maps = [{ name: '坏图' }];
  assert.throws(() => api.parseWorld(JSON.stringify(missingFields)), /width \/ height/);
  const badCells = api.emptyWorld(); badCells.maps[0].cells = [];
  assert.throws(() => api.parseWorld(JSON.stringify(badCells)), /cells 数量/);
  const badObjects = api.emptyWorld(); badObjects.maps[0].objects = [null];
  assert.throws(() => api.parseWorld(JSON.stringify(badObjects)), /objects 列表/);
  const noParty = api.emptyWorld(); delete noParty.party;
  assert.throws(() => api.parseWorld(JSON.stringify(noParty)), /party 不是数组/);
  const emptyParty = api.emptyWorld(); emptyParty.party = {};
  assert.throws(() => api.parseWorld(JSON.stringify(emptyParty)), /party 不是数组/);
});

test('parseWorld 仍能读有效 v1：迁移出完整 fineCells', () => {
  const v1 = api.emptyWorld(); v1.version = 1;
  delete v1.maps[0].fineCells;
  const w = api.parseWorld(JSON.stringify(v1));
  assert.equal(w.version, 3);
  assert.equal(w.maps[0].fineCells.length, w.maps[0].width * w.maps[0].height * 9);
});


test('v1 没有 subdivisions 时，observed 孤儿键也不会留下', () => {
  const w = api.emptyWorld();
  w.version = 1;
  const m = api.newMap('旧图', '测试', 0, 4, 4, 'floor', false);
  delete m.fineCells;
  m.seen.observed = { [api.fineKeyOf(m, 3, 3)]: 1 };
  w.maps = [m];
  const mm = api.migrateWorld(w).maps[0];
  assert.equal(mm.seen.observed[api.fineKeyOf(mm, 3, 3)], undefined);
});


test('v1 迁移清理 views 里的孤儿键，并处理非数组 subdivisions', () => {
  const w = api.emptyWorld();
  w.version = 1;
  const m = api.newMap('旧图', '测试', 0, 4, 4, 'floor', false);
  delete m.fineCells;
  m.subdivisions = 'oops';
  m.seen.observed = { [api.fineKeyOf(m, 3, 3)]: 1 };
  m.seen.architectureRevs = { [api.fineKeyOf(m, 3, 3)]: 1 };
  m.views = { a: { fog: m.fog.slice(), seen: {
    cells: m.cells.slice(), objects: [],
    observed: { [api.fineKeyOf(m, 3, 3)]: 1 }, architectureRevs: { [api.fineKeyOf(m, 3, 3)]: 1 },
  } } };
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [] }];
  w.maps = [m];
  const mm = api.migrateWorld(w).maps[0];
  assert.equal(mm.seen.observed[api.fineKeyOf(mm, 3, 3)], undefined);
  assert.equal(mm.seen.architectureRevs[api.fineKeyOf(mm, 3, 3)], undefined);
  assert.equal(mm.views.a.seen.observed[api.fineKeyOf(mm, 3, 3)], undefined);
  assert.equal(mm.views.a.seen.architectureRevs[api.fineKeyOf(mm, 3, 3)], undefined);
});

test('v1 迁移删掉非规范数字 key（如带空格的 " 1"）', () => {
  const w = api.emptyWorld();
  w.version = 1;
  const m = api.newMap('旧图', '测试', 0, 4, 4, 'floor', false);
  delete m.fineCells;
  m.subdivisions = [0];
  m.seen.observed = { ' 1': 7 };
  w.maps = [m];
  const mm = api.migrateWorld(w).maps[0];
  assert.equal(mm.seen.observed[' 1'], undefined);
});


test('v2 带非数组 subdivisions 时也清掉孤儿 observed', () => {
  const w = api.emptyWorld();
  const m = api.newMap('新图', '测试', 0, 4, 4, 'floor', false);
  m.subdivisions = 'oops';
  m.seen.observed = { [api.fineKeyOf(m, 3, 3)]: 1 };
  w.maps = [m];
  const mm = api.migrateWorld(w).maps[0];
  assert.equal(mm.seen.observed[api.fineKeyOf(mm, 3, 3)], undefined);
  assert.equal(mm.subdivisions, undefined);
});
