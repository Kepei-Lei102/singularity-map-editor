import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-height-'));
const bundle = join(temp, 'height.cjs');
await build({
  stdin: { contents: `export * from './src/scene/height';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const api = createRequire(import.meta.url)(bundle);
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

const mkMap = (w, h) => ({ id: 'm', name: 'm', layer: '现实', floor: 1, width: w, height: h,
  cells: [], d100: [], fog: [], seen: {}, autoFog: false, rooms: [], roomCells: [], views: {},
  spawn: null, objects: [], tokens: [] });

test('一格 0.75 米，两层挑高 8 格 = 6 米', () => {
  assert.equal(api.CELL_METERS, 0.75);
  assert.equal(api.FLOOR_HEIGHT_CELLS, 8);
  assert.equal(api.FLOOR_HEIGHT_CELLS * api.CELL_METERS, 6);
});

test('没填高度就是整层平地', () => {
  const m = mkMap(4, 3);
  assert.equal(api.isFlat(m), true);
  assert.equal(api.heightAt(m, 0, 0), 0);
  assert.equal(api.heightAt(m, 3, 2), 0);
  assert.equal(api.metersAt(m, 1, 1), 0);
});

test('写了高度就能读回来', () => {
  const m = mkMap(4, 3);
  assert.equal(api.setHeight(m, 1, 1, 2), true);
  assert.equal(api.heightAt(m, 1, 1), 2);
  assert.equal(api.heightAt(m, 0, 0), 0, '没写的还是 0');
  assert.equal(api.metersAt(m, 1, 1), 1.5);
  assert.equal(api.isFlat(m), false);
});

test('越界和非法坐标不炸', () => {
  const m = mkMap(4, 3);
  assert.equal(api.heightAt(m, -1, 0), 0);
  assert.equal(api.heightAt(m, 4, 0), 0);
  assert.equal(api.heightAt(m, 0, 3), 0);
  assert.equal(api.heightAt(m, 1.5, 0), 0, '非整数当平地');
  assert.equal(api.setHeight(m, -1, 0, 5), false);
  assert.equal(api.setHeight(m, 4, 0, 5), false);
});

test('落差：正数往上，负数往下', () => {
  const m = mkMap(4, 3);
  api.setHeight(m, 1, 1, 3);
  api.setHeight(m, 2, 1, 0);
  assert.equal(api.heightDiff(m, { x: 0, y: 1 }, { x: 1, y: 1 }), 3, '从平地跳上 3 格');
  assert.equal(api.heightDiff(m, { x: 1, y: 1 }, { x: 0, y: 1 }), -3, '从 3 格跳下来');
  assert.equal(api.heightDiff(m, { x: 0, y: 1 }, { x: 0, y: 2 }), 0, '平地到平地');
});

test('设成 0 等于平地', () => {
  const m = mkMap(4, 3);
  assert.equal(api.setHeight(m, 1, 1, 0), false, '本来就是 0，不用改');
  api.setHeight(m, 1, 1, 2);
  api.setHeight(m, 1, 1, 0);
  assert.equal(api.heightAt(m, 1, 1), 0);
  assert.equal(api.isFlat(m), true);
});

test('清掉高度回到平地', () => {
  const m = mkMap(4, 3);
  api.setHeight(m, 1, 1, 2);
  api.clearHeights(m);
  assert.equal(api.isFlat(m), true);
  assert.equal(api.heightAt(m, 1, 1), 0);
});

test('高度恐惧四档', () => {
  assert.equal(api.fearTier(0), 'none');
  assert.equal(api.fearTier(1), 'none');
  assert.equal(api.fearTier(2), 'none', '2 格 1.5 米不触发');
  assert.equal(api.fearTier(3), 'none');
  assert.equal(api.fearTier(4), 'advantage', '4 格 3 米：优势');
  assert.equal(api.fearTier(7), 'advantage');
  assert.equal(api.fearTier(8), 'normal', '8 格 6 米：普通');
  assert.equal(api.fearTier(11), 'normal');
  assert.equal(api.fearTier(12), 'disadvantage', '12 格 9 米：劣势');
  assert.equal(api.fearTier(30), 'disadvantage');
});

test('往下看和跳上去算一样', () => {
  assert.equal(api.fearTier(-8), 'normal');
  assert.equal(api.fearTier(-12), 'disadvantage');
});

test('一层楼的高度正好落在普通意志那档', () => {
  // 挑高 8 格 = 6 米 → 普通意志检定
  assert.equal(api.fearTier(api.FLOOR_HEIGHT_CELLS), 'normal');
  // 两层楼：12 格 = 9 米 → 劣势
  assert.equal(api.fearTier(api.FLOOR_HEIGHT_CELLS * 2), 'disadvantage');
});

test('要不要掷骰、怎么掷', () => {
  assert.equal(api.fearNeedsRoll('none'), false);
  assert.equal(api.fearNeedsRoll('advantage'), true);
  assert.equal(api.fearRollMode('none'), 'single');
  assert.equal(api.fearRollMode('advantage'), 'advantage');
  assert.equal(api.fearRollMode('normal'), 'single');
  assert.equal(api.fearRollMode('disadvantage'), 'disadvantage');
});

test('描述文字对得上', () => {
  assert.match(api.describeFear(2), /不用检定/);
  assert.match(api.describeFear(4), /优势意志/);
  assert.match(api.describeFear(8), /6\.0 米.*意志检定/);
  assert.match(api.describeFear(12), /劣势意志/);
});
