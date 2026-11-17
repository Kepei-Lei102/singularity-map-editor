// 物件外观区的接线：普通物件有入口，建筑件/触发区没有；选已有图会真的挂上。
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-objectappearance-ui-'));
const bundle = join(temp, 'panel.cjs');
await build({
  stdin: { contents: `export { ObjectInspector, objectTextureUploadError } from './src/components/Inspector';
export * as React from 'react';
export { createRoot } from 'react-dom/client';
export { act } from 'react';
export * from './src/core/defaults';
export * from './src/core/schema.js';
export * from './src/core/store';
export * from './src/runtime/actions';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.BroadcastChannel = class { postMessage() {} };
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
const api = createRequire(import.meta.url)(bundle);
after(() => { dom.window.close(); return rm(temp, { recursive: true, force: true }); });

function fixture() {
  const w = api.emptyWorld();
  const m = w.maps[0];
  w.media = [{ id: 'tex', name: '柜纹', mime: 'image/png', size: 1 }];
  m.objects = [{ ...api.newObject('object', 1, 1, 1, 1), id: 'o1', name: '柜子' }];
  api.replaceWorld(w);
  return { world: api.getWorld(), map: api.findMap(api.getWorld(), m.id) };
}

function mount(world, map, o) {
  const ui = { ...api.getUI(), mode: 'edit', trial: null, selection: { type: 'object', mapId: map.id, id: o.id } };
  const container = document.createElement('div');
  document.body.append(container);
  const root = api.createRoot(container);
  api.act(() => root.render(api.React.createElement(api.ObjectInspector, { world, mapId: map.id, o, ui })));
  return { root, container };
}

test('普通物件显示外观区，选已有图会挂上物件贴图', () => {
  const { world, map } = fixture();
  const o = map.objects[0];
  const { root, container } = mount(world, map, o);
  assert.match(container.textContent, /外观（物件贴图）/);
  const select = [...container.querySelectorAll('select')].find((s) => [...s.options].some((x) => x.textContent === '柜纹'));
  assert.ok(select);
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set;
  api.act(() => { setter.call(select, 'tex'); select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
  const g = api.findMap(api.getWorld(), map.id).groups.find((x) => x.objectId === 'o1');
  assert.equal(g.texture.mediaId, 'tex');

  const curMap = api.findMap(api.getWorld(), map.id);
  api.act(() => root.render(api.React.createElement(api.ObjectInspector, { world: api.getWorld(), mapId: map.id, o: curMap.objects.find((x) => x.id === 'o1'), ui: { ...api.getUI(), mode: 'edit', trial: null, selection: { type: 'object', mapId: map.id, id: 'o1' } } })));
  const clear = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === '清除贴图');
  assert.ok(clear);
  api.act(() => clear.click());
  assert.equal(api.findMap(api.getWorld(), map.id).groups.some((x) => x.objectId === 'o1'), false);
  api.act(() => root.unmount());
  container.remove();
});

test('上传守卫：工程/编辑模式/物件/选中变了一个都不挂', () => {
  const base = { ...api.getUI(), mode: 'edit', trial: null, selection: { type: 'object', mapId: 'map1', id: 'o1' } };
  assert.match(api.objectTextureUploadError('a', 'b', base, 'map1', 'o1', true), /世界已经变了/);
  assert.match(api.objectTextureUploadError('a', 'b', { ...base, trial: {} }, 'map1', 'o1', true), /离开编辑模式/, '试玩优先报编辑模式');
  assert.match(api.objectTextureUploadError('a', 'a', { ...base, mode: 'play', unlock: false }, 'map1', 'o1', true), /离开编辑模式/);
  assert.match(api.objectTextureUploadError('a', 'a', { ...base, trial: {} }, 'map1', 'o1', true), /离开编辑模式/);
  assert.match(api.objectTextureUploadError('a', 'a', base, 'map1', 'o1', false), /物件已经不在了/);
  assert.match(api.objectTextureUploadError('a', 'a', { ...base, selection: { type: 'object', mapId: 'map1', id: 'o2' } }, 'map1', 'o1', true), /不在这个物件上/);
  assert.equal(api.objectTextureUploadError('a', 'a', base, 'map1', 'o1', true), null);
});

test('空物件组也能从检查器清掉', () => {
  const { map } = fixture();
  api.update((d) => {
    const m = api.findMap(d, map.id);
    m.groups.push({ id: 'g-empty', name: '外观', cells: [0], objectId: 'o1' });
  });
  const world = api.getWorld();
  const m = api.findMap(world, map.id);
  const o = m.objects.find((x) => x.id === 'o1');
  assert.ok(m.groups.some((g) => g.objectId === 'o1' && !g.texture));
  const { root, container } = mount(world, m, o);
  const clear = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === '清除贴图');
  assert.ok(clear);
  api.act(() => clear.click());
  assert.equal(api.findMap(api.getWorld(), map.id).groups.some((g) => g.objectId === 'o1'), false);
  api.act(() => root.unmount());
  container.remove();
});

test('建筑件和触发区不显示外观入口', () => {
  const { world, map } = fixture();
  assert.equal(api.addArchitectureWall(map.id, { x: 0, y: 0 }, { x: 3, y: 0 }, 'wall', 1), null);
  const wall = api.findMap(api.getWorld(), map.id).objects.find((x) => x.id !== 'o1');
  const wallMount = mount(api.getWorld(), api.findMap(api.getWorld(), map.id), wall);
  assert.doesNotMatch(wallMount.container.textContent, /外观（物件贴图）/);
  api.act(() => wallMount.root.unmount()); wallMount.container.remove();

  api.update((d) => { d.maps[0].objects.push({ ...api.newObject('object', 3, 3, 1, 1), id: 'zone', kind: 'zone', name: '触发区' }); });
  const m = api.findMap(api.getWorld(), map.id);
  const zone = m.objects.find((x) => x.id === 'zone');
  const zoneMount = mount(api.getWorld(), m, zone);
  assert.doesNotMatch(zoneMount.container.textContent, /外观（物件贴图）/);
  api.act(() => zoneMount.root.unmount()); zoneMount.container.remove();
  assert.ok(world);
});
