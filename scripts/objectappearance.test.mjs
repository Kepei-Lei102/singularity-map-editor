import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-objectappearance-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/runtime/actions'; export * from './src/core/store'; export * from './src/core/grid'; export * from './src/core/defaults'; export * from './src/core/schema.js'; export * from './src/runtime/sync'; export * from './src/scene/render';`, resolveDir: root },
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

const tex = { id: 'tex', name: '柜纹', mime: 'image/png', size: 10 };
const image = { naturalWidth: 100, naturalHeight: 50 };

function fixture(pcId) {
  const w = api.emptyWorld();
  const m = w.maps[0];
  w.media = [tex];
  m.objects = [{ ...api.newObject('object', 1, 1, 1, 1), id: 'o1', name: '柜子', icon: '★', color: '#123456', height: 1 }];
  if (pcId) {
    m.autoFog = false;
    w.party = [{ id: pcId, name: '甲', color: '#fff', tags: [] }];
    m.fog.fill(1); m.seen.cells = m.cells.slice();
  }
  api.replaceWorld(w);
  api.setObjectTexture(m.id, 'o1', 'tex');
  return { world: api.getWorld(), map: api.findMap(api.getWorld(), m.id) };
}

function ctxRecorder() {
  const state = { globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'start', textBaseline: 'alphabetic', lineJoin: 'miter' };
  const stack = [];
  const calls = { fillRect: [], strokeRect: [], drawImage: [], fillText: [], strokeText: [] };
  const ctx = new Proxy(state, {
    get(t, p) {
      if (p === 'measureText') return (text) => ({ width: String(text).length * 6 });
      if (p === 'save') return () => stack.push({ ...t });
      if (p === 'restore') return () => { if (stack.length) Object.assign(t, stack.pop()); };
      if (p === 'fillRect') return (...args) => calls.fillRect.push({ style: t.fillStyle, alpha: t.globalAlpha, args });
      if (p === 'strokeRect') return (...args) => calls.strokeRect.push({ style: t.strokeStyle, alpha: t.globalAlpha, args });
      if (p === 'drawImage') return (...args) => calls.drawImage.push({ alpha: t.globalAlpha, args });
      if (p === 'fillText') return (text, ...args) => calls.fillText.push({ text, style: t.fillStyle, args });
      if (p === 'strokeText') return (text, ...args) => calls.strokeText.push({ text, args });
      if (p in t) return t[p];
      return () => undefined;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
  return { ctx, calls };
}

function renderOnce(world, map, mode = 'edit', viewer) {
  const rec = ctxRecorder();
  api.render(rec.ctx, 640, 480, 1, world, map, { zoom: mode === 'edit' ? 4 : 1, panX: 0, panY: 0 }, {
    mode, selection: null, preview: null, hover: null, brush: 1, tool: 'select', pending: null, showFog: false,
    numbers: false, rulers: false, viewer, imageOf: () => image,
  });
  return rec.calls;
}

const objectGroup = (map) => map.groups.find((g) => g.objectId === 'o1');

test('物件贴图替换底色：画图、不画物件色块，标签不再叠图标', () => {
  const { world, map } = fixture();
  const calls = renderOnce(world, map);
  assert.equal(calls.drawImage.length, 1);
  assert.deepEqual(calls.drawImage[0].args.slice(1, 5), [34, 34, 28, 28]);
  assert.equal(calls.fillRect.some((c) => c.style === '#123456'), false);
  assert.ok(calls.fillText.some((c) => c.text.includes('柜子')));
  assert.equal(calls.fillText.some((c) => c.text.includes('★')), false);
  assert.ok(calls.strokeText.some((c) => c.text.includes('柜子')));
});

test('物件贴图保留 fit/opacity，透明区不补底色', () => {
  const { world, map } = fixture();
  const g = objectGroup(map);
  api.setCellGroupFit(map.id, g.id, 'contain');
  const contain = renderOnce(world, api.findMap(api.getWorld(), map.id));
  assert.equal(contain.drawImage.length, 1);
  assert.deepEqual(contain.drawImage[0].args.slice(1, 5).map(Math.round), [34, 41, 28, 14]);
  assert.equal(contain.fillRect.some((c) => c.style === '#123456'), false);

  api.setCellGroupOpacity(map.id, g.id, 0.5);
  const faded = renderOnce(api.getWorld(), api.findMap(api.getWorld(), map.id));
  assert.equal(faded.drawImage.length, 1);
  assert.equal(faded.drawImage[0].alpha, 0.5);
});

test('清除贴图后回到彩色方块；ghost 状态不画贴图', () => {
  const { world, map } = fixture();
  api.clearObjectTexture(map.id, 'o1');
  const plain = renderOnce(api.getWorld(), api.findMap(api.getWorld(), map.id));
  assert.equal(plain.drawImage.length, 0);
  assert.ok(plain.fillRect.some((c) => c.style === '#123456'));

  api.setObjectTexture(map.id, 'o1', 'tex');
  api.update((d) => { const o = api.findMap(d, map.id).objects.find((x) => x.id === 'o1'); o.states = ['关', '开']; o.state = 1; o.blocksWhen = [0]; });
  const open = renderOnce(api.getWorld(), api.findMap(api.getWorld(), map.id));
  assert.equal(open.drawImage.length, 0);
  assert.ok(open.strokeRect.length > 0);
});

test('setObjectTexture 拒绝不存在/非图片媒体、非法 fit、触发区', () => {
  const { map } = fixture();
  api.update((d) => { d.media.push({ id: 'doc', name: '说明', mime: 'text/plain', size: 1 }); d.maps[0].objects.push({ ...api.newObject('object', 3, 3, 1, 1), id: 'zone', kind: 'zone', name: '区' }); });
  assert.equal(api.setObjectTexture(map.id, 'o1', 'missing'), null);
  assert.equal(api.setObjectTexture(map.id, 'o1', 'doc'), null);
  assert.equal(api.setObjectTexture(map.id, 'o1', 'tex', 'weird'), null);
  assert.equal(api.setObjectTexture(map.id, 'zone', 'tex'), null);
});

test('上传媒体和物件贴图同一个事务，撤销一次回到上传前', () => {
  const { map } = fixture();
  api.clearObjectTexture(map.id, 'o1');
  const before = api.getWorld();
  const id = api.setObjectTexture(map.id, 'o1', 'uploaded', undefined, { id: 'uploaded', name: '新的图', mime: 'image/png', size: 3, key: 'k' });
  assert.ok(id);
  assert.ok(api.getWorld().media.some((m) => m.id === 'uploaded'));
  assert.equal(api.findMap(api.getWorld(), map.id).groups.find((g) => g.objectId === 'o1').texture.mediaId, 'uploaded');
  api.undo();
  assert.equal(api.getWorld(), before);
  assert.equal(api.getWorld().media.some((m) => m.id === 'uploaded'), false);
});

test('玩家实时载荷只发可见物件的贴图组，媒体表带上它', () => {
  const { world, map } = fixture('a');
  const live = api.playerWorld(world, map.id, 'a');
  const pm = live.maps[0];
  const g = pm.groups.find((x) => x.objectId === 'o1');
  assert.ok(g);
  assert.equal(g.texture.mediaId, 'tex');
  assert.equal(g.name, '贴图');
  assert.deepEqual(g.cells, objectGroup(map).cells);
  assert.ok(live.media.some((m) => m.id === 'tex'));

  api.update((d) => { const o = api.findMap(d, map.id).objects.find((x) => x.id === 'o1'); o.hidden = true; });
  const hiddenWorld = api.playerWorld(api.getWorld(), map.id, 'a');
  const hidden = hiddenWorld.maps[0];
  assert.equal(hidden.groups.some((x) => x.objectId === 'o1'), false);
  assert.equal(hidden.objects.some((x) => x.id === 'o1'), false);
  assert.equal(hiddenWorld.media.some((m) => m.id === 'tex'), false);
});

test('玩家实时层 ghost 只画虚线，不画贴图', () => {
  const { map } = fixture('a');
  api.update((d) => { const o = api.findMap(d, map.id).objects.find((x) => x.id === 'o1'); o.states = ['关', '开']; o.state = 1; o.blocksWhen = [0]; });
  const live = api.playerWorld(api.getWorld(), map.id, 'a');
  const po = live.maps[0].objects.find((o) => o.id === 'o1');
  assert.equal(po.ghost, true);
  const calls = renderOnce(live, live.maps[0], 'player');
  assert.equal(calls.drawImage.length, 0);
  assert.ok(calls.strokeRect.length > 0);
  assert.equal(calls.fillRect.some((c) => c.style === '#123456'), false);
});

test('玩家渲染会画物件贴图，且不画物件底色', () => {
  const { world, map } = fixture('a');
  const live = api.playerWorld(world, map.id, 'a');
  const calls = renderOnce(live, live.maps[0], 'player');
  assert.equal(calls.drawImage.length, 1);
  assert.equal(calls.fillRect.some((c) => c.style === '#123456'), false);
});

test('灰区记忆物件不借当前贴图：部分可见时只在实时层画一次', () => {
  const w = api.emptyWorld();
  const m = w.maps[0];
  w.media = [tex];
  m.autoFog = false;
  m.objects = [{ ...api.newObject('object', 2, 2, 2, 2), id: 'o1', name: '柜子', icon: '★', color: '#123456', height: 1, identity: { party: true } }];
  m.fog.fill(2); m.seen.cells = m.cells.slice();
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [] }];
  api.replaceWorld(w);
  api.setObjectTexture(m.id, 'o1', 'tex');
  api.update((d) => { const x = api.findMap(d, m.id); x.fog[2 * x.width + 2] = 1; });
  const live = api.playerWorld(api.getWorld(), m.id, 'a');
  assert.ok(live.maps[0].seen.objects.some((o) => o.id === 'o1'));
  const calls = renderOnce(live, live.maps[0], 'player');
  assert.equal(calls.drawImage.length, 1); // 实时层那张；灰区记忆不能拿当前贴图
  assert.ok(calls.fillText.some((t) => t.text.includes('★'))); // 记忆标签仍有图标
});

test('删媒体会清掉物件贴图，物件回退彩色方块', () => {
  const { map } = fixture();
  api.deleteMedia('tex');
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(m.groups.find((g) => g.objectId === 'o1').texture, undefined);
  const calls = renderOnce(api.getWorld(), m);
  assert.equal(calls.drawImage.length, 0);
  assert.ok(calls.fillRect.some((c) => c.style === '#123456'));
});

test('玩家看不见的物件连贴图组一起不发', () => {
  const { map } = fixture('a');
  api.update((d) => { const m = api.findMap(d, map.id); m.fog.fill(0); });
  const live = api.playerWorld(api.getWorld(), map.id, 'a').maps[0];
  assert.equal(live.objects.some((x) => x.id === 'o1'), false);
  assert.equal(live.groups.some((x) => x.objectId === 'o1'), false);
});
