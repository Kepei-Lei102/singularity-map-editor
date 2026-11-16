import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

class FakeWebSocket {
  static all = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.listeners = {};
    this.sent = [];
    FakeWebSocket.all.push(this);
  }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  emit(name, event) { for (const fn of [...(this.listeners[name] ?? [])]) fn(event); }
  open() { this.emit('open', {}); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { if (this.closed) return; this.closed = true; this.emit('close', { code: 1000, reason: '' }); }
  message(obj) { this.emit('message', { data: JSON.stringify(obj) }); }
}
globalThis.WebSocket = FakeWebSocket;

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-wssocket-'));
const bundle = join(temp, 'wssocket.cjs');
await build({
  stdin: { contents: `export * from './src/runtime/wsSocket';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const { connectRelay } = createRequire(import.meta.url)(bundle);
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

let seq = 0;
const nextRequest = (ws) => ws.sent[ws.sent.length - 1];
const envelope = (type, requestId, extra = {}) => ({ v: 1, type, requestId, ...extra });

test('wsSocket：open 后 resolve，request 按 requestId 配对，error 拒绝', async () => {
  const p = connectRelay('ws://test', 1000);
  const ws = FakeWebSocket.all.at(-1);
  ws.open();
  const socket = await p;
  assert.equal(socket.open, true);
  const req = socket.request('room.create');
  const sent = nextRequest(ws);
  assert.equal(sent.type, 'room.create');
  assert.equal(sent.v, 1);
  ws.message(envelope('room.created', sent.requestId, { payload: { roomId: 'r', hostToken: 'h' } }));
  assert.equal((await req).type, 'room.created');
  const bad = socket.request('room.invite');
  ws.message(envelope('error', nextRequest(ws).requestId, { payload: { code: 'nope' } }));
  await assert.rejects(bad, (e) => e.code === 'nope');
  socket.close();
});

test('wsSocket：显式 close 立刻 reject pending、open 变 false，close 回调只一次', async () => {
  const p = connectRelay('ws://test', 1000);
  const ws = FakeWebSocket.all.at(-1);
  ws.open();
  const socket = await p;
  const reasons = [];
  socket.onClose((r) => reasons.push(r));
  const pending = socket.request('room.close');
  socket.close();
  assert.equal(socket.open, false);
  await assert.rejects(pending, (e) => e.code === 'closed');
  socket.close();
  assert.deepEqual(reasons, ['连接已关闭']);
});

test('wsSocket：连接超时会 reject，不会一直等', async () => {
  await assert.rejects(connectRelay('ws://never', 10), (e) => e.code === 'timeout');
});
