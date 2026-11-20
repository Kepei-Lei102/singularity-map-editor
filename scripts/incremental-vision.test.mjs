// 增量视野的安全网：同一串随机操作，「增量重算」和「整图重算」必须逐格一致。
//
// 这是第 3 步（移动脏区）唯一能兜住「漏算一格」的测试——漏算不会报错，只会让玩家
// 该看见的地方看不见，几个月后才发现。所以宁可慢一点，测厚一点。
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-incremental-vision-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: {
    contents: `export { produce } from 'immer';
export { withVision } from './src/scene/perception';
export { diffWorld } from './src/scene/dirty';
export { planVision } from './src/scene/visionPlan';
export { VISION_RADIUS_CELLS } from './src/scene/sight';
export { emptyWorld, newMap } from './src/core/defaults';`,
    resolveDir: root,
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const { produce, withVision, diffWorld, planVision, emptyWorld, newMap, VISION_RADIUS_CELLS } = await import(bundle);
after(() => rm(temp, { recursive: true, force: true }));

const sameFog = (a, b, note) => {
  assert.equal(a.length, b.length, note + '：长度');
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i], `${note}：第 ${i} 格 ${a[i]} ≠ ${b[i]}`);
};

function mkWorld(mode = 'shared', size = [24, 16]) {
  const w = emptyWorld();
  w.visionMode = mode;
  if (size[0] !== 24 || size[1] !== 16) w.maps[0] = newMap('大房', '现实', 1, size[0], size[1]);
  w.party = [
    { id: 'a', name: '甲', sex: '男', heightCm: 173, color: '' },
    { id: 'b', name: '乙', sex: '女', heightCm: 164, color: '' },
    { id: 'c', name: '丙', sex: '其他', heightCm: 170, color: '' },
  ];
  if (mode === 'grouped') {
    w.visionGroups = [{ id: 'g1', name: '甲组' }, { id: 'g2', name: '乙组' }];
    w.party[0].visionGroupId = 'g1';
    w.party[1].visionGroupId = 'g1';
    w.party[2].visionGroupId = 'g2';
  }
  const m = w.maps[0];
  m.tokens = [
    { id: 't1', pcId: 'a', name: '甲', color: '', x: 5, y: 5 },
    { id: 't2', pcId: 'b', name: '乙', color: '', x: 8, y: 6, facing: '东' },
    { id: 't3', pcId: 'c', name: '丙', color: '', x: 12, y: 9, stance: '蹲' },
  ];
  // 房间里的几段墙 + 草丛，让视线不是一眼看穿
  m.cells[7 * m.width + 7] = 'wall';
  m.cells[8 * m.width + 7] = 'wall';
  m.cells[9 * m.width + 7] = 'wall';
  for (let x = 10; x <= 14; x++) m.cells[12 * m.width + x] = 'grass';
  return w;
}

// ---------- 脏集与计划 ----------

test('diffWorld：只挪一格时只报一个 moved，不算结构变化', () => {
  const prev = mkWorld();
  const next = produce(prev, (d) => { d.maps[0].tokens[0].x += 1; });
  const dirty = diffWorld(prev, next);
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].moved.length, 1);
  assert.deepEqual(dirty[0].moved[0], { from: { x: 5, y: 5 }, to: { x: 6, y: 5 } });
  assert.equal(dirty[0].structure, false);
  assert.equal(dirty[0].full, false);
});

test('diffWorld：改一格地形就是结构变化，整图重算', () => {
  const prev = mkWorld();
  const next = produce(prev, (d) => { d.maps[0].cells[3 * d.maps[0].width + 3] = 'grass'; });
  const dirty = diffWorld(prev, next);
  assert.equal(dirty[0].structure, true);
  assert.equal(planVision(next, dirty).full, true);
});

test('diffWorld：转身/蹲下也算脏（原地），不能漏', () => {
  const prev = mkWorld();
  const turn = produce(prev, (d) => { d.maps[0].tokens[0].facing = '北'; });
  const dirty = diffWorld(prev, turn);
  assert.equal(dirty[0].moved.length, 1);
  assert.deepEqual(dirty[0].moved[0].from, dirty[0].moved[0].to);
});

test('diffWorld：棋子换 pcId 也算脏，视野不能漏', () => {
  for (const mode of ['shared', 'individual', 'grouped']) {
    for (const [label, pcId] of [['换人同组', 'b'], ['换人跨组', 'c'], ['换成人 null', null]]) {
      const prev = withVision(mkWorld(mode), emptyWorldFallback(mode), { full: true });
      const next = produce(prev, (d) => { d.maps[0].tokens[0].pcId = pcId; });
      const dirty = diffWorld(prev, next);
      assert.equal(dirty[0].moved.length, 1, `${mode}/${label}：换 pcId 必须进脏集`);
      const inc = withVision(next, prev);
      const full = withVision(next, prev, { full: true });
      sameFog(inc.maps[0].fog, full.maps[0].fog, `${mode}/${label}：pcId`);
      for (const id of Object.keys(full.maps[0].views)) {
        sameFog(inc.maps[0].views[id].fog, full.maps[0].views[id].fog, `${mode}/${label}：${id}`);
      }
    }
  }
});

test('换 pcId 后下一步移动仍只算两个圆盘', () => {
  const prev = withVision(mkWorld('grouped'), emptyWorldFallback('grouped'), { full: true });
  const changed = produce(prev, (d) => { d.maps[0].tokens[0].pcId = 'c'; });
  const after = withVision(changed, prev);
  const moved = produce(after, (d) => { d.maps[0].tokens[0].x += 1; });
  const dirty = diffWorld(after, moved);
  assert.equal(dirty[0].structure, false, '换完人再走一步不该退回整图');
  assert.equal(planVision(moved, dirty).full, false, '换完人再走一步仍应只收窄圆盘');
  const inc = withVision(moved, after);
  const full = withVision(moved, after, { full: true });
  sameFog(inc.maps[0].fog, full.maps[0].fog, '换 pcId 后移动：map');
  for (const id of Object.keys(full.maps[0].views)) {
    sameFog(inc.maps[0].views[id].fog, full.maps[0].views[id].fog, `换 pcId 后移动：${id}`);
  }
});

test('D100 区改动必须重算视野，增量不能留旧雾', () => {
  for (const mode of ['shared', 'individual', 'grouped']) {
    for (const start of [0, 1]) {
      const base = produce(mkWorld(mode), (d) => {
        d.maps[0].tokens = [d.maps[0].tokens[0]];
        d.maps[0].tokens[0].facing = '东';
        d.maps[0].d100[5 * d.maps[0].width + 5] = start;
      });
      const prev = withVision(base, emptyWorldFallback(mode), { full: true });
      const m = prev.maps[0];
      const idx = 5 * m.width + 5;
      const next = produce(prev, (d) => { d.maps[0].d100[idx] = 1 - start; });
      const inc = withVision(next, prev);
      const full = withVision(next, prev, { full: true });
      assert.notDeepEqual(inc.maps[0].fog, prev.maps[0].fog, `${mode} ${start}→${1 - start} 必须真的改变视野`);
      sameFog(inc.maps[0].fog, full.maps[0].fog, `${mode} ${start}→${1 - start}`);
      for (const id of Object.keys(full.maps[0].views)) {
        sameFog(inc.maps[0].views[id].fog, full.maps[0].views[id].fog, `${mode} ${start}→${1 - start} ${id}`);
      }
    }
  }
});

test('手动雾先保留，下一次视野脏动按自动迷雾重算覆盖', () => {
  const prev = withVision(mkWorld('shared'), emptyWorldFallback('shared'), { full: true });
  const m = prev.maps[0];
  // 选一个视野外、原本是黑的格手动点亮：它不在移动圆盘里，才测得出“漏算”。
  const idx = m.fog.findIndex((f, i) => f === 0 && (i % m.width) >= 20 && Math.floor(i / m.width) >= 12);
  assert.ok(idx >= 0, '需要一格视野外的黑格');
  const painted = produce(prev, (d) => { d.maps[0].fog[idx] = 1; });
  const held = withVision(painted, prev);
  assert.equal(held.maps[0].fog[idx], 1, '本次 update 先保留手动雾（否则手动工具按下去就被覆盖）');
  const unrelated = produce(held, (d) => { d.session += 1; });
  assert.ok(diffWorld(held, unrelated)[0].structure, '手动 pending 的下一帧必须给全图计划，syncMemory 才不会漏');
  assert.equal(withVision(unrelated, held).maps[0].fog[idx], 1, '只改无关数据时手动雾还不该被覆盖');
  const moved = produce(held, (d) => { d.maps[0].tokens[0].x += 1; });
  const inc = withVision(moved, held);
  const full = withVision(moved, held, { full: true });
  assert.equal(full.maps[0].fog[idx], 2, '全量会把手动点亮的视野外格降成记忆灰');
  assert.equal(inc.maps[0].fog[idx], 2, '下一次有视野脏动时自动迷雾要接管');
  sameFog(inc.maps[0].fog, full.maps[0].fog, '手动雾后的下一次移动');
});

test('关掉自动迷雾后，手动雾保留，不被重算覆盖', () => {
  const base = produce(withVision(mkWorld('shared'), emptyWorldFallback('shared'), { full: true }), (d) => { d.maps[0].autoFog = false; });
  const idx = base.maps[0].fog.findIndex((f) => f === 1);
  assert.ok(idx >= 0, '起始视野里至少要有一格可见');
  const next = produce(base, (d) => { d.maps[0].fog[idx] = 0; });
  assert.equal(withVision(next, base).maps[0].fog[idx], 0, '手动雾不该被自动重算覆盖');
});

test('planVision：一格移动只圈两个圆盘，远小于全图', () => {
  const prev = mkWorld('shared', [60, 40]);
  const next = produce(prev, (d) => { d.maps[0].tokens[0].x += 2; });
  const plan = planVision(next, diffWorld(prev, next));
  assert.equal(plan.full, false);
  const cells = plan.maps.get(prev.maps[0].id);
  const total = prev.maps[0].width * prev.maps[0].height;
  assert.ok(cells.size > 0);
  assert.ok(cells.size < total / 3, `脏区 ${cells.size} / ${total} 太大，收窄没生效`);
  // 半径内的格必须在脏集里：抽最远的一个角验证
  const m = prev.maps[0];
  for (const [cx, cy] of [[5, 5], [7, 5]]) {
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
      const dx = x - cx, dy = y - cy;
      if (Math.floor(Math.sqrt(dx * dx + dy * dy)) <= VISION_RADIUS_CELLS) {
        assert.ok(cells.has(y * m.width + x), `圆心 (${cx},${cy}) 半径内的 (${x},${y}) 不在脏集`);
      }
    }
  }
});

// ---------- 增量 === 全量 ----------

function runSequence(mode, steps = 120, seed0 = 20261119) {
  let seed = seed0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  let world = withVision(mkWorld(mode), emptyWorldFallback(mode), { full: true });
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  let narrowed = 0;
  for (let k = 0; k < steps; k++) {
    const op = rnd();
    const prev = world;
    const next = produce(prev, (d) => {
      const m = d.maps[0];
      const t = m.tokens[Math.floor(rnd() * m.tokens.length)];
      if (op < 0.62) {
        const [dx, dy] = dirs[Math.floor(rnd() * dirs.length)];
        t.x = Math.max(1, Math.min(m.width - 2, t.x + dx));
        t.y = Math.max(1, Math.min(m.height - 2, t.y + dy));
      } else if (op < 0.76) {
        t.facing = ['北', '东', '南', '西'][Math.floor(rnd() * 4)];
      } else if (op < 0.84) {
        t.stance = t.stance === '蹲' ? undefined : '蹲';
      } else if (op < 0.92) {
        // 结构变化：涂一格草丛/地板
        const x = Math.floor(rnd() * m.width), y = Math.floor(rnd() * m.height);
        m.cells[y * m.width + x] = m.cells[y * m.width + x] === 'grass' ? 'floor' : 'grass';
      } else {
        t.subcell = undefined;
      }
    });
    const dirty = diffWorld(prev, next);
    const plan = planVision(next, dirty);
    if (!plan.full) narrowed++;
    const inc = withVision(next, prev);
    const full = withVision(next, prev, { full: true });
    for (let i = 0; i < next.maps.length; i++) {
      sameFog(inc.maps[i].fog, full.maps[i].fog, `第 ${k} 步 地图${i} fog`);
      for (const id of Object.keys(full.maps[i].views)) {
        sameFog(inc.maps[i].views[id].fog, full.maps[i].views[id].fog, `第 ${k} 步 ${id} 视野层`);
      }
    }
    world = inc; // 和 update() 一致：持久化的是算完视野之后的世界
  }
  return narrowed;
}

// 第一帧用空世界当 prev，逼 withVision 走 full
function emptyWorldFallback(mode) {
  const w = emptyWorld();
  w.visionMode = mode;
  return w;
}

test('增量视野 === 整图视野（全队共享）', () => {
  const narrowed = runSequence('shared');
  assert.ok(narrowed > 40, `只有 ${narrowed} 步走了脏区，覆盖不够`);
});

test('增量视野 === 整图视野（各自独立）', () => {
  runSequence('individual');
});

test('增量视野 === 整图视野（分组）', () => {
  runSequence('grouped');
});
