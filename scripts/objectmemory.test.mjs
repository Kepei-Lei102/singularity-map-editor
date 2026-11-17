import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-objectmemory-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/core/defaults';
export * from './src/core/store';
export * from './src/core/grid';
export * from './src/core/schema.js';
export * from './src/runtime/actions';
export * from './src/runtime/sync';
export * from './src/scene/render';
export * from './src/scene/memory';
export * from './src/scene/vision';`, resolveDir: root },
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

const texA = { id: 'texA', name: '旧图', mime: 'image/png', size: 10 };
const texB = { id: 'texB', name: '新图', mime: 'image/png', size: 10 };
const imgA = { naturalWidth: 100, naturalHeight: 50, tag: 'A' };
const imgB = { naturalWidth: 100, naturalHeight: 50, tag: 'B' };

function fixture(pcId, o = {}) {
  const w = api.emptyWorld();
  const m = w.maps[0];
  w.media = [texA, texB];
  m.objects = [{ ...api.newObject('object', o.x ?? 1, o.y ?? 1, o.w ?? 1, o.h ?? 1), id: 'o1', name: '柜子', icon: '★', color: '#123456', height: 1, identity: { party: true }, ...o }];
  if (pcId) {
    m.autoFog = false;
    w.party = [{ id: pcId, name: '甲', color: '#fff', tags: [] }];
    m.fog.fill(1); m.seen.cells = m.cells.slice();
  }
  api.replaceWorld(w);
  api.setObjectTexture(m.id, 'o1', 'texA');
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
      if (p === 'fillText') return (text, ...args) => calls.fillText.push({ text, args });
      if (p === 'strokeText') return (text, ...args) => calls.strokeText.push({ text, args });
      if (p in t) return t[p];
      return () => undefined;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
  return { ctx, calls };
}

function renderOnce(world, map, mode = 'player') {
  const rec = ctxRecorder();
  api.render(rec.ctx, 640, 480, 1, world, map, { zoom: mode === 'edit' ? 4 : 1, panX: 0, panY: 0 }, {
    mode, selection: null, preview: null, hover: null, brush: 1, tool: 'select', pending: null, showFog: false,
    numbers: false, rulers: false, imageOf: (id) => (id === 'texA' ? imgA : id === 'texB' ? imgB : undefined),
  });
  return rec.calls;
}

const seenObject = (map) => map.seen.objects.find((r) => r.id === 'o1');
const fog = (mapId, fn) => api.update((d) => { const m = api.findMap(d, mapId); fn(m); });

test('看见后转灰：SeenObject 记得最后一版贴图，灰区画旧图', () => {
  const { map } = fixture('a');
  assert.equal(seenObject(map).texture.mediaId, 'texA');
  fog(map.id, (m) => { m.fog.fill(2); });
  const live = api.playerWorld(api.getWorld(), map.id, 'a');
  const pm = live.maps[0];
  assert.equal(seenObject(pm).texture.mediaId, 'texA');
  assert.ok(live.media.some((x) => x.id === 'texA'));
  const calls = renderOnce(live, pm);
  assert.deepEqual(calls.drawImage.map((x) => x.args[0].tag), ['A']);
  assert.equal(calls.fillRect.some((c) => c.style === '#123456'), false);
});

test('完全转灰后换图：灰区保持旧图，重新看见才换', () => {
  const { map } = fixture('a');
  fog(map.id, (m) => { m.fog.fill(2); });
  api.setObjectTexture(map.id, 'o1', 'texB');
  const gray = api.playerWorld(api.getWorld(), map.id, 'a');
  assert.equal(seenObject(gray.maps[0]).texture.mediaId, 'texA');
  assert.deepEqual(gray.media.map((x) => x.id), ['texA']);
  assert.deepEqual(renderOnce(gray, gray.maps[0]).drawImage.map((x) => x.args[0].tag), ['A']);

  fog(map.id, (m) => { m.fog.fill(1); });
  const live = api.playerWorld(api.getWorld(), map.id, 'a');
  assert.equal(seenObject(live.maps[0]).texture.mediaId, 'texB');
  assert.deepEqual(renderOnce(live, live.maps[0]).drawImage.map((x) => x.args[0].tag), ['B']);
});

test('部分可见换图：整件快照当场换新，灰区也跟着新图', () => {
  const { map } = fixture('a', { x: 2, y: 2, w: 2, h: 2 });
  fog(map.id, (m) => { m.fog.fill(2); m.fog[2 * m.width + 2] = 1; });
  api.setObjectTexture(map.id, 'o1', 'texB');
  const live = api.playerWorld(api.getWorld(), map.id, 'a');
  assert.equal(seenObject(live.maps[0]).texture.mediaId, 'texB');
  assert.deepEqual(renderOnce(live, live.maps[0]).drawImage.map((x) => x.args[0].tag), ['B', 'B']);
});

test('灰区 ghost：记当时的开态，灰区画虚线不画贴图', () => {
  const { map } = fixture('a', { states: ['关', '开'], state: 1, blocksWhen: [0] });
  assert.equal(seenObject(map).ghost, true);
  fog(map.id, (m) => { m.fog.fill(2); });
  const live = api.playerWorld(api.getWorld(), map.id, 'a');
  assert.equal(seenObject(live.maps[0]).ghost, true);
  assert.equal(live.media.some((x) => x.id === 'texA'), false);
  assert.doesNotThrow(() => api.checkWorld(live));
  const calls = renderOnce(live, live.maps[0]);
  assert.equal(calls.drawImage.length, 0);
  assert.ok(calls.strokeRect.length > 0);
  assert.equal(calls.fillRect.some((c) => c.style === '#123456'), false);

  fog(map.id, (m) => { m.fog.fill(1); });
  api.update((d) => { const x = api.findMap(d, map.id).objects.find((o) => o.id === 'o1'); x.state = 0; });
  const closed = api.playerWorld(api.getWorld(), map.id, 'a');
  assert.equal(seenObject(closed.maps[0]).ghost, undefined);
  assert.ok(closed.media.some((x) => x.id === 'texA'));
  assert.equal(renderOnce(closed, closed.maps[0]).drawImage.length, 1);
});

test('删媒体清掉记忆贴图，玩家媒体表和灰区一起回退颜色', () => {
  const { map } = fixture('a');
  fog(map.id, (m) => { m.fog.fill(2); });
  assert.ok(api.playerWorld(api.getWorld(), map.id, 'a').media.some((x) => x.id === 'texA'));
  assert.equal(api.findMap(api.getWorld(), map.id).views.a.seen.objects.find((r) => r.id === 'o1').texture.mediaId, 'texA');
  api.deleteMedia('texA');
  const m = api.findMap(api.getWorld(), map.id);
  assert.equal(seenObject(m).texture, undefined);
  assert.equal(m.views.a.seen.objects.find((r) => r.id === 'o1').texture, undefined);
  const live = api.playerWorld(api.getWorld(), map.id, 'a');
  assert.equal(live.media.some((x) => x.id === 'texA'), false);
  const calls = renderOnce(live, live.maps[0]);
  assert.equal(calls.drawImage.length, 0);
  assert.ok(calls.fillRect.some((c) => c.style === '#123456'));
});

test('灰区记忆连 fit/opacity 一起记', () => {
  const { map } = fixture('a');
  const g = map.groups.find((x) => x.objectId === 'o1');
  api.setCellGroupFit(map.id, g.id, 'contain');
  api.setCellGroupOpacity(map.id, g.id, 0.5);
  fog(map.id, (m) => { m.fog.fill(2); });
  const live = api.playerWorld(api.getWorld(), map.id, 'a');
  const seen = seenObject(live.maps[0]);
  assert.deepEqual(seen.texture, { mediaId: 'texA', fit: 'contain', opacity: 0.5 });
  const calls = renderOnce(live, live.maps[0]);
  assert.equal(calls.drawImage.length, 1);
  assert.equal(calls.drawImage[0].alpha, 0.5);
  assert.deepEqual(calls.drawImage[0].args.slice(1, 5).map(Math.round), [34, 41, 28, 14]);
});

test('未辨识的灰区物件仍保留外观，但不带名字', () => {
  const { map } = fixture('a', { identity: { party: false, recipients: [] } });
  fog(map.id, (m) => { m.fog.fill(2); });
  const live = api.playerWorld(api.getWorld(), map.id, 'a');
  const seen = seenObject(live.maps[0]);
  assert.equal(seen.texture.mediaId, 'texA');
  assert.equal(seen.name, '未辨识物件');
  const calls = renderOnce(live, live.maps[0]);
  assert.deepEqual(calls.drawImage.map((x) => x.args[0].tag), ['A']);
});

test('mergeLayers 多视野：整件取最新，贴图和 ghost 一起走', () => {
  const { map } = fixture(null);
  const a = api.emptyVision(map.width * map.height);
  const b = api.emptyVision(map.width * map.height);
  a.fog[2 * map.width + 2] = 2; b.fog[2 * map.width + 2] = 2;
  const base = { id: 'o1', name: '柜子', icon: '★', color: '#123456', x: 2, y: 2, w: 1, h: 1, height: 1, stateLabel: null };
  a.seen.objects = [{ ...base, texture: { mediaId: 'texA' }, ghost: false }];
  b.seen.objects = [{ ...base, texture: { mediaId: 'texB' }, ghost: true }];
  a.seen.objectRevs = { o1: 1 }; b.seen.objectRevs = { o1: 2 };
  const out = api.mergeLayers(map, [a, b]);
  assert.equal(out.seen.objects.length, 1);
  assert.equal(out.seen.objects[0].texture.mediaId, 'texB');
  assert.equal(out.seen.objects[0].ghost, true);
  assert.equal(out.seen.objectRevs.o1, 2);
});

test('schema 校验记忆物件贴图结构，但允许旧图不在当前媒体表', () => {
  const { world, map } = fixture('a');
  assert.doesNotThrow(() => api.checkWorld(world));
  const pm = api.playerWorld(world, map.id, 'a');
  assert.doesNotThrow(() => api.checkWorld(pm));

  const oldMedia = structuredClone(world);
  oldMedia.maps[0].seen.objects[0].texture.mediaId = 'missing';
  assert.doesNotThrow(() => api.checkWorld(oldMedia)); // 记忆可以读旧图，媒体表里没有也不拦

  const badFit = structuredClone(world);
  badFit.maps[0].seen.objects[0].texture.fit = 'weird';
  assert.throws(() => api.checkWorld(badFit), /texture\.fit/);
  const badOpacity = structuredClone(world);
  badOpacity.maps[0].seen.objects[0].texture.opacity = 2;
  assert.throws(() => api.checkWorld(badOpacity), /texture\.opacity/);
  const badGhost = structuredClone(world);
  badGhost.maps[0].seen.objects[0].ghost = 'yes';
  assert.throws(() => api.checkWorld(badGhost), /ghost/);
});

test('sameSeen/staleMemories：贴图和 ghost 变化会被发现', () => {
  const { map } = fixture('a');
  const r = seenObject(map);
  assert.equal(api.sameSeen(r, { ...r, texture: { mediaId: 'texA', opacity: 1 } }), true); // 归一后同版
  assert.equal(api.sameSeen(r, { ...r, texture: { mediaId: 'texB' } }), false);
  assert.equal(api.sameSeen(r, { ...r, ghost: true }), false);

  api.update((d) => { const m = api.findMap(d, map.id); m.fog.fill(2); });
  api.setObjectTexture(map.id, 'o1', 'texB');
  assert.equal(api.staleMemories(api.findMap(api.getWorld(), map.id)).some((x) => x.id === 'o1'), true);
  api.update((d) => { const m = api.findMap(d, map.id); m.fog.fill(1); });
  assert.equal(api.staleMemories(api.findMap(api.getWorld(), map.id)).some((x) => x.id === 'o1'), false);
});
