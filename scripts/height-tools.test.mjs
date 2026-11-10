import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-htool-'));
const bundle = join(temp, 'editor.cjs');
// 只打包纯数据和纯函数：Sidebar 那几个模块会碰浏览器环境，测不了。
await build({
  stdin: {
    contents: `export * from './src/components/toolGroups';
              export { setHeight, heightAt, clearHeights, isFlat } from './src/scene/height';`,
    resolveDir: root,
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const api = createRequire(import.meta.url)(bundle);
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

const mkMap = (w, h) => ({ id: 'm', name: 'm', layer: '现实', floor: 1, width: w, height: h,
  cells: [], d100: [], fog: [], seen: {}, autoFog: false, rooms: [], roomCells: [], views: {},
  spawn: null, objects: [], tokens: [] });

/** 抬高/压低一格，地板是 0。跟 nudgeHeight 的单格逻辑一样。 */
const nudge = (m, x, y, delta) => {
  const before = api.heightAt(m, x, y);
  const after = Math.max(0, before + delta);
  if (after === before) return false;
  api.setHeight(m, x, y, after);
  return true;
};

/** 框选一片设成同一个高度。跟 setHeightArea 的逻辑一样。 */
const setArea = (m, r, h) => {
  let n = 0;
  const x0 = Math.max(0, Math.min(r.x0, r.x1)), y0 = Math.max(0, Math.min(r.y0, r.y1));
  const x1 = Math.min(m.width - 1, Math.max(r.x0, r.x1)), y1 = Math.min(m.height - 1, Math.max(r.y0, r.y1));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (api.heightAt(m, x, y) === Math.max(0, h)) continue;
    api.setHeight(m, x, y, Math.max(0, h)); n++;
  }
  return n;
};

test('单格抬高 +1', () => {
  const m = mkMap(4, 3);
  assert.equal(nudge(m, 1, 1, 1), true);
  assert.equal(api.heightAt(m, 1, 1), 1);
});

test('连续抬高会累加', () => {
  const m = mkMap(4, 3);
  nudge(m, 2, 0, 1); nudge(m, 2, 0, 1); nudge(m, 2, 0, 1);
  assert.equal(api.heightAt(m, 2, 0), 3);
});

test('压低到地面就停住，不会变成负数', () => {
  const m = mkMap(4, 3);
  nudge(m, 0, 0, 1);
  nudge(m, 0, 0, -1);
  assert.equal(api.heightAt(m, 0, 0), 0);
  assert.equal(nudge(m, 0, 0, -1), false, '已经是 0 再压不该改');
});

test('框选一片设成同一个高度', () => {
  const m = mkMap(5, 4);
  assert.equal(setArea(m, { x0: 1, y0: 1, x1: 3, y1: 2 }, 2), 6);
  assert.equal(api.heightAt(m, 1, 1), 2);
  assert.equal(api.heightAt(m, 3, 2), 2);
  assert.equal(api.heightAt(m, 0, 0), 0, '没选到的不变');
});

test('框选压平', () => {
  const m = mkMap(5, 4);
  setArea(m, { x0: 0, y0: 0, x1: 4, y1: 3 }, 3);
  assert.equal(setArea(m, { x0: 0, y0: 0, x1: 4, y1: 3 }, 0), 20);
  assert.equal(api.isFlat(m), true);
});

test('框选矩形的坐标顺序反过来也认', () => {
  const m = mkMap(5, 4);
  assert.equal(setArea(m, { x0: 3, y0: 2, x1: 1, y1: 1 }, 1), 6);
});

test('框选超出地图边界会被裁掉', () => {
  const m = mkMap(5, 4);
  assert.equal(setArea(m, { x0: -3, y0: -3, x1: 100, y1: 100 }, 1), 20);
});

test('已经同高的格子不算改动', () => {
  const m = mkMap(3, 3);
  setArea(m, { x0: 0, y0: 0, x1: 2, y1: 2 }, 2);
  assert.equal(setArea(m, { x0: 0, y0: 0, x1: 2, y1: 2 }, 2), 0);
});

// ---------- 工具栏 ----------

test('分组都在', () => {
  for (const g of ['view', 'terrain', 'arch', 'height', 'content', 'fog']) {
    assert.ok(api.GROUP_LABEL[g], `${g} 组要有名字`);
  }
});

test('U 键带两个高度工具', () => {
  assert.deepEqual(api.KEY_TOOLS.u, ['heightBrush', 'heightRect']);
  assert.ok(api.SHARED_KEYS.u, 'U 是共享字母');
});

test('单工具字母按一下就用它', () => {
  const p = api.pickToolForKey('v', 'paint');
  assert.equal(p.tool, 'select');
  assert.equal(p.hint, '', '单工具不弹提示');
});

test('双工具：第一次用第一个，再按一下切换', () => {
  const a = api.pickToolForKey('u', 'select');
  assert.equal(a.tool, 'heightBrush');
  assert.match(a.hint, /再按一次 U 切换到「框选抬高」/);

  const b = api.pickToolForKey('u', 'heightBrush');
  assert.equal(b.tool, 'heightRect', '已经在第一档，再按就切到第二个');
  assert.match(b.hint, /再按一次 U 切换到「抬高 \/ 压低」/);
});

test('双工具：来回切能转圈', () => {
  assert.equal(api.pickToolForKey('u', 'heightRect').tool, 'heightBrush', '切回第一个');
});

test('不认识的字母返回 null', () => {
  assert.equal(api.pickToolForKey('q', 'select'), null);
});
