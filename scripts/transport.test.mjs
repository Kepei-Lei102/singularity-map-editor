import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const host = 'http://localhost:5178', player = 'http://localhost:5179';
const temp = await mkdtemp(join(tmpdir(), 'ts-transport-'));
const bundle = join(temp, 'transport.cjs');
await build({
  stdin: { contents: `export * from './src/runtime/transport'; export { createLocalTransport } from './src/runtime/transportLocal';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  define: { 'import.meta.env': JSON.stringify({ VITE_HOST_ORIGIN: host, VITE_PLAYER_ORIGIN: player }) },
});
const { createLocalTransport } = createRequire(import.meta.url)(bundle);
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

const storage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const msg = (type, seq) => ({ type, seq, __ts: 'ts-map', from: 'p', inst: 'i', born: 1 });

function setupWindow(opener) {
  const handlers = [];
  let opened;
  const win = {
    opener,
    setTimeout: () => 0, setInterval: () => 0,
    addEventListener: (n, f) => { if (n === 'message') handlers.push(f); },
    removeEventListener: () => {},
    open: (url) => (opened = { url, closed: false, messages: [], postMessage(data, target) { this.messages.push({ data, target }); } }),
  };
  globalThis.window = win;
  globalThis.location = { origin: host, href: host + '/', search: '' };
  globalThis.BroadcastChannel = class { postMessage() {} addEventListener() {} removeEventListener() {} close() {} };
  return { handlers, opened: () => opened };
}

test('host transport：绑定窗口、定向发送、来源反查', () => {
  const { handlers, opened } = setupWindow(undefined);
  const t = createLocalTransport('host');
  const got = [];
  t.onMessage((m, meta) => got.push({ m, meta }));
  assert.equal(t.openPeer('b1', `${player}/?view=player`), true);
  const win = opened();
  assert.equal(t.hasPeer('b1'), true);
  assert.equal(t.bindPeer('b1', win), true);
  assert.equal(t.bindingFor(win), 'b1');
  assert.equal(t.sendToPeer('b1', msg('world', '1')), true);
  assert.deepEqual(win.messages.at(-1), { data: msg('world', '1'), target: player });

  handlers[0]({ origin: player, source: win, data: msg('hello', '2') });
  assert.equal(got.at(-1).meta.from, 'b1');
  handlers[0]({ origin: 'http://evil.example', source: win, data: msg('hello', '3') });
  assert.equal(got.some((x) => x.m.seq === '3'), false);
  handlers[0]({ origin: player, source: {}, data: msg('world', '4') });
  assert.equal(got.some((x) => x.m.seq === '4'), false);

  assert.equal(t.bindPeer('b1', {}), false);
  win.closed = true;
  const replacement = { closed: false, messages: [], postMessage(data, target) { this.messages.push({ data, target }); } };
  assert.equal(t.bindPeer('b1', replacement), true);
  assert.equal(t.bindingFor(replacement), 'b1');
  t.dropPeer('b1');
  assert.equal(t.hasPeer('b1'), false);
  t.close();
});

test('player transport：只认 opener，回话发 host origin', () => {
  const opener = { closed: false, messages: [], postMessage(data, target) { this.messages.push({ data, target }); } };
  const { handlers } = setupWindow(opener);
  const t = createLocalTransport('player');
  const got = [];
  t.onMessage((m, meta) => got.push({ m, meta }));
  handlers[0]({ origin: host, source: opener, data: msg('world', '1') });
  assert.equal(got.at(-1).meta.from, 'host');
  handlers[0]({ origin: host, source: {}, data: msg('world', '2') });
  assert.equal(got.some((x) => x.m.seq === '2'), false);
  handlers[0]({ origin: 'http://evil.example', source: opener, data: msg('world', '3') });
  assert.equal(got.some((x) => x.m.seq === '3'), false);
  assert.equal(t.sendToHost(msg('hello', '4')), true);
  assert.deepEqual(opener.messages.at(-1), { data: msg('hello', '4'), target: host });
  t.close();
});

test('player transport：opener 为空时，来源为空的 world 不能冒充 host', () => {
  const { handlers } = setupWindow(null);
  const t = createLocalTransport('player');
  const got = [];
  t.onMessage((m, meta) => got.push({ m, meta }));
  handlers[0]({ origin: host, source: null, data: msg('world', '1') });
  assert.equal(got.length, 0);
  assert.equal(t.sendToHost(msg('hello', '2')), false);
  t.close();
});

test('host transport：窗口关掉后 peerClosed 能区分 saved binding 和已关窗口', () => {
  const { opened } = setupWindow(undefined);
  const t = createLocalTransport('host');
  t.openPeer('b1', `${player}/?view=player`);
  const win = opened();
  assert.equal(t.hasPeer('b1'), true);
  win.closed = true;
  assert.equal(t.hasPeer('b1'), false);
  assert.equal(t.peerClosed('b1'), true);
  assert.equal(t.sendToPeer('b1', msg('world', '1')), false);
  t.dropPeer('b1');
  assert.equal(t.peerClosed('b1'), false);
  t.close();
});

test('SwitchTransport：换传输会关旧传输，close 后不能再被订阅复活', () => {
  const fake = (role = 'host', kind = 'local') => ({
    role, kind, hasBroadcast: false, closed: false, handlers: [],
    openPeer() { return false; }, bindPeer() { return false; }, bindingFor() { return null; },
    hasPeer() { return false; }, peerClosed() { return false; }, dropPeer() {},
    sendToPeer() { return false; }, sendToHost() { return false; }, broadcast() {},
    onMessage(fn) { this.handlers.push(fn); return () => { this.handlers = this.handlers.filter((x) => x !== fn); }; },
    emit(m) { for (const fn of [...this.handlers]) fn(m, { from: null, source: null }); },
    close() { this.closed = true; this.handlers = []; },
  });
  const { createSwitchTransport } = createRequire(import.meta.url)(bundle);
  const a = fake('host', 'local'), b = fake('host', 'ws'), wrong = fake('player', 'ws');
  const s = createSwitchTransport(a);
  const got = [];
  s.onMessage((m) => got.push(m.seq));
  a.emit(msg('world', 'a1'));
  assert.equal(got.at(-1), 'a1');
  assert.throws(() => s.use(wrong), /传输角色不能/);
  assert.equal(a.closed, false); // 角色不对时不动旧传输
  s.use(b);
  assert.equal(a.closed, true);
  assert.equal(s.kind, 'ws');
  b.emit(msg('world', 'b1'));
  assert.equal(got.at(-1), 'b1');
  a.emit(msg('world', 'a2')); // 旧传输已经关掉，收不到
  assert.equal(got.at(-1), 'b1');
  s.close();
  assert.equal(b.closed, true);
  const off = s.onMessage(() => got.push('revived'));
  assert.equal(typeof off, 'function');
  b.emit(msg('world', 'b2'));
  assert.equal(got.includes('revived'), false);
  assert.throws(() => s.use(fake('host', 'local')), /已经关闭/);
});
