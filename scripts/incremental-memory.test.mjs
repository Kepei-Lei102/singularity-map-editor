// 记忆增量同步的安全网：脏格同步和全量同步必须写出同一份记忆。
//
// 记忆比雾更容易悄悄错：`seen.cells` 少同步一格，玩家看到的地形就会停在上一次；
// `seen.objects` 漏一次，物件会从玩家的记忆里消失。所以这里逐字段对比整份 seen。
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-incremental-memory-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: {
    contents: `export { produce } from 'immer';
export { withVision } from './src/scene/perception';
export { syncMemory } from './src/scene/memory';
export { diffWorld } from './src/scene/dirty';
export { planVision } from './src/scene/visionPlan';
export { emptyWorld, newMap } from './src/core/defaults';`,
    resolveDir: root,
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const { produce, withVision, syncMemory, diffWorld, planVision, emptyWorld, newMap } = await import(bundle);
after(() => rm(temp, { recursive: true, force: true }));

function mkWorld(mode = 'shared') {
  const w = emptyWorld();
  w.visionMode = mode;
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
    { id: 't2', pcId: 'b', name: '乙', color: '', x: 8, y: 6 },
    { id: 't3', pcId: 'c', name: '丙', color: '', x: 12, y: 9 },
  ];
  m.cells[7 * m.width + 7] = 'wall';
  m.cells[8 * m.width + 7] = 'wall';
  for (let x = 10; x <= 14; x++) m.cells[12 * m.width + x] = 'grass';
  // 一个家具：它的外观应该进记忆，之后被搬走/藏起来时也要按规矩处理
  m.objects = [
    { id: 'box', kind: 'object', name: '木箱', x: 9, y: 8, w: 2, h: 1, height: 0.9, color: '', icon: '', states: ['默认'], state: 0, notes: '', hidden: false, secrets: [], media: [], enabled: true, physical: {} },
    { id: 'walla', kind: 'object', name: '隔断', x: 14, y: 3, w: 1, h: 4, height: 2.4, color: '', icon: '', states: ['默认'], state: 0, notes: '', hidden: false, secrets: [], media: [], enabled: true, physical: {} },
  ];
  // 一块贴图：进记忆后应该记成「组~贴图版本」
  m.groups = [{ id: 'g1', name: '地毯', cells: [4, 5, 6, 28, 29, 30] }];
  // 材质格：记忆里要记下「这块地当时是什么材质」，脏区同步必须一起写
  m.materialCells = { [5 * m.width + 5]: 'wood', [6 * m.width + 6]: 'stone', [9 * m.width + 12]: 'tile' };
  return w;
}

/**
 * `observed` / `architectureRevs` / `cellRevs` / `objectRevs` / `groupRevs` 都是「第几次观察」的时间戳，
 * 全量口径每次都会给所有可见格重新盖一个 rev，增量只在脏区里盖。两者的先后关系一致，
 * 但数值会漂，所以对比时把它们归一成「有没有值」，内容字段仍然严格比。
 */
const normalize = (seen) => {
  const on = (obj) => obj && Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k] ? 1 : 0]));
  return JSON.stringify({
    cells: seen.cells,
    objects: seen.objects,
    groups: seen.groups,
    materialCells: seen.materialCells ?? {},
    architecture: seen.architecture ?? [],
    cellRevs: (seen.cellRevs ?? []).map((v) => (v ? 1 : 0)),
    observed: on(seen.observed ?? {}),
    architectureRevs: on(seen.architectureRevs ?? {}),
    objectRevs: on(seen.objectRevs ?? {}),
    groupRevs: on(seen.groupRevs ?? {}),
  });
};
const snap = (v) => normalize(v);

function compareSeen(inc, full, step, note) {
  for (let i = 0; i < inc.maps.length; i++) {
    const a = inc.maps[i], b = full.maps[i];
    assert.equal(snap(a.seen), snap(b.seen), `${note} 第 ${step} 步 地图${i} seen 不一致`);
    for (const id of Object.keys(b.views ?? {})) {
      assert.equal(snap(a.views[id]?.seen), snap(b.views[id]?.seen), `${note} 第 ${step} 步 ${id} 的 seen 不一致`);
    }
  }
}

function runSequence(mode, steps = 24, seed0 = 20261120) {
  let seed = seed0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  // 第一帧：先全量算一遍视野，再把记忆全量同步一次，让 fog 和 seen 从同一个状态起步
  let world = withVision(mkWorld(mode), emptyWorld(), { full: true });
  world = produce(world, (d) => syncMemory(d));
  let narrowed = 0;
  for (let k = 0; k < steps; k++) {
    const op = rnd();
    const prev = world;
    const next = produce(prev, (d) => {
      const m = d.maps[0];
      if (op < 0.55) {
        const t = m.tokens[Math.floor(rnd() * m.tokens.length)];
        const [dx, dy] = dirs[Math.floor(rnd() * dirs.length)];
        t.x = Math.max(1, Math.min(m.width - 2, t.x + dx));
        t.y = Math.max(1, Math.min(m.height - 2, t.y + dy));
      } else if (op < 0.7) {
        const t = m.tokens[Math.floor(rnd() * m.tokens.length)];
        t.facing = ['北', '东', '南', '西'][Math.floor(rnd() * 4)];
      } else if (op < 0.8) {
        const t = m.tokens[Math.floor(rnd() * m.tokens.length)];
        t.stance = t.stance === '蹲' ? undefined : '蹲';
      } else if (op < 0.88) {
        // 搬家具：物件动了，它的记忆应该跟着变
        const o = m.objects.find((x) => x.id === 'box');
        if (o) o.x = Math.max(1, Math.min(m.width - 3, o.x + (rnd() < 0.5 ? 1 : -1)));
      } else if (op < 0.95) {
        const x = Math.floor(rnd() * m.width), y = Math.floor(rnd() * m.height);
        m.cells[y * m.width + x] = m.cells[y * m.width + x] === 'grass' ? 'floor' : 'grass';
      } else {
        const g = m.groups[0];
        if (g) g.cells = [...new Set([...g.cells, Math.floor(rnd() * m.width * m.height)])];
      }
    });
    const dirty = diffWorld(prev, next);
    const plan = planVision(next, dirty);
    if (!plan.full) narrowed++;
    const visioned = withVision(next, prev, { plan });
    const inc = produce(visioned, (d) => syncMemory(d, plan));
    // full 必须从原始 prev 独立走全量视野，而不是拿已经 merge 过的 visioned 再 sync。
    const full = produce(withVision(next, prev, { full: true }), (d) => syncMemory(d));
    compareSeen(inc, full, k, mode);
    // 每 20 步做一次收敛检查：从增量状态再跑一遍全量，必须和从全量状态再跑一遍全量结果一致。
    if (k === steps - 1) {
      const a = produce(inc, (d) => syncMemory(d));
      const b = produce(full, (d) => syncMemory(d));
      for (let i = 0; i < a.maps.length; i++) {
        assert.equal(JSON.stringify(a.maps[i].seen), JSON.stringify(b.maps[i].seen), `收敛检查第 ${k} 步 地图${i} 不一致`);
      }
    }
    world = inc;
  }
  return narrowed;
}

test('记忆增量 === 记忆全量（全队共享）', () => {
  const narrowed = runSequence('shared');
  assert.ok(narrowed > 8, `只有 ${narrowed} 步走了脏格，覆盖不够`);
});

test('记忆增量 === 记忆全量（各自独立）', () => {
  runSequence('individual');
});

test('记忆增量 === 记忆全量（分组）', () => {
  runSequence('grouped', 20);
});

test('记忆同步：看得见的材质格要记下材质，看不见后要保留上次的值', () => {
  let world = withVision(mkWorld('shared'), emptyWorld(), { full: true });
  world = produce(world, (d) => syncMemory(d));
  const m0 = world.maps[0];
  const seenAt = (w, i) => w.maps[0].seen.materialCells?.[i];
  // 甲一开始站在 (5,5)，脚下的木地板必然看得见
  const foot = 5 * m0.width + 5;
  assert.equal(m0.fog[foot], 1);
  assert.equal(seenAt(world, foot), 'wood', '脚下看得见时记忆里要有材质');

  // 走远：这一格变灰，材质记忆必须留着上次的值
  const far = produce(world, (d) => {
    const m = d.maps[0];
    m.tokens[0].x = 20; m.tokens[0].y = 14;
    m.tokens[1].x = 21; m.tokens[1].y = 14;
    m.tokens[2].x = 20; m.tokens[2].y = 13;
  });
  const dirty = diffWorld(world, far);
  const plan = planVision(far, dirty);
  const visioned = withVision(far, world, { plan });
  const synced = produce(visioned, (d) => syncMemory(d, plan));
  assert.equal(synced.maps[0].fog[foot], 2, '走远以后应该变成灰格');
  assert.equal(seenAt(synced, foot), 'wood', '灰格的材质记忆要保留');
  // 灰格里记得的地形也应该是当时看到的
  assert.equal(synced.maps[0].seen.cells[foot], world.maps[0].cells[foot]);
});

test('记忆合并：独立/分组模式下 mergeLayers 不能丢材质记忆', () => {
  for (const mode of ['individual', 'grouped']) {
    const w = emptyWorld();
    w.visionMode = mode;
    w.party = [
      { id: 'a', name: '甲', sex: '男', heightCm: 173, color: '', visionGroupId: mode === 'grouped' ? 'g1' : undefined },
      { id: 'b', name: '乙', sex: '女', heightCm: 164, color: '', visionGroupId: mode === 'grouped' ? 'g1' : undefined },
    ];
    if (mode === 'grouped') w.visionGroups = [{ id: 'g1', name: '甲组' }];
    const map = newMap('材质', '现实', 0, 40, 30, 'floor', false);
    map.autoFog = true;
    map.tokens = [
      { id: 'ta', pcId: 'a', name: '甲', color: '', x: 5, y: 5 },
      { id: 'tb', pcId: 'b', name: '乙', color: '', x: 25, y: 20 },
    ];
    const tileCell = 20 * map.width + 25;
    map.materialCells = { [tileCell]: 'tile' };
    w.maps = [map];

    let world = withVision(w, emptyWorld(), { full: true });
    world = produce(world, (d) => syncMemory(d));
    const remember = (label) => {
      const m = world.maps[0];
      assert.equal(m.seen.materialCells?.[tileCell], 'tile', `${mode}/${label}：地图层材质记忆`);
      assert.equal(m.views.b.seen.materialCells?.[tileCell], 'tile', `${mode}/${label}：乙的材质记忆`);
      if (mode === 'grouped') assert.equal(m.views.a.seen.materialCells?.[tileCell], 'tile', `${mode}/${label}：同组甲也继承材质记忆`);
    };
    remember('初始');

    const next = produce(world, (d) => { d.maps[0].tokens[0].x = 6; });
    const dirty = diffWorld(world, next);
    const plan = planVision(next, dirty);
    const inc = produce(withVision(next, world, { plan }), (d) => syncMemory(d, plan));
    world = inc;
    remember('甲走一格后');
  }
});

test('建筑记忆：增量移动保留旧墙、只补脏区新看见的墙', () => {
  for (const mode of ['individual', 'grouped']) {
    const w = emptyWorld();
    w.visionMode = mode;
    w.party = [
      { id: 'a', name: '甲', sex: '男', heightCm: 173, color: '', visionGroupId: mode === 'grouped' ? 'g1' : undefined },
      { id: 'b', name: '乙', sex: '女', heightCm: 164, color: '', visionGroupId: mode === 'grouped' ? 'g1' : undefined },
    ];
    if (mode === 'grouped') w.visionGroups = [{ id: 'g1', name: '甲组' }];
    const map = newMap('建筑', '现实', 0, 40, 30, 'floor', false);
    map.architecture = { walls: [{ id: 'w1', a: { x: 20.5, y: 4 }, b: { x: 20.5, y: 14 }, thickness: 0.25, material: 'wall' }], doors: [] };
    map.tokens = [
      { id: 'ta', pcId: 'a', name: '甲', color: '', x: 10, y: 10 },
      { id: 'tb', pcId: 'b', name: '乙', color: '', x: 30, y: 10 },
    ];
    w.maps = [map];
    let prev = withVision(w, emptyWorld(), { full: true });
    prev = produce(prev, (d) => syncMemory(d));
    const next = produce(prev, (d) => { d.maps[0].tokens[0].x = 11; });
    const dirty = diffWorld(prev, next);
    const plan = planVision(next, dirty);
    assert.equal(plan.full, false);
    const inc = produce(withVision(next, prev, { plan }), (d) => syncMemory(d, plan));
    const full = produce(withVision(next, prev, { full: true }), (d) => syncMemory(d));
    compareSeen(inc, full, 0, `建筑记忆/${mode}`);
  }
});

test('材质-only 改动：视野不收窄、也不整图重算，只让该图记忆全量', () => {
  const w = emptyWorld();
  w.party = [{ id: 'a', name: '甲', sex: '男', heightCm: 173, color: '' }];
  const m = w.maps[0];
  m.tokens = [{ id: 't', pcId: 'a', name: '甲', color: '', x: 5, y: 5 }];
  m.materialCells = { [5 * m.width + 5]: 'wood' };
  let prev = withVision(w, emptyWorld(), { full: true });
  prev = produce(prev, (d) => syncMemory(d));
  const fogBefore = prev.maps[0].fog.slice();
  const next = produce(prev, (d) => { d.maps[0].materialCells[6 * d.maps[0].width + 6] = 'stone'; });
  const dirty = diffWorld(prev, next);
  assert.equal(dirty[0].structure, true, '材质改动仍然要同步记忆');
  assert.equal(dirty[0].visionStructure, false, '材质不改视野');
  const plan = planVision(next, dirty);
  assert.equal(plan.full, false, '不该整图重算视野');
  assert.ok(plan.memoryFullMaps?.has(prev.maps[0].id), '这一张图仍要全量同步记忆');
  const out = withVision(next, prev, { plan });
  assert.deepEqual(out.maps[0].fog, fogBefore, '材质改动不该改 fog');
});
