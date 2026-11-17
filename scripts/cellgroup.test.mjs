import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-cellgroup-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/core/grid'; export * from './src/core/defaults'; export * from './src/core/schema.js'; export * from './src/scene/memory';`, resolveDir: root },
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

const tex = (id = 'tex') => ({ id, name: '木地板贴图', mime: 'image/png', size: 12 });
const key = (m, x3, y3) => api.fineKeyOf(m, x3, y3);

function validWorld() {
  const w = api.emptyWorld();
  const m = w.maps[0];
  w.media = [tex()];
  const o = api.newObject('object', 1, 1, 1, 1);
  o.id = 'obj1';
  m.objects = [o];
  m.groups = [
    { id: 'g-terrain', name: '木地板', cells: [key(m, 0, 0), key(m, 1, 0), key(m, 1, 1)], texture: { mediaId: 'tex', fit: 'fill', opacity: 0.8 }, z: 0 },
    { id: 'g-object', name: '物件贴图', cells: api.objectFootprintCells(m.width, m.height, o), objectId: 'obj1' },
  ];
  m.seen.groups = [{ id: 'g-memory', name: '记得的木地板', cells: [key(m, 0, 0)], texture: { mediaId: 'tex', fit: 'contain' } }];
  return w;
}

test('新地图默认带空 groups 和 seen.groups', () => {
  const w = api.emptyWorld();
  assert.deepEqual(w.maps[0].groups, []);
  assert.deepEqual(w.maps[0].seen.groups, []);
});

test('旧 v2 地图迁移补 groups 与 seen.groups', () => {
  const w = api.emptyWorld();
  const m = w.maps[0];
  delete m.groups;
  delete m.seen.groups;
  m.views = { a: { fog: new Array(m.width * m.height).fill(0), seen: { cells: new Array(m.width * m.height).fill(''), objects: [] } } };
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [] }];
  const mm = api.migrateWorld(w).maps[0];
  assert.deepEqual(mm.groups, []);
  assert.deepEqual(mm.seen.groups, []);
  assert.deepEqual(mm.views.a.seen.groups, []);
  assert.doesNotThrow(() => api.checkWorld(api.migrateWorld(api.emptyWorld()), true));
});

test('schema 接受地面组、物件组、记忆组和贴图媒体', () => {
  assert.doesNotThrow(() => api.checkWorld(validWorld()));
});

test('schema 拒绝重复组 ID、重复/越界小格和坏贴图字段', () => {
  const w = validWorld();
  w.maps[0].groups.push({ id: 'g-terrain', name: '重复', cells: [] });
  assert.throws(() => api.checkWorld(w), /groups.*重复的 ID/);

  const dup = validWorld();
  dup.maps[0].groups[0].cells.push(dup.maps[0].groups[0].cells[0]);
  assert.throws(() => api.checkWorld(dup), /重复的小格/);

  const out = validWorld();
  out.maps[0].groups[0].cells = [out.maps[0].width * out.maps[0].height * 9];
  assert.throws(() => api.checkWorld(out), /cells\[0\]/);

  const fit = validWorld();
  fit.maps[0].groups[0].texture.fit = 'stretch';
  assert.throws(() => api.checkWorld(fit), /texture\.fit/);

  const opacity = validWorld();
  opacity.maps[0].groups[0].texture.opacity = 1.2;
  assert.throws(() => api.checkWorld(opacity), /texture\.opacity/);
});

test('schema 校验 bounds 与记忆层内部字段', () => {
  const ok = validWorld();
  ok.maps[0].groups[0].bounds = { x0: 0, y0: 0, x1: ok.maps[0].width * 3, y1: ok.maps[0].height * 3 };
  assert.doesNotThrow(() => api.checkWorld(ok));

  const bad = validWorld();
  bad.maps[0].groups[0].bounds = { x0: -1, y0: 0, x1: 2, y1: 2 };
  assert.throws(() => api.checkWorld(bad), /bounds\.x0/);

  const inverted = validWorld();
  inverted.maps[0].seen.groups[0].bounds = { x0: 3, y0: 0, x1: 2, y1: 2 };
  assert.throws(() => api.checkWorld(inverted), /bounds/);

  const liveInternal = validWorld();
  liveInternal.maps[0].groups[0].sourceId = 'g-terrain';
  assert.throws(() => api.checkWorld(liveInternal), /sourceId/);

  const memInternal = validWorld();
  memInternal.maps[0].seen.groups[0].sourceId = 'g-terrain';
  memInternal.maps[0].seen.groups[0].textureKey = 'tex~fill~0.8';
  memInternal.maps[0].seen.groupRevs = { 'g-terrain~tex~fill~0.8': 3 };
  assert.doesNotThrow(() => api.checkWorld(memInternal));

  const badRev = validWorld();
  badRev.maps[0].seen.groupRevs = { g: -1 };
  assert.throws(() => api.checkWorld(badRev), /groupRevs/);
});

test('schema 拒绝不存在的贴图媒体和物件引用', () => {
  const missingMedia = validWorld();
  missingMedia.maps[0].groups[0].texture.mediaId = 'nope';
  assert.throws(() => api.checkWorld(missingMedia), /找不到媒体/);

  const missingObject = validWorld();
  missingObject.maps[0].groups[1].objectId = 'ghost';
  assert.throws(() => api.checkWorld(missingObject), /找不到物件/);

  const badMemory = validWorld();
  badMemory.maps[0].seen.groups[0].texture.mediaId = 'nope';
  // 记忆里的旧贴图不在当前媒体表也能读，记忆组只查结构。
  assert.doesNotThrow(() => api.checkWorld(badMemory));
});

test('迁移后缺少 groups 会被 migrated 校验拦下', () => {
  const w = validWorld();
  delete w.maps[0].groups;
  assert.throws(() => api.checkWorld(w, true), /groups.*缺失/);
});

test('groupBounds 取任意形状的包围盒，空组返回 null', () => {
  const m = api.newMap('边界', '测试', 0, 4, 3, 'floor', false);
  const b = api.groupBounds(m.width, [key(m, 0, 2), key(m, 5, 0), key(m, 2, 4)], m.height);
  assert.deepEqual(b, { x0: 0, y0: 0, x1: 6, y1: 5 });
  assert.equal(api.groupBounds(m.width, []), null);
  assert.equal(api.groupBounds(m.width, [-1, 1.5]), null);
  assert.equal(api.groupBounds(m.width, [999999], m.height), null);
});

test('物件脚印按锚点偏移，整组平移会丢掉出界格', () => {
  const m = api.newMap('脚印', '测试', 0, 5, 4, 'floor', false);
  const cells = api.objectFootprintCells(m.width, m.height, { x: 1, y: 1, w: 1, h: 1, anchor: { x: 1, y: 2 } });
  assert.equal(cells.length, 9);
  assert.deepEqual(api.groupBounds(m.width, cells, m.height), { x0: 4, y0: 5, x1: 7, y1: 8 });

  const border = api.objectFootprintCells(4, 3, { x: 3, y: 2, w: 2, h: 2 });
  assert.deepEqual(api.groupBounds(4, border, 3), { x0: 9, y0: 6, x1: 12, y1: 9 });

  const moved = api.shiftGroupCells(4, 3, [api.fineKey(4, 0, 0), api.fineKey(4, 3, 8), -1], 1, 1);
  assert.deepEqual(moved, [api.fineKey(4, 1, 1)]);

  const fractional = api.objectFootprintCells(5, 4, { x: 1, y: 1, w: 1, h: 1, anchor: { x: 1.5, y: 2.5 } });
  assert.deepEqual(api.groupBounds(5, fractional, 4), { x0: 4, y0: 5, x1: 7, y1: 8 });
});
