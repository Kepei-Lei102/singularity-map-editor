import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-server-'));
const bundle = join(temp, 'server.cjs');
await build({
  entryPoints: [join(root, 'server/index.ts')],
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const { startServer } = createRequire(import.meta.url)(bundle);

const servers = [];
after(async () => {
  while (servers.length) await servers.pop().close();
  await rm(temp, { recursive: true, force: true });
});

class Client {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    this.waiters = [];
    this.closed = new Promise((resolve) => {
      ws.addEventListener('close', (event) => resolve(event.code));
    });
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data.toString());
      const i = this.waiters.findIndex((w) => w.type === msg.type);
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
      else this.messages.push(msg);
    });
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  next(type, timeout = 2000) {
    const i = this.messages.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(this.messages.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等不到 ${type}`)), timeout);
      this.waiters.push({ type, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }
  close() { this.ws.close(); }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(new Client(ws)));
    ws.addEventListener('error', () => reject(new Error('连接失败')));
  });
}

const envelope = (type, requestId, extra = {}) => ({ v: 1, type, requestId, ...extra });

async function setup(options = {}) {
  const server = await startServer({
    port: 0, host: '127.0.0.1', playerOrigin: 'http://localhost:5179', allowNoOrigin: true, ...options,
  });
  servers.push(server);
  return { server, url: `ws://127.0.0.1:${server.port}` };
}

test('转发：建房、邀请、加入、双向 relay、断线、重连、关房', async () => {
  const { server, url } = await setup();
  const host = await connect(url);
  host.send(envelope('room.create', 'h1'));
  const created = await host.next('room.created');
  const roomId = created.payload.roomId;
  const hostToken = created.payload.hostToken;
  assert.match(roomId, /^[A-Za-z0-9_-]+$/);
  assert.ok(hostToken.length > 10);

  host.send(envelope('room.invite', 'h2', { roomId, token: hostToken }));
  const invited = await host.next('room.invited');
  assert.equal(invited.payload.inviteId.length > 0, true);
  assert.match(invited.payload.joinUrl, /\?view=player&room=/);
  assert.equal(server.rooms.size(), 1);

  const player = await connect(url);
  player.send(envelope('room.join', 'p1', { roomId, token: invited.payload.inviteToken }));
  const joined = await player.next('room.joined');
  assert.equal(joined.payload.binding.length > 0, true);
  const peer = await host.next('peer.joined');
  assert.deepEqual(peer.payload, { inviteId: invited.payload.inviteId, binding: joined.payload.binding });

  host.send(envelope('room.relay', 'h3', {
    roomId, token: hostToken, to: joined.payload.binding,
    payload: { type: 'world', world: { marker: 'p' } },
  }));
  const toPlayer = await player.next('room.relay');
  assert.equal(toPlayer.from, 'host');
  assert.deepEqual(toPlayer.payload, { type: 'world', world: { marker: 'p' } });

  player.send(envelope('room.relay', 'p2', {
    roomId, token: joined.payload.playerToken, payload: { type: 'move', dx: 1, dy: 0 },
  }));
  const toHost = await host.next('room.relay');
  assert.equal(toHost.from, joined.payload.binding);
  assert.deepEqual(toHost.payload, { type: 'move', dx: 1, dy: 0 });

  player.close();
  const left = await host.next('peer.left');
  assert.deepEqual(left.payload, { binding: joined.payload.binding });

  const again = await connect(url);
  again.send(envelope('room.reconnect', 'p3', { roomId, token: joined.payload.playerToken }));
  const reconnected = await again.next('room.reconnected');
  assert.deepEqual(reconnected.payload, { binding: joined.payload.binding });
  const joinedAgain = await host.next('peer.joined');
  assert.equal(joinedAgain.payload.binding, joined.payload.binding);

  host.send(envelope('room.close', 'h9', { roomId, token: hostToken }));
  const hostClosed = await host.next('room.closed');
  assert.equal(hostClosed.payload.reason, 'host-closed');
  const playerClosed = await again.next('room.closed');
  assert.equal(playerClosed.payload.reason, 'host-closed');
  assert.equal(server.rooms.size(), 0);
});

test('坏凭据/坏信封/错角色都要回 error', async () => {
  const { url } = await setup();
  const host = await connect(url);
  host.send(envelope('room.create', 'h1'));
  const created = await host.next('room.created');
  const roomId = created.payload.roomId;
  const hostToken = created.payload.hostToken;

  host.send(envelope('room.invite', 'h2', { roomId, token: 'bad' }));
  assert.equal((await host.next('error')).payload.code, 'not-allowed');

  host.send(envelope('room.relay', 'h3', { roomId, token: hostToken }));
  assert.equal((await host.next('error')).payload.code, 'bad-relay');

  const player = await connect(url);
  player.send(envelope('room.join', 'p1', { roomId, token: 'nope' }));
  assert.equal((await player.next('error')).payload.code, 'join-failed');

  player.send(envelope('room.invite', 'p2', { roomId, token: hostToken }));
  assert.equal((await player.next('error')).payload.code, 'bad-role');

  host.send(envelope('room.create', 'h4', { from: 'b1' }));

  player.send(envelope('room.close', 'p5', { roomId, token: 'x' }));
  assert.equal((await player.next('error')).payload.code, 'bad-role');

  player.send({ v: 1, type: 'room.relay', requestId: 'p3' });
  assert.equal((await player.next('error')).payload.code, 'bad-role');

  player.send({ v: 1, type: 'nope', requestId: 'p4' });
  assert.equal((await player.next('error')).payload.code, 'bad-envelope');
});

test('重连替换旧连接：旧连接被服务器关掉，不能把新连接踢出房间', async () => {
  const { url } = await setup();
  const host = await connect(url);
  host.send(envelope('room.create', 'h1'));
  const created = await host.next('room.created');
  const roomId = created.payload.roomId;
  const hostToken = created.payload.hostToken;
  host.send(envelope('room.invite', 'h2', { roomId, token: hostToken }));
  const invited = await host.next('room.invited');

  const oldPlayer = await connect(url);
  oldPlayer.send(envelope('room.join', 'p1', { roomId, token: invited.payload.inviteToken }));
  const joined = await oldPlayer.next('room.joined');
  await host.next('peer.joined');

  const newPlayer = await connect(url);
  newPlayer.send(envelope('room.reconnect', 'p2', { roomId, token: joined.payload.playerToken }));
  const reconnected = await newPlayer.next('room.reconnected');
  const rejoined = await host.next('peer.joined');
  assert.deepEqual(reconnected.payload, { binding: joined.payload.binding });
  assert.equal(rejoined.payload.inviteId, invited.payload.inviteId);

  assert.equal(await oldPlayer.closed, 4001);
  assert.equal(host.messages.some((m) => m.type === 'peer.left'), false);

  host.send(envelope('room.relay', 'h3', {
    roomId, token: hostToken, to: joined.payload.binding, payload: { type: 'world', marker: 1 },
  }));
  const relay = await newPlayer.next('room.relay');
  assert.deepEqual(relay.payload, { type: 'world', marker: 1 });
});

test('已加入玩家不能发邀请/关房', async () => {
  const { url } = await setup();
  const host = await connect(url);
  host.send(envelope('room.create', 'h1'));
  const created = await host.next('room.created');
  const roomId = created.payload.roomId;
  const hostToken = created.payload.hostToken;
  host.send(envelope('room.invite', 'h2', { roomId, token: hostToken }));
  const invited = await host.next('room.invited');

  const player = await connect(url);
  player.send(envelope('room.join', 'p1', { roomId, token: invited.payload.inviteToken }));
  const joined = await player.next('room.joined');
  await host.next('peer.joined');

  player.send(envelope('room.invite', 'p2', { roomId, token: joined.payload.playerToken }));
  assert.equal((await player.next('error')).payload.code, 'not-allowed');
  player.send(envelope('room.close', 'p3', { roomId, token: joined.payload.playerToken }));
  assert.equal((await player.next('error')).payload.code, 'not-allowed');

  host.send(envelope('room.join', 'h3', { roomId, token: joined.payload.playerToken }));
  assert.equal((await host.next('error')).payload.code, 'not-allowed');
});

test('/health 活着，未知路径 404', async () => {
  const { server } = await setup();
  const ok = await fetch(`http://127.0.0.1:${server.port}/health`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'ok');
  const nope = await fetch(`http://127.0.0.1:${server.port}/nope`);
  assert.equal(nope.status, 404);
});

test('过期房间：sweep 清房间表并通知两端', async () => {
  let now = 0;
  const { server, url } = await setup({ now: () => now, roomTtlMs: 100 });
  const host = await connect(url);
  host.send(envelope('room.create', 'h1'));
  const created = await host.next('room.created');
  const roomId = created.payload.roomId;
  const hostToken = created.payload.hostToken;
  host.send(envelope('room.invite', 'h2', { roomId, token: hostToken }));
  const invited = await host.next('room.invited');
  const player = await connect(url);
  player.send(envelope('room.join', 'p1', { roomId, token: invited.payload.inviteToken }));
  const joined = await player.next('room.joined');
  await host.next('peer.joined');

  now = 101;
  assert.equal(server.sweep(), 1);
  assert.equal(server.rooms.size(), 0);
  assert.equal((await player.next('room.closed')).payload.reason, 'expired');
  assert.equal((await host.next('room.closed')).payload.reason, 'expired');

  host.send(envelope('room.relay', 'h3', {
    roomId, token: hostToken, to: joined.payload.binding, payload: { type: 'world' },
  }));
  assert.equal((await host.next('error')).payload.code, 'relay-failed');
});
