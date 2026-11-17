import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-objectgroup-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/runtime/actions'; export * from './src/core/store'; export * from './src/core/grid'; export * from './src/core/defaults'; export * from './src/core/schema.js'; export * from './src/scene/memory';`, resolveDir: root },
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

const tex = { id: 'tex', name: '木纹', mime: 'image/png', size: 1 };
function fixture() {
  const w = api.emptyWorld();
  const m = w.maps[0];
  w.media = [tex];
  const o = { ...api.newObject('object', 1, 1, 1, 1), id: 'obj' };
  m.objects = [o];
  api.replaceWorld(w);
  return { mapId: m.id };
}
const curMap = (id) => api.findMap(api.getWorld(), id);
const footprint = (m, o) => api.objectFootprintCells(m.width, m.height, o);

test('setObjectTexture 按物件脚印建一个物件组', () => {
  const { mapId } = fixture();
  const gid = api.setObjectTexture(mapId, 'obj', 'tex');
  assert.ok(gid);
  const m = curMap(mapId), g = m.groups.find((x) => x.id === gid), o = m.objects.find((x) => x.id === 'obj');
  assert.equal(g.objectId, 'obj');
  assert.deepEqual(g.cells, footprint(m, o));
  assert.deepEqual(g.bounds, api.groupBounds(m.width, g.cells, m.height));
  assert.equal(g.texture.mediaId, 'tex');
  assert.doesNotThrow(() => api.checkWorld(api.getWorld()));
});

test('再设同一物件不会生成第二个组，保留铺法和不透明度', () => {
  const { mapId } = fixture();
  const a = api.setObjectTexture(mapId, 'obj', 'tex', 'contain');
  api.setCellGroupOpacity(mapId, a, 0.4);
  const b = api.setObjectTexture(mapId, 'obj', 'tex');
  assert.equal(a, b);
  const m = curMap(mapId);
  assert.equal(m.groups.filter((g) => g.objectId === 'obj').length, 1);
  assert.deepEqual(m.groups.find((g) => g.id === a).texture, { mediaId: 'tex', fit: 'contain', opacity: 0.4 });
});

test('clearObjectTexture 删组不留空组', () => {
  const { mapId } = fixture();
  api.setObjectTexture(mapId, 'obj', 'tex');
  api.clearObjectTexture(mapId, 'obj');
  assert.equal(curMap(mapId).groups.some((g) => g.objectId === 'obj'), false);
  assert.doesNotThrow(() => api.checkWorld(api.getWorld()));
});

test('物件移动后组格子跟到新脚印', () => {
  const { mapId } = fixture();
  api.setObjectTexture(mapId, 'obj', 'tex');
  api.update((d) => {
    const od = api.findMap(d, mapId).objects.find((o) => o.id === 'obj');
    od.x = 4; od.y = 2; od.anchor = { x: 1, y: 2 };
  });
  const m = curMap(mapId), g = m.groups.find((x) => x.objectId === 'obj'), o = m.objects.find((x) => x.id === 'obj');
  assert.deepEqual(g.cells, footprint(m, o));
  assert.deepEqual(g.bounds, api.groupBounds(m.width, g.cells, m.height));
  assert.doesNotThrow(() => api.checkWorld(api.getWorld()));
});

test('物件改大小后组格子按新脚印重算，贴图不丢', () => {
  const { mapId } = fixture();
  const gid = api.setObjectTexture(mapId, 'obj', 'tex');
  api.update((d) => {
    const od = api.findMap(d, mapId).objects.find((o) => o.id === 'obj');
    od.w = 2; od.h = 2;
  });
  const m = curMap(mapId), g = m.groups.find((x) => x.id === gid), o = m.objects.find((x) => x.id === 'obj');
  assert.deepEqual(g.cells, footprint(m, o));
  assert.equal(g.texture.mediaId, 'tex');
});

test('旧/异形物件组读进来会归一到脚印', () => {
  const w = api.emptyWorld();
  const m = w.maps[0];
  w.media = [tex];
  const o = { ...api.newObject('object', 1, 1, 1, 1), id: 'obj' };
  m.objects = [o];
  m.groups = [{ id: 'old', name: '旧', cells: [api.fineKeyOf(m, 0, 0)], objectId: 'obj' }];
  api.replaceWorld(w);
  const mm = curMap(m.id), g = mm.groups.find((x) => x.id === 'old');
  assert.deepEqual(g.cells, footprint(mm, mm.objects.find((x) => x.id === 'obj')));
  assert.deepEqual(g.bounds, api.groupBounds(mm.width, g.cells, mm.height));
});

test('直接往物件组涂格子会被下一次同步校正回脚印', () => {
  const { mapId } = fixture();
  const gid = api.setObjectTexture(mapId, 'obj', 'tex');
  api.paintCellGroup(mapId, gid, [[0, 0]]);
  const m = curMap(mapId), g = m.groups.find((x) => x.id === gid), o = m.objects.find((x) => x.id === 'obj');
  assert.deepEqual(g.cells, footprint(m, o));
});

test('删除物件会删掉物件组', () => {
  const { mapId } = fixture();
  api.setObjectTexture(mapId, 'obj', 'tex');
  api.deleteMapObject(mapId, 'obj');
  assert.equal(curMap(mapId).groups.some((g) => g.objectId === 'obj'), false);
  assert.doesNotThrow(() => api.checkWorld(api.getWorld()));
});

test('扩图时物件组按新位置重算', () => {
  const { mapId } = fixture();
  api.setObjectTexture(mapId, 'obj', 'tex');
  api.reshapeMaps([mapId], 1, 1, 0, 0);
  const m = curMap(mapId), g = m.groups.find((x) => x.objectId === 'obj'), o = m.objects.find((x) => x.id === 'obj');
  assert.equal(o.x, 2); assert.equal(o.y, 2);
  assert.deepEqual(g.cells, footprint(m, o));
  assert.doesNotThrow(() => api.checkWorld(api.getWorld()));
});

test('复制地图后物件组只有一个并重映射到副本物件', () => {
  const { mapId } = fixture();
  api.setObjectTexture(mapId, 'obj', 'tex');
  api.duplicateMap(mapId);
  const copy = api.getWorld().maps.find((m) => m.id !== mapId);
  const g = copy.groups.find((x) => x.objectId);
  assert.equal(copy.groups.filter((x) => x.objectId).length, 1);
  const o = copy.objects.find((x) => x.id === g.objectId);
  assert.ok(o);
  assert.deepEqual(g.cells, footprint(copy, o));
  assert.doesNotThrow(() => api.checkWorld(api.getWorld()));
});

test('schema 拒绝同一物件两个物件组', () => {
  const w = api.emptyWorld();
  const m = w.maps[0];
  const o = { ...api.newObject('object', 1, 1, 1, 1), id: 'obj' };
  m.objects = [o];
  m.groups = [{ id: 'a', name: 'A', cells: [], objectId: 'obj' }, { id: 'b', name: 'B', cells: [], objectId: 'obj' }];
  assert.throws(() => api.checkWorld(w), /不止一个/);
});

test('建筑物件不接物件贴图', () => {
  const { mapId } = fixture();
  const error = api.addArchitectureWall(mapId, { x: 0, y: 0 }, { x: 3, y: 0 }, 'wall', 1);
  assert.equal(error, null);
  const wall = curMap(mapId).objects.find((o) => o.id !== 'obj');
  assert.ok(wall);
  assert.equal(api.setObjectTexture(mapId, wall.id, 'tex'), null);
});
