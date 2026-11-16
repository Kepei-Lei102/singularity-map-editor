import assert from 'node:assert/strict';
import { test } from 'node:test';

class FakeSocket {
  open = true;
  sent = [];
  listeners = [];
  closeListeners = [];
  closed = false;
  onEnvelope(fn) {
    this.listeners.push(fn);
    return () => { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); };
  }
  onClose(fn) {
    this.closeListeners.push(fn);
    return () => { this.closeListeners = this.closeListeners.filter((x) => x !== fn); };
  }
  send(e) { this.sent.push(e); return e.requestId || 'x'; }
  emit(e) { for (const fn of [...this.listeners]) fn(e); }
  emitClose(reason) { for (const fn of [...this.closeListeners]) fn(reason); }
  close() { this.closed = true; this.open = false; this.emitClose('closed'); }
}
const msg = (type, seq) => ({ type, seq, __ts: 'ts-map', from: 's', inst: 'i', born: 1 });
const env = (type, payload, extra = {}) => ({ v: 1, type, requestId: 'r', payload, ...extra });

// WsTransport 只 import 了协议和 messages，不碰 window；直接用 tsx 源码不方便，这里走构建。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-ws-'));
const bundle = join(temp, 'ws.cjs');
await build({
  stdin: { contents: `export { createWsTransport } from './src/runtime/transportWs';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const { createWsTransport } = createRequire(import.meta.url)(bundle);
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

test('host ws transport：peer.joined 认人，定向 relay，from 只信服务器', () => {
  const socket = new FakeSocket();
  const joined = [];
  const t = createWsTransport({
    role: 'host', socket, roomId: 'room', token: 'host-token',
    onPeerJoined: (binding, inviteId) => joined.push({ binding, inviteId }),
  });
  const got = [];
  t.onMessage((m, meta) => got.push({ m, meta }));
  socket.emit(env('peer.joined', { binding: 'b1', inviteId: 'inv1' }));
  assert.deepEqual(joined, [{ binding: 'b1', inviteId: 'inv1' }]);
  assert.equal(t.hasPeer('b1'), true);
  assert.equal(t.sendToPeer('b1', msg('world', '1')), true);
  assert.deepEqual(socket.sent.at(-1), {
    type: 'room.relay', roomId: 'room', token: 'host-token', to: 'b1', payload: msg('world', '1'),
  });
  socket.emit(env('room.relay', msg('hello', '2'), { from: 'b1' }));
  assert.equal(got.at(-1).meta.from, 'b1');
  const before = got.length;
  socket.emit(env('room.relay', msg('say', '3'))); // 服务器没填 from：不认
  socket.emit(env('room.relay', msg('say', '4'), { from: 'b-unknown' })); // 未知 binding：不认
  assert.equal(got.length, before);
  socket.emit(env('peer.left', { binding: 'b1' }));
  assert.equal(t.hasPeer('b1'), false);
  t.close();
});

test('socket 自己断掉时 WsTransport 也通知 UI，主动 close 不重复通知', () => {
  const socket = new FakeSocket();
  const closed = [];
  const t = createWsTransport({ role: 'host', socket, roomId: 'room', token: 't', onClosed: (r) => closed.push(r) });
  socket.emitClose('network');
  assert.deepEqual(closed, ['network']);
  t.close();
  assert.deepEqual(closed, ['network']);
});

test('player ws transport：回主持不带 to，只认 host 来源', () => {
  const socket = new FakeSocket();
  const t = createWsTransport({ role: 'player', socket, roomId: 'room', token: 'player-token' });
  const got = [];
  t.onMessage((m, meta) => got.push({ m, meta }));
  assert.equal(t.sendToHost(msg('hello', '1')), true);
  assert.deepEqual(socket.sent.at(-1), {
    type: 'room.relay', roomId: 'room', token: 'player-token', payload: msg('hello', '1'),
  });
  socket.emit(env('room.relay', msg('world', '2'), { from: 'host' }));
  assert.equal(got.at(-1).meta.from, 'host');
  const before = got.length;
  socket.emit(env('room.relay', msg('world', '3'), { from: 'b1' })); // 线上玩家只认 host：拒收
  socket.emit(env('room.relay', msg('world', '4'))); // 没填来源也拒收
  assert.equal(got.length, before);
  assert.equal(t.hasPeer('host'), false);
  t.close();
});

test('线上 room.closed 会通知关房，但不会把业务消息漏过去', () => {
  const socket = new FakeSocket();
  const closed = [];
  const t = createWsTransport({ role: 'player', socket, roomId: 'room', token: 't', onClosed: (r) => closed.push(r) });
  const got = [];
  t.onMessage((m) => got.push(m));
  socket.emit(env('room.closed', { reason: 'host-disconnected' }));
  assert.deepEqual(closed, ['host-disconnected']);
  assert.equal(got.length, 0);
  assert.equal(socket.closed, true); // room.closed 之后 socket 被关掉
  socket.emit(env('room.relay', { type: 'not-sync' }, { from: 'host' }));
  assert.equal(got.length, 0);
  t.close();
});
