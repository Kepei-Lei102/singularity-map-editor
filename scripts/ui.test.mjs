import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-ui-test-'));
const bundle = join(temp, 'editor.cjs');
// Exercise the real pointer handlers without a DOM. Only React hooks and canvas are replaced.
await build({
  stdin: { contents: `export * from './src/defaults'; export * from './src/store'; export * from './src/render'; export * from './src/components/Sidebar'; export * from './src/components/MapCanvas';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  plugins: [{ name: 'hooks', setup(b) {
    b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx', namespace: 'test' }));
    b.onLoad({ filter: /^jsx$/, namespace: 'test' }, () => ({ contents: `
      export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;
      export const Fragment = 'fragment';
    ` }));
    b.onResolve({ filter: /^react$/ }, () => ({ path: 'hooks', namespace: 'test' }));
    b.onLoad({ filter: /^hooks$/, namespace: 'test' }, () => ({ contents: `
      export const useRef = value => ({ current: globalThis.testRefs?.shift() ?? value });
      export const useState = value => [value, () => {}];
      export const useEffect = () => {};
      export const useLayoutEffect = () => {};
      export const useSyncExternalStore = (_, get) => get();
    ` }));
  } }],
});
const storage = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) }; };
globalThis.localStorage = storage(); globalThis.sessionStorage = storage();
globalThis.location = { search: '', origin: 'http://localhost' };
globalThis.window = { setTimeout: () => 0 };
globalThis.BroadcastChannel = class { postMessage() {} };
globalThis.Path2D = class { rect() {} };
const api = createRequire(import.meta.url)(bundle);
after(() => rm(temp, { recursive: true, force: true }));

function fixture() {
  const world = api.emptyWorld(), map = api.newMap('测试', '现实', 0, 10, 10, 'floor', false);
  map.autoFog = false;
  map.objects = [api.newObject('object', 1, 1, 2, 2), api.newObject('zone', 4, 1, 2, 2)];
  map.tokens = [{ id: 'token', pcId: null, name: '棋子', color: '#fff', x: 7, y: 1 }];
  world.maps = [map];
  return { world, map };
}

test('pan is available in every mode, preserves H for black fog and uses P', () => {
  assert.equal(api.TOOL_KEYS.p, 'pan'); assert.equal(api.TOOL_KEYS.h, 'fogBlack');
  for (const mode of ['edit', 'prep', 'run']) for (const unlock of [false, true]) {
    assert.ok(api.toolsFor({ ...api.getUI(), mode, unlock }).includes('pan'));
  }
});

test('pan over furniture, zone border/interior, token and empty space changes only the view in all modes', () => {
  for (const mode of ['edit', 'prep', 'run']) for (const [x,y] of [[1.5,1.5], [4,1.5], [5,2], [7.5,1.5], [9,9]]) {
    const { world,map } = fixture(); api.replaceWorld(world);
    const selection = { type: 'object', mapId: map.id, id: map.objects[0].id };
    const pick = { mapId: map.id, x: 0, y: 0 };
    api.setUI({ mode, tool: 'pan', selection, pick, trial: null, views: { [map.id]: { zoom: 1, panX: 10, panY: 20 } } });
    globalThis.testRefs = [{}, { setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) }];
    const tree = api.MapCanvas({ world: api.getWorld(), map: api.getWorld().maps[0], mode });
    const canvas = tree.props.children[0].props;
    assert.equal(canvas.style.cursor, 'grab');
    const before = api.getWorld();
    const event = { button: 0, pointerId: 1, clientX: x * 32 + 10, clientY: y * 32 + 20, detail: 2 };
    canvas.onPointerDown(event);
    canvas.onPointerMove({ ...event, clientX: event.clientX + 25, clientY: event.clientY + 15 });
    canvas.onPointerUp({ ...event, clientX: event.clientX + 25, clientY: event.clientY + 15 });
    assert.deepEqual(api.getUI().views[map.id], { zoom: 1, panX: 35, panY: 35 });
    assert.deepEqual(api.getUI().selection, selection); assert.deepEqual(api.getUI().pick, pick);
    assert.equal(api.getWorld(), before);
    api.undo(); assert.equal(api.getWorld(), before, 'pan must not add an undo entry');
  }
});

function drawing(world, map, mode = 'edit', zoom = 4) {
  const text = [], strokes = [], fills = [];
  const state = [];
  const ctx = new Proxy({
    font: '', fillStyle: '', textAlign: 'start', textBaseline: 'alphabetic',
    save() { state.push({ font: this.font, fillStyle: this.fillStyle, textAlign: this.textAlign, textBaseline: this.textBaseline }); },
    restore() { Object.assign(this, state.pop()); },
    measureText(value) { const size = +(this.font.match(/([\d.]+)px/)?.[1] ?? 10); return { width: Array.from(value).reduce((n,c) => n + (c === 'W' ? 1 : c === 'i' ? .2 : .7) * size, 0) }; },
    fillText(value,x,y) { text.push({ value,x,y,font: this.font, color: this.fillStyle, width: this.measureText(value).width }); },
    strokeText(value) { strokes.push(value); },
    fillRect(...rect) { fills.push({ rect, color: this.fillStyle }); },
  }, { get: (target,key) => key in target ? target[key] : () => {} });
  api.render(ctx, 1400, 1000, 1, world, map, { zoom, panX: 0, panY: 0 }, { mode, tool: 'pan', selection: null, hover: null, preview: null, brush: 1, pending: null, showFog: false });
  return { text,strokes,fills };
}

test('object name and state wrap by measured width, ellipsize in full rows and leave height footer clear', () => {
  const { world,map } = fixture(); map.tokens = []; map.objects = [map.objects[0]];
  const obj = map.objects[0]; obj.w = 1; obj.h = 3; obj.name = 'W'.repeat(20); obj.icon = ''; obj.height = 1;
  obj.states = ['默认', 'i'.repeat(80)]; obj.state = 1;
  const result = drawing(world,map), lines = result.text;
  const names = lines.filter(l => l.font.startsWith('600 10px'));
  assert.ok(names.length > 1); assert.ok(names.at(-1).value.endsWith('…'));
  const states = lines.filter(l => l.value.startsWith('['));
  assert.equal(states.length,1); assert.ok(states[0].value.endsWith('…'));
  const footer = lines.find(l => l.value === '1m'); assert.ok(footer);
  for (const line of [...names,...states]) {
    assert.ok(line.width <= obj.w * 32 - 10); assert.ok(line.y < footer.y - 10);
    assert.equal((line.y - (obj.y * 32 + 13)) % 12,0);
  }
  assert.equal(result.strokes.length,0, 'ordinary furniture text keeps its original appearance');
  assert.ok(result.fills.some(f => f.color === obj.color));
  const narrow = names[0].value.length;
  obj.name = 'i'.repeat(20);
  assert.ok(drawing(world,map).text.find(l => l.font.startsWith('600 10px')).value.length > narrow, 'real glyph widths determine wrapping');
});

test('state can span several rows and grapheme sequences are never split at a wrap boundary', () => {
  const { world,map } = fixture(); map.tokens = []; map.objects = [map.objects[0]];
  const obj = map.objects[0]; obj.w = 1; obj.h = 4; obj.icon = ''; obj.height = 1;
  obj.name = '柜'; obj.states = ['默认', '状态'.repeat(30)]; obj.state = 1;
  let result = drawing(world,map);
  const stateRows = result.text.filter(l => l.font === '9px system-ui, sans-serif' && l.value !== '1m');
  assert.ok(stateRows.length > 1); assert.ok(stateRows.at(-1).value.endsWith('…'));
  assert.ok(stateRows.every(l => l.width <= obj.w * 32 - 10));
  obj.states = ['默认']; obj.name = 'é'.repeat(40);
  result = drawing(world,map);
  for (const {value} of result.text.filter(l => l.font.startsWith('600 10px'))) {
    assert.match(value, /^(?:é)*(?:…)?$/u);
  }
});

test('wide short object keeps name/state in complete rows above the footer; same-cell labels remain deduplicated', () => {
  const { world,map } = fixture(); map.tokens = []; map.objects = [map.objects[0]];
  const obj = map.objects[0]; obj.w = 4; obj.h = 1; obj.name = '长名称'.repeat(30); obj.icon = ''; obj.height = 1;
  obj.states = ['关闭', '打开'];
  let result = drawing(world,map);
  assert.equal(result.text.filter(l => l.font.startsWith('600 10px')).length,1);
  assert.ok(result.text.some(l => l.value.endsWith('…')));
  assert.ok(result.text.some(l => l.value === '1m'));
  obj.h = 2; obj.name = '代表家具';
  map.objects.push({ ...obj, id: 'zz-stack', name: '同格第二家具' });
  result = drawing(world,map);
  assert.equal(result.text.filter(l => l.value === obj.name || l.value === '同格第二家具').length,1);
  assert.ok(result.text.some(l => l.value === '+1'));
  map.fog.fill(2); map.seen.objects = [{ ...obj, name: '记忆家具', stateLabel: '记忆状态' }];
  map.objects = [];
  result = drawing(world,map,'player');
  assert.ok(result.text.some(l => l.value === '记忆家具'));
  assert.ok(result.text.some(l => l.value === '[记忆状态]'));
});
