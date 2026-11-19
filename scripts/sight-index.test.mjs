// 视野表的缓存（sightIndex）：同眼高复用、引用变了就重建、结果必须和现建表逐格一致。
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-sight-index-test-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/scene/sightIndex'; export * from './src/scene/sight';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const { sightCtxFor, sightCacheSize, visionOf, partyVisionOf, eyeHeight } = await import(bundle);
after(() => rm(temp, { recursive: true, force: true }));

const world = {
  terrains: [
    { id: 'floor', name: '地板', visionCoef: 0.1, blocksMove: false, color: '' },
    { id: 'wall', name: '墙', visionCoef: 99, blocksMove: true, color: '' },
    { id: 'grass', name: '草丛', visionCoef: 0.8, blocksMove: false, color: '' },
  ],
};
const mkMap = (w, h, fill = 'floor') => ({
  id: 'm', width: w, height: h,
  cells: new Array(w * h).fill(fill),
  fineCells: new Array(w * h * 9).fill(fill),
  d100: new Array(w * h).fill(0),
  fog: new Array(w * h).fill(0),
  seen: { cells: new Array(w * h).fill(''), objects: [], groups: [], groupRevs: {} },
  views: {},
  groups: [],
  objects: [], tokens: [], architecture: { walls: [], doors: [] },
});

const same = (a, b, note) => {
  assert.equal(a.length, b.length, note + '：长度');
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i], `${note}：第 ${i} 格不一致`);
};

test('sightIndex：带缓存的视野和现建表逐格一致（含墙）', () => {
  const map = mkMap(20, 20);
  // 一堵竖墙把地图切开：x=10 格 = 30 个 1/3 格
  map.architecture = { walls: [{ id: 'w', a: { x: 30, y: 0 }, b: { x: 30, y: 60 }, thickness: 100, material: 'wall' }], doors: [] };
  const v = { x: 3, y: 10, facing: '东' };
  const plain = visionOf(world, map, v);
  const cached = visionOf(world, map, v, sightCtxFor(world, map));
  same(plain, cached, 'visionOf');
  // 墙后面确实看不见，否则这个测试没有意义
  assert.equal(plain[10 * 20 + 15], 0, '墙后不该看得见');
  assert.equal(plain[10 * 20 + 5], 1, '墙前该看得见');
});

test('sightIndex：同眼高只建一次表，不同眼高分组', () => {
  const map = mkMap(20, 20);
  const ctx = sightCtxFor(world, map);
  const a = ctx.tablesFor(1.58);
  const b = ctx.tablesFor(1.58);
  assert.equal(a.cost, b.cost, '同眼高应复用同一张衰减表');
  assert.equal(a.geometry, b.geometry, '几何应复用');
  assert.equal(sightCacheSize(map), 1);

  const c = ctx.tablesFor(0.9); // 蹲下
  assert.notEqual(a.cost, c.cost, '不同眼高要各建一张');
  assert.equal(sightCacheSize(map), 2);
  // 同一份 ctx 再取一次，不会因为“第二个眼高”重建整份
  assert.equal(ctx.tablesFor(1.58).cost, a.cost);
  assert.equal(ctx.tablesFor(1.58).geometry, a.geometry);
});

test('sightIndex：地图引用没变就一直是同一份表', () => {
  const map = mkMap(20, 20);
  const one = sightCtxFor(world, map).tablesFor(1.58);
  const two = sightCtxFor(world, map).tablesFor(1.58);
  assert.equal(one.cost, two.cost);
  assert.equal(one.geometry, two.geometry);
});

test('sightIndex：物件变了（引用换了）就重建，视野跟着变', () => {
  const map = mkMap(20, 20);
  const v = { x: 5, y: 10 };
  const before = visionOf(world, map, v, sightCtxFor(world, map));
  assert.equal(before[10 * 20 + 8], 1, '没有遮挡时该看得见');

  // 换一个新数组（immer 的口径），中间放一个比眼高高的物件
  map.objects = [{ id: 'box', kind: 'object', name: '箱子', x: 7, y: 9, w: 2, h: 2, height: 3, enabled: true }];
  const ctx2 = sightCtxFor(world, map); // 取 ctx 的这一刻才判失效
  assert.equal(sightCacheSize(map), 0, '引用变了，旧表该作废');
  const after2 = visionOf(world, map, v, ctx2);
  assert.equal(sightCacheSize(map), 1);
  assert.equal(after2[10 * 20 + 8], 0, '被高物件挡住后不该再看得见');
});

test('sightIndex：队伍视野用同一份表，结果和逐个算一致', () => {
  const map = mkMap(40, 30, 'grass');
  map.architecture = { walls: [{ id: 'w', a: { x: 60, y: 0 }, b: { x: 60, y: 90 }, thickness: 100, material: 'wall' }], doors: [] };
  const viewers = [
    { x: 5, y: 5 }, { x: 6, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 7, y: 7 },
    { x: 5, y: 8, stance: '蹲' }, { x: 6, y: 9 }, { x: 7, y: 9, sex: '女' },
  ];
  const plain = partyVisionOf(world, map, viewers);
  const cached = partyVisionOf(world, map, viewers, sightCtxFor(world, map));
  same(plain, cached, 'partyVisionOf');
  // 8 个人里只有两种眼高（站 1.58/1.52 与蹲 0.9），表不该超过 3 份
  assert.ok(sightCacheSize(map) <= 3, `表数量 ${sightCacheSize(map)} 超了`);
  const eyes = new Set(viewers.map((v) => eyeHeight(v)));
  assert.equal(sightCacheSize(map), eyes.size);
});
