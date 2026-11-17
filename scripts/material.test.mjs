import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-material-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/scene/material'; export * from './src/scene/terrain'; export * from './src/scene/memory'; export * from './src/core/defaults'; export * from './src/core/grid'; export * from './src/core/schema.js'; export * from './src/runtime/actions'; export * from './src/core/store'; export * from './src/runtime/sync'; export * from './src/scene/render'; export * from './src/scene/vision';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.location = { search: '', origin: 'http://localhost' };
globalThis.window = { setTimeout: () => 0, open: () => ({ closed: false, postMessage() {} }) };
globalThis.BroadcastChannel = class { postMessage() {} };
globalThis.Path2D = class { moveTo() {} lineTo() {} rect() {} arc() {} closePath() {} };
const api = createRequire(import.meta.url)(bundle);
after(() => rm(temp, { recursive: true, force: true }));

function fixture(pcId) {
  const world = api.emptyWorld();
  const map = api.newMap('测试', '测试', 0, 10, 10, 'floor', false);
  map.autoFog = false;
  map.fog.fill(1);
  map.seen.cells = map.cells.slice();
  world.maps = [map];
  if (pcId) {
    world.party = [{ id: pcId, name: '甲', tags: [], color: '#fff' }];
    map.tokens = [{ id: 't1', pcId, name: '甲', color: '#fff', x: 1, y: 1 }];
  }
  api.replaceWorld(world);
  return { world, map };
}

test('材质层：大格材质、小格覆盖，以及退回大格', () => {
  const { map } = fixture();
  api.paintMaterialCells(map.id, [[2, 2]], 'wood');
  let m = api.findMap(api.getWorld(), map.id);
  assert.equal(api.materialAtCell(m, 2 * m.width + 2), 'wood');
  assert.equal(api.materialAtSubcell(m, 6, 6), 'wood'); // 小格没覆盖，读大格
  api.paintMaterialSubcells(map.id, [[21, 21]], 'stone'); // 主格 (7,7)，不需要细分
  m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.subdivisions, undefined);
  assert.equal(api.materialAtSubcell(m, 21, 21), 'stone');
  assert.equal(api.materialAtSubcell(m, 22, 21), ''); // 同格没覆盖，也没有大格材质
});

test('大格材质会清掉这一格下的小格材质覆盖', () => {
  const { map } = fixture();
  api.paintMaterialSubcells(map.id, [[21, 21]], 'stone');
  api.paintMaterialCells(map.id, [[7, 7]], 'wood');
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(api.materialAtSubcell(m, 21, 21), 'wood');
  assert.equal(m.fineMaterials[api.fineKeyOf(m, 21, 21)], undefined);
});

test('橡皮擦材质不碰地形，擦完退回地形颜色', () => {
  const { map } = fixture();
  api.paintTerrainSubcells(map.id, [[21, 21]], 'grass');
  api.paintMaterialSubcells(map.id, [[21, 21]], 'stone');
  api.paintMaterialSubcells(map.id, [[21, 21]], null);
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(api.materialAtSubcell(m, 21, 21), '');
  assert.equal(api.terrainAtSubcell(m, 21, 21), 'grass');
  assert.equal(m.fineMaterials[api.fineKeyOf(m, 21, 21)], undefined);
});

test('材质层存档结构校验通过；未知世界会补默认材质表', () => {
  const { world, map } = fixture();
  api.paintMaterialCells(map.id, [[1, 1], [2, 1]], 'wood');
  api.paintMaterialSubcells(map.id, [[21, 21]], 'stone');
  const w = api.getWorld();
  assert.doesNotThrow(() => api.checkWorld(w));
  const old = structuredClone(w);
  delete old.materials;
  const migrated = api.migrateWorld(old);
  assert.ok(migrated.materials.some((m) => m.id === 'wood'));
});

test('玩家同步：只发看得见的材质和记得的材质', () => {
  const pcId = 'a';
  const { map } = fixture(pcId);
  api.paintMaterialCells(map.id, [[1, 1], [8, 8]], 'wood');
  // 8,8 看不见：从玩家包里去掉；1,1 看得见：发出去。
  api.update((d) => { const m = api.findMap(d, map.id); m.fog[8 * m.width + 8] = 0; m.seen.cells[8 * m.width + 8] = ''; });
  const pm = api.playerWorld(api.getWorld(), map.id, pcId);
  assert.equal(pm.materials.some((m) => m.id === 'wood'), true);
  assert.equal(Object.values(pm.maps[0].materialCells ?? {}).includes('wood'), true);
  assert.equal(Object.keys(pm.maps[0].materialCells ?? {}).length, 1);
  assert.equal(pm.maps[0].materialCells[8 * pm.maps[0].width + 8], undefined);
});

test('玩家记得的材质：离开视野后从 seen.materialCells 取，不读实时层', () => {
  const pcId = 'a';
  const { map } = fixture(pcId);
  api.paintMaterialCells(map.id, [[1, 1]], 'wood');
  api.update((d) => { const m = api.findMap(d, map.id); m.fog[1 * m.width + 1] = 2; });
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.seen.materialCells[1 * m.width + 1], 'wood');
  // 看不见时改实时层，记忆仍保留上一次看见的样子。
  api.paintMaterialCells(map.id, [[1, 1]], 'stone');
  const pm = api.playerWorld(api.getWorld(), map.id, pcId);
  const seen = pm.maps[0].seen;
  assert.equal(seen.materialCells[1 * pm.maps[0].width + 1], 'wood');
});

test('扩图会平移材质层和小格材质', () => {
  const { map } = fixture();
  api.paintMaterialCells(map.id, [[2, 2]], 'wood');
  api.reshapeMaps([map.id], 1, 0, 0, 0);
  let m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.width, 11);
  assert.equal(m.materialCells[(2 + 1) + 2 * m.width], 'wood');
  assert.equal(m.materialCells[2 + 2 * 10], undefined);
  assert.doesNotThrow(() => api.checkWorld(api.getWorld()));
  api.paintMaterialSubcells(map.id, [[23, 21]], 'stone'); // 扩图后主格 (7,7)
  m = api.findMap(api.getWorld(), map.id);
  const key = api.fineKeyOf(m, 23, 21);
  assert.equal(m.fineMaterials[key], 'stone');
  assert.doesNotThrow(() => api.checkWorld(api.getWorld()));
});


test('玩家记忆材质渲染：fog=2 时画 seen.materialCells，不画实时层', () => {
  const pcId = 'a';
  const { map } = fixture(pcId);
  api.paintMaterialCells(map.id, [[1, 1]], 'wood');
  api.update((d) => { const m = api.findMap(d, map.id); m.fog[1 * m.width + 1] = 2; });
  const m = api.findMap(api.getWorld(), map.id);
  const pm = api.playerMap(m, { fog: m.fog, seen: m.seen });
  assert.equal(pm.materialCells[1 * pm.width + 1], undefined);
  assert.equal(pm.seen.materialCells[1 * pm.width + 1], 'wood');

  const calls = [];
  const state = { fillStyle: '', globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get(t, p) {
      if (p === 'fillRect') return (...args) => calls.push({ style: t.fillStyle, alpha: t.globalAlpha, args });
      if (p === 'measureText') return () => ({ width: 0 });
      if (p in t) return t[p];
      return () => undefined;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
  api.render(ctx, 320, 320, 1, api.getWorld(), pm, { zoom: 1, panX: 0, panY: 0 }, {
    mode: 'player', selection: null, preview: null, hover: null, brush: 1, tool: 'select',
    pending: null, showFog: false, numbers: false, rulers: false,
  });
  const wood = api.getWorld().materials.find((x) => x.id === 'wood').color;
  assert.ok(calls.some((c) => c.style === wood && Math.round(c.args[0]) === 32 && Math.round(c.args[1]) === 32));
});

test('贴图组动作：只改外观，涂/擦一个事务，删物件清物件组', () => {
  const { map } = fixture();
  api.update((d) => { d.media.push({ id: 'tex', name: '木地板', mime: 'image/png', size: 10 }); });
  const id = api.addCellGroup(map.id, '地板');
  assert.ok(id);
  api.paintCellGroup(map.id, id, [[0, 0], [1, 1], [0, 0], [999, 0]]);
  let m = api.findMap(api.getWorld(), map.id);
  let g = m.groups.find((x) => x.id === id);
  assert.deepEqual(g.cells, [api.fineKeyOf(m, 0, 0), api.fineKeyOf(m, 1, 1)]);
  assert.equal(m.cells[0], 'floor'); // 不碰地形
  assert.equal(m.materialCells?.[0], undefined); // 不碰材质

  // 一次拖动两次涂只占一步撤销。
  api.beginBatch();
  api.paintCellGroup(map.id, id, [[2, 2]]);
  api.paintCellGroup(map.id, id, [[3, 3]]);
  api.endBatch();
  api.undo();
  m = api.findMap(api.getWorld(), map.id);
  g = m.groups.find((x) => x.id === id);
  assert.deepEqual(g.cells, [api.fineKeyOf(m, 0, 0), api.fineKeyOf(m, 1, 1)]);

  api.paintCellGroup(map.id, id, [[0, 0]], true); // Shift 擦
  m = api.findMap(api.getWorld(), map.id);
  assert.deepEqual(m.groups.find((x) => x.id === id).cells, [api.fineKeyOf(m, 1, 1)]);

  api.setCellGroupTexture(map.id, id, 'tex');
  api.setCellGroupFit(map.id, id, 'contain');
  api.setCellGroupOpacity(map.id, id, 2);
  api.setCellGroupZ(map.id, id, 12);
  m = api.findMap(api.getWorld(), map.id);
  g = m.groups.find((x) => x.id === id);
  assert.deepEqual(g.texture, { mediaId: 'tex', fit: 'contain', opacity: 1 });
  assert.equal(g.z, 12);
  assert.doesNotThrow(() => api.checkWorld(api.getWorld()));

  api.deleteCellGroup(map.id, id);
  m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.groups.some((x) => x.id === id), false);

  api.update((d) => {
    const dm = api.findMap(d, map.id);
    dm.objects.push({ ...api.newObject('object', 4, 4, 1, 1), id: 'og' });
    dm.groups.push({ id: 'go', name: '物件贴图', cells: [api.fineKeyOf(dm, 12, 12)], objectId: 'og' });
  });
  api.deleteMapObject(map.id, 'og');
  m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.groups.some((x) => x.id === 'go'), false);
});

test('玩家贴图组：只发看得见的格子，只看见一角不带整组包围盒，只带用到的贴图媒体', () => {
  const pcId = 'a';
  const { map } = fixture(pcId);
  api.update((d) => {
    d.media.push({ id: 'tex', name: '地板贴图', mime: 'image/png', size: 10 });
    d.media.push({ id: 'secret-tex', name: '隐藏贴图', mime: 'image/png', size: 10 });
    const m = api.findMap(d, map.id);
    m.groups = [
      { id: 'floor', name: '地板', cells: [api.fineKeyOf(m, 3, 3), api.fineKeyOf(m, 24, 24)], texture: { mediaId: 'tex' }, z: 0 },
      { id: 'full', name: '整块可见', cells: [api.fineKeyOf(m, 0, 0), api.fineKeyOf(m, 1, 0)], texture: { mediaId: 'tex' }, z: 1 },
      { id: 'hidden', name: '暗格', cells: [api.fineKeyOf(m, 24, 24)], texture: { mediaId: 'secret-tex' }, z: 10 },
    ];
    m.fog[8 * m.width + 8] = 0; // 右下看不见；floor 只看见左上那格
  });
  const world = api.getWorld();
  const pm = api.playerWorld(world, map.id, pcId);
  const pg = pm.maps[0].groups;
  assert.equal(pg.length, 2);
  const floor = pg.find((g) => g.id === 'floor');
  assert.deepEqual(floor.cells, [api.fineKeyOf(map, 3, 3)]);
  assert.equal(floor.bounds, undefined); // 只看见一角：不泄露整组范围
  assert.equal(floor.name, '贴图');
  const full = pg.find((g) => g.id === 'full');
  assert.deepEqual(full.bounds, { x0: 0, y0: 0, x1: 2, y1: 1 });
  assert.equal(pm.media.some((m) => m.id === 'tex'), true);
  assert.equal(pm.media.some((m) => m.id === 'secret-tex'), false);
  assert.equal(pm.media.find((m) => m.id === 'tex').name, '贴图'); // 文件名也不给玩家
  assert.deepEqual(pm.maps[0].seen.groups, []);
  assert.ok(!JSON.stringify(pm).includes('secret-tex'));
  assert.ok(!JSON.stringify(pm).includes('暗格'));
  assert.doesNotThrow(() => api.checkWorld(world));
});

test('灰区记忆贴图：转灰后贴图不消失，只带记得的格子和媒体', () => {
  const pcId = 'a';
  const { map } = fixture(pcId);
  api.update((d) => {
    d.media.push({ id: 'tex', name: '密室地板.png', mime: 'image/png', size: 10 });
    const m = api.findMap(d, map.id);
    m.groups = [{ id: 'g', name: '密室地板', cells: [api.fineKeyOf(m, 3, 3)], texture: { mediaId: 'tex' } }];
  });
  // 先看见，再转灰。
  api.update((d) => { const m = api.findMap(d, map.id); m.fog[1 * m.width + 1] = 2; });
  const world = api.getWorld();
  const pm = api.playerWorld(world, map.id, pcId);
  assert.deepEqual(pm.maps[0].groups, []); // 实时层没有
  assert.equal(pm.maps[0].seen.groups.length, 1);
  const mg = pm.maps[0].seen.groups[0];
  assert.deepEqual(mg.cells, [api.fineKeyOf(map, 3, 3)]);
  assert.deepEqual(mg.bounds, { x0: 3, y0: 3, x1: 4, y1: 4 });
  assert.equal(mg.name, '贴图');
  assert.equal(mg.texture.mediaId, 'tex');
  assert.equal(pm.media.find((m) => m.id === 'tex').name, '贴图');
  assert.doesNotThrow(() => api.checkWorld(world));

  const Old = globalThis.Path2D;
  globalThis.Path2D = class { rect() {} moveTo() {} lineTo() {} arc() {} closePath() {} };
  const live = [], seen = [];
  const ctx = { globalAlpha: 1, save() {}, restore() {}, beginPath() {}, clip() {}, drawImage(...args) { seen.push(args); } };
  const ctxLive = { globalAlpha: 1, save() {}, restore() {}, beginPath() {}, clip() {}, drawImage(...args) { live.push(args); } };
  try {
    api.drawCellGroups(ctxLive, pm.maps[0], () => ({ naturalWidth: 10, naturalHeight: 10 }));
    api.drawSeenCellGroups(ctx, pm.maps[0], () => ({ naturalWidth: 10, naturalHeight: 10 }));
  } finally { globalThis.Path2D = Old; }
  assert.equal(live.length, 0);
  assert.equal(seen.length, 1);
});

test('drawCellGroups：按 z 铺图、只画有地形的小格、物件组留给下一步', () => {
  const { map } = fixture();
  api.update((d) => {
    const m = api.findMap(d, map.id);
    m.fineCells[api.fineKeyOf(m, 2, 0)] = ''; // 组里留一格空地，不该铺图
    m.groups = [
      { id: 'decal', name: '贴花', cells: [api.fineKeyOf(m, 0, 3), api.fineKeyOf(m, 2, 3)], texture: { mediaId: 'decal', fit: 'fill' }, z: 10 },
      { id: 'ground', name: '地面', cells: [api.fineKeyOf(m, 0, 0), api.fineKeyOf(m, 1, 0), api.fineKeyOf(m, 2, 0)], texture: { mediaId: 'ground', fit: 'fill', opacity: 0.5 }, z: 0 },
      { id: 'obj', name: '物件', cells: [api.fineKeyOf(m, 9, 9)], texture: { mediaId: 'obj' }, objectId: 'o1' },
      { id: 'bare', name: '没图', cells: [api.fineKeyOf(m, 9, 0)] },
    ];
    m.objects = [{ ...api.newObject('object', 3, 3, 1, 1), id: 'o1' }];
  });
  const m = api.findMap(api.getWorld(), map.id);
  const Old = globalThis.Path2D;
  const rects = [];
  globalThis.Path2D = class { rect(...args) { rects.push(args); } moveTo() {} lineTo() {} arc() {} closePath() {} };
  const draws = [], imageCalls = [];
  const ctx = {
    globalAlpha: 1, save() {}, restore() {}, beginPath() {}, clip() {},
    drawImage(...args) { draws.push({ alpha: this.globalAlpha, args }); },
  };
  try {
    api.drawCellGroups(ctx, m, (id) => { imageCalls.push(id); return id === 'obj' || id === 'bare' ? null : { naturalWidth: 200, naturalHeight: 100 }; });
  } finally { globalThis.Path2D = Old; }
  assert.ok(!imageCalls.includes('obj')); // 物件组不铺地面
  assert.deepEqual(imageCalls, ['ground', 'decal']);
  assert.equal(rects.length, 4); // ground 3 格里 1 格空地，decal 2 格
  assert.deepEqual(draws.map((d) => d.args[0]), [{ naturalWidth: 200, naturalHeight: 100 }, { naturalWidth: 200, naturalHeight: 100 }]);
  assert.equal(draws[0].alpha, 0.5);
  assert.equal(draws[1].alpha, 1);
  assert.equal(draws[0].args[1], 0);
  assert.equal(draws[0].args[2], 0);
  assert.equal(Math.round(draws[0].args[3]), 32);
  assert.equal(Math.round(draws[0].args[4]), Math.round(32 / 3));

  // contain：一格的包围盒里按图片比例居中。
  api.update((d) => { const dm = api.findMap(d, map.id); dm.groups = [{ id: 'c', name: 'contain', cells: [api.fineKeyOf(dm, 0, 6)], texture: { mediaId: 'c', fit: 'contain' } }]; });
  const cm = api.findMap(api.getWorld(), map.id);
  const contain = [];
  const ctx2 = { globalAlpha: 1, save() {}, restore() {}, beginPath() {}, clip() {}, drawImage(...args) { contain.push(args); } };
  globalThis.Path2D = class { rect() {} moveTo() {} lineTo() {} arc() {} closePath() {} };
  try { api.drawCellGroups(ctx2, cm, () => ({ naturalWidth: 200, naturalHeight: 100 })); } finally { globalThis.Path2D = Old; }
  assert.equal(contain.length, 1);
  assert.equal(Math.round(contain[0][3]), Math.round(32 / 3));
  assert.equal(Math.round(contain[0][4]), Math.round(32 / 6));
  assert.equal(Math.round(contain[0][2]), Math.round(2 * 32 + 32 / 12)); // 格子 y=2，垂直居中
});

test('mergeLayers：多份记忆贴图按组取并集，贴图取最新一版', () => {
  const { map } = fixture();
  const a = api.emptyVision(100), b = api.emptyVision(100);
  a.fog[1 * map.width + 1] = 2; b.fog[1 * map.width + 1] = 2;
  a.seen.groups = [{ id: 'g', name: '旧', cells: [api.fineKeyOf(map, 3, 3)], texture: { mediaId: 'old' }, z: 0 }];
  b.seen.groups = [{ id: 'g', name: '新', cells: [api.fineKeyOf(map, 4, 3)], texture: { mediaId: 'new' }, z: 2 }];
  a.seen.groupRevs = { g: 1 }; b.seen.groupRevs = { g: 2 };
  const out = api.mergeLayers(map, [a, b]);
  assert.equal(out.seen.groups.length, 1);
  assert.deepEqual(out.seen.groups[0].cells, [api.fineKeyOf(map, 3, 3), api.fineKeyOf(map, 4, 3)]);
  assert.equal(out.seen.groups[0].name, '新');
  assert.equal(out.seen.groups[0].texture.mediaId, 'new');
  assert.equal(out.seen.groupRevs.g, 2);
});

test('贴图版本：部分可见时换图，灰区格子保留旧图，可见格子用新图', () => {
  const pcId = 'a';
  const { map } = fixture(pcId);
  api.update((d) => {
    d.media.push({ id: 'tex1', name: '旧图', mime: 'image/png', size: 10 });
    d.media.push({ id: 'tex2', name: '新图', mime: 'image/png', size: 10 });
    const m = api.findMap(d, map.id);
    m.groups = [{ id: 'g', name: '地板', cells: [api.fineKeyOf(m, 3, 3), api.fineKeyOf(m, 24, 24)], texture: { mediaId: 'tex1' } }];
  });
  api.update((d) => { const m = api.findMap(d, map.id); m.fog[8 * m.width + 8] = 2; }); // B 转灰
  api.update((d) => { const m = api.findMap(d, map.id); m.groups[0].texture.mediaId = 'tex2'; }); // A 还看着，换图
  const world = api.getWorld();
  const pm = api.playerWorld(world, map.id, pcId);
  assert.equal(pm.maps[0].groups[0].texture.mediaId, 'tex2');
  assert.deepEqual(pm.maps[0].groups[0].cells, [api.fineKeyOf(map, 3, 3)]);
  assert.equal(pm.maps[0].seen.groups.length, 1);
  assert.deepEqual(pm.maps[0].seen.groups[0].cells, [api.fineKeyOf(map, 24, 24)]);
  assert.equal(pm.maps[0].seen.groups[0].texture.mediaId, 'tex1');
  assert.match(pm.maps[0].seen.groups[0].id, /^mh/);
  assert.ok(!pm.maps[0].seen.groups[0].id.includes('~'));
  const oldMemoryId = pm.maps[0].seen.groups[0].id;
  assert.ok(!('sourceId' in pm.maps[0].seen.groups[0]));
  assert.ok(!('textureKey' in pm.maps[0].seen.groups[0]));
  assert.ok(!JSON.stringify(pm).includes('sourceId'));
  assert.ok(!JSON.stringify(pm).includes('textureKey'));
  assert.ok(!JSON.stringify(pm).includes('tex1~fill~1'));
  assert.deepEqual(pm.media.map((m) => m.name), ['贴图', '贴图']);
  assert.doesNotThrow(() => api.checkWorld(world));
  // A 也转灰后，两版记忆都还在：A 用 tex2，B 用 tex1。
  api.update((d) => { const m = api.findMap(d, map.id); m.fog[1 * m.width + 1] = 2; });
  const pm2 = api.playerWorld(api.getWorld(), map.id, pcId);
  assert.deepEqual(pm2.maps[0].groups, []);
  assert.equal(pm2.maps[0].seen.groups.length, 2);
  const byTex = Object.fromEntries(pm2.maps[0].seen.groups.map((g) => [g.texture.mediaId, g.cells]));
  assert.deepEqual(byTex.tex1, [api.fineKeyOf(map, 24, 24)]);
  assert.deepEqual(byTex.tex2, [api.fineKeyOf(map, 3, 3)]);
  assert.equal(new Set(pm2.maps[0].seen.groups.map((g) => g.id)).size, 2);
  assert.equal(pm2.maps[0].seen.groups.find((g) => g.texture.mediaId === 'tex1').id, oldMemoryId);
  for (const g of pm2.maps[0].seen.groups) assert.match(g.id, /^mh/) && assert.ok(!('sourceId' in g) && !('textureKey' in g));
});

test('删媒体会清掉实时组、记忆组和各视野的贴图引用', () => {
  const pcId = 'a';
  const { map } = fixture(pcId);
  api.update((d) => {
    d.media.push({ id: 'tex', name: '旧地板', mime: 'image/png', size: 10 });
    const m = api.findMap(d, map.id);
    const o = { ...api.newObject('object', 4, 4, 1, 1), id: 'om', media: [{ id: 'am', mediaId: 'tex', label: '附件', trigger: 'manual', broadcast: false, once: false }] };
    m.objects.push(o);
    m.groups = [{ id: 'g', name: '地板', cells: [api.fineKeyOf(m, 3, 3), api.fineKeyOf(m, 24, 24)], texture: { mediaId: 'tex' } }];
  });
  api.update((d) => { const m = api.findMap(d, map.id); m.fog[8 * m.width + 8] = 2; });
  api.deleteMedia('tex');
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.groups[0].texture, undefined);
  assert.equal(m.seen.groups.every((g) => g.texture === undefined), true);
  assert.deepEqual(m.objects.find((o) => o.id === 'om').media, []);
  assert.doesNotThrow(() => api.checkWorld(api.getWorld()));
  const pm = api.playerWorld(api.getWorld(), map.id, pcId);
  assert.deepEqual(pm.media, []);
  assert.equal(JSON.stringify(pm).includes('tex'), false);
});

test('缩图会把贴图组 bounds 按剩余格子重算，不留旧图的超大矩形', () => {
  const { map } = fixture();
  api.update((d) => {
    const m = api.findMap(d, map.id);
    m.groups = [{ id: 'g', name: '地板', cells: [api.fineKeyOf(m, 21, 24), api.fineKeyOf(m, 24, 24)] }];
    m.groups[0].bounds = { x0: 3, y0: 3, x1: 25, y1: 25 };
  });
  api.reshapeMaps([map.id], -5, 0, 0, 0);
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.width, 5);
  assert.deepEqual(m.groups[0].cells, [api.fineKeyOf(m, 6, 24), api.fineKeyOf(m, 9, 24)]);
  assert.deepEqual(m.groups[0].bounds, { x0: 6, y0: 24, x1: 10, y1: 25 });
  assert.doesNotThrow(() => api.checkWorld(api.getWorld()));
});

test('playerMap 实时组也显式挑字段，不把 sourceId/textureKey 带出去', () => {
  const pcId = 'a';
  const { map } = fixture(pcId);
  api.update((d) => {
    d.media.push({ id: 'tex', name: '地板', mime: 'image/png', size: 10 });
    const m = api.findMap(d, map.id);
    m.groups = [{ id: 'g', name: '地板', cells: [api.fineKeyOf(m, 3, 3)], texture: { mediaId: 'tex' }, sourceId: 'secret-source', textureKey: 'secret-key' }];
  });
  const pm = api.playerWorld(api.getWorld(), map.id, pcId);
  assert.equal(JSON.stringify(pm).includes('sourceId'), false);
  assert.equal(JSON.stringify(pm).includes('textureKey'), false);
  assert.equal(JSON.stringify(pm).includes('secret-source'), false);
  assert.equal(pm.maps[0].groups[0].name, '贴图');
});

test('旧记忆组 id 归一：旧 id 会并回「原组~版本」', () => {
  const pcId = 'a';
  const { map } = fixture(pcId);
  api.update((d) => {
    d.media.push({ id: 'tex', name: '地板', mime: 'image/png', size: 10 });
    const m = api.findMap(d, map.id);
    m.groups = [{ id: 'g', name: '地板', cells: [api.fineKeyOf(m, 3, 3), api.fineKeyOf(m, 24, 24)], texture: { mediaId: 'tex' } }];
  });
  api.update((d) => {
    const m = api.findMap(d, map.id);
    m.fog[8 * m.width + 8] = 2; // B 灰
    m.seen.groups = [{ id: 'g', name: '旧记忆', cells: [api.fineKeyOf(m, 24, 24)], texture: { mediaId: 'tex' } }]; // 老工程：没有 sourceId/textureKey
  });
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.seen.groups.length, 1);
  assert.equal(m.seen.groups[0].id, 'g~' + m.seen.groups[0].textureKey);
  assert.deepEqual(m.seen.groups[0].cells, [api.fineKeyOf(m, 3, 3), api.fineKeyOf(m, 24, 24)]);
  assert.equal(m.seen.groups[0].sourceId, 'g');
  assert.equal(m.seen.groups[0].textureKey, ['tex', 'fill', '1'].join('~'));
  assert.doesNotThrow(() => api.checkWorld(api.getWorld()));
});

test('pruneMemory 会把 fog=0 的贴图组清掉', () => {
  const { map } = fixture();
  const L = api.emptyVision(map.width * map.height);
  L.fog.fill(0);
  const key = ['tex', 'fill', '1'].join('~');
  L.seen.groups = [{ id: `g~${key}`, name: '地板', cells: [api.fineKeyOf(map, 3, 3)], texture: { mediaId: 'tex' }, sourceId: 'g', textureKey: key }];
  api.pruneMemory(map, L);
  assert.deepEqual(L.seen.groups, []);
});

test('render 玩家模式真的会调用 drawSeenCellGroups 画灰区贴图', () => {
  const pcId = 'a';
  const { map } = fixture(pcId);
  api.update((d) => {
    d.media.push({ id: 'tex', name: '地板', mime: 'image/png', size: 10 });
    const m = api.findMap(d, map.id);
    m.groups = [{ id: 'g', name: '地板', cells: [api.fineKeyOf(m, 3, 3)], texture: { mediaId: 'tex' } }];
  });
  api.update((d) => { const m = api.findMap(d, map.id); m.fog[1 * m.width + 1] = 2; });
  const world = api.getWorld();
  const pm = api.playerWorld(world, map.id, pcId);
  const calls = [];
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop === 'drawImage') return (...args) => calls.push(args);
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop in target) return target[prop];
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  api.render(ctx, 640, 480, 1, world, pm.maps[0], { zoom: 1, panX: 0, panY: 0 }, {
    mode: 'player', selection: null, preview: null, hover: null, brush: 1, tool: 'select', pending: null, showFog: true,
    imageOf: () => ({ naturalWidth: 10, naturalHeight: 10 }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].naturalWidth, 10);
});

test('贴图版本键区分 fit/opacity，换回旧版本会并回旧灰格', () => {
  const pcId = 'a';
  const { map } = fixture(pcId);
  api.update((d) => {
    d.media.push({ id: 'tex', name: '地板', mime: 'image/png', size: 10 });
    const m = api.findMap(d, map.id);
    m.groups = [{ id: 'g', name: '地板', cells: [api.fineKeyOf(m, 3, 3), api.fineKeyOf(m, 24, 24)], texture: { mediaId: 'tex', fit: 'fill', opacity: 1 } }];
  });
  api.update((d) => { const m = api.findMap(d, map.id); m.fog[8 * m.width + 8] = 2; });
  api.update((d) => { const m = api.findMap(d, map.id); m.groups[0].texture = { mediaId: 'tex', fit: 'contain', opacity: 0.5 }; });
  const pm = api.playerWorld(api.getWorld(), map.id, pcId);
  assert.equal(pm.maps[0].groups[0].texture.fit, 'contain');
  assert.equal(pm.maps[0].groups[0].texture.opacity, 0.5);
  assert.deepEqual(pm.maps[0].seen.groups.map((g) => g.texture.fit), ['fill']);
  api.update((d) => { const m = api.findMap(d, map.id); m.groups[0].texture = { mediaId: 'tex', fit: 'fill', opacity: 1 }; });
  const m2 = api.findMap(api.getWorld(), map.id);
  assert.equal(m2.seen.groups.filter((g) => g.sourceId === 'g').length, 1);
  assert.equal(m2.seen.groups[0].texture.fit, 'fill');
});

test('playerMap 记忆组 id 稳定、碰撞加后缀、同源同版本并组', () => {
  const { map } = fixture();
  const L = api.emptyVision(map.width * map.height);
  L.fog.fill(1);
  L.fog[1 * map.width + 1] = 2;
  L.fog[8 * map.width + 8] = 2;
  const version = ['tex', 'fill', '1'].join('~');
  L.seen.groups = [
    { id: 'old-a', name: '旧', cells: [api.fineKeyOf(map, 3, 3)], texture: { mediaId: 'tex' }, sourceId: 'g', textureKey: version },
    { id: 'old-b', name: '旧', cells: [api.fineKeyOf(map, 24, 24)], texture: { mediaId: 'tex' }, sourceId: 'g', textureKey: version },
  ];
  const pm = api.playerMap(map, L);
  assert.equal(pm.seen.groups.length, 1);
  assert.deepEqual(pm.seen.groups[0].cells, [api.fineKeyOf(map, 3, 3), api.fineKeyOf(map, 24, 24)]);
  const stable = pm.seen.groups[0].id;
  assert.equal(api.playerMap(map, L).seen.groups[0].id, stable);

  // 与实时组 id 撞车时加后缀，仍然不和 live id 相同。
  let h = 2166136261;
  const text = 'g\u0000' + version;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  const collision = `mh${(h >>> 0).toString(36)}`;
  const map2 = { ...map, groups: [{ id: collision, name: '实时', cells: [api.fineKeyOf(map, 0, 0)], texture: { mediaId: 'tex' } }] };
  const pm2 = api.playerMap(map2, L);
  assert.notEqual(pm2.seen.groups[0].id, collision);
  assert.equal(pm2.seen.groups[0].id.startsWith(collision), true);
});
