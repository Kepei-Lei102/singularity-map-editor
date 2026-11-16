import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-protocol-'));
const bundle = join(temp, 'protocol.cjs');
await build({
  stdin: { contents: `export * from './src/protocol';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const api = createRequire(import.meta.url)(bundle);
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

const env = (type, extra = {}) => ({ v: 1, type, requestId: 'r1', ...extra });

test('信封：只认 v1、已知 type、非空 requestId', () => {
  assert.equal(api.isEnvelope(env('room.create')), true);
  assert.equal(api.isEnvelope(env('room.create', { roomId: 'R', token: 'T', to: 'b' })), true);
  assert.equal(api.isEnvelope({ ...env('room.create'), v: 2 }), false);
  assert.equal(api.isEnvelope({ ...env('room.create'), type: 'room.nope' }), false);
  assert.equal(api.isEnvelope({ ...env('room.create'), requestId: '' }), false);
  assert.equal(api.isEnvelope({ ...env('room.create'), to: '' }), false);
  assert.equal(api.isEnvelope({ ...env('room.relay'), from: 'b1' }), true);
  assert.equal(api.isEnvelope({ ...env('room.relay'), from: '' }), false);
  assert.equal(api.isEnvelope(null), false);
});

test('握手载荷：缺字段/空字段不认', () => {
  assert.equal(api.isRoomCreatedPayload({ roomId: 'R', hostToken: 'H' }), true);
  assert.equal(api.isRoomCreatedPayload({ roomId: 'R' }), false);
  assert.equal(api.isRoomInvitedPayload({ inviteId: 'i', inviteToken: 't', joinUrl: 'u' }), true);
  assert.equal(api.isRoomInvitedPayload({ inviteId: 'i', inviteToken: 't' }), false);
  assert.equal(api.isRoomJoinedPayload({ binding: 'b', playerToken: 'p' }), true);
  assert.equal(api.isRoomJoinedPayload({ binding: '', playerToken: 'p' }), false);
  assert.equal(api.isRoomReconnectedPayload({ binding: 'b' }), true);
  assert.equal(api.isPeerJoinedPayload({ inviteId: 'i', binding: 'b' }), true);
  assert.equal(api.isPeerLeftPayload({ binding: 'b' }), true);
  assert.equal(api.isErrorPayload({ code: 'E' }), true);
  assert.equal(api.isErrorPayload({}), false);
});

test('角色权限：主持/玩家各发各的，服务器只发下行', () => {
  assert.equal(api.clientCanSend('host', 'room.create'), true);
  assert.equal(api.clientCanSend('host', 'room.invite'), true);
  assert.equal(api.clientCanSend('host', 'room.relay'), true);
  assert.equal(api.clientCanSend('host', 'room.join'), false);
  assert.equal(api.clientCanSend('player', 'room.join'), true);
  assert.equal(api.clientCanSend('player', 'room.reconnect'), true);
  assert.equal(api.clientCanSend('player', 'room.invite'), false);
  assert.equal(api.serverCanSend('room.created'), true);
  assert.equal(api.serverCanSend('room.relay'), true);
  assert.equal(api.serverCanSend('room.create'), false);
});

test('relay 形状：主持带 to，玩家不带 to', () => {
  assert.equal(api.relayShapeOk('host', env('room.relay', { to: 'b' })), true);
  assert.equal(api.relayShapeOk('host', env('room.relay')), false);
  assert.equal(api.relayShapeOk('player', env('room.relay')), true);
  assert.equal(api.relayShapeOk('player', env('room.relay', { to: 'b' })), false);
  assert.equal(api.relayShapeOk('host', env('room.create')), false);
  assert.equal(api.relayShapeOk('player', env('room.relay', { from: 'b1' })), false);
});

test('邀请：一次性，重放/未知/空串/关房都拒绝', () => {
  const room = api.createRoomState('R', 'host');
  assert.equal(api.addInvite(room, 'i1', 'inv1'), true);
  assert.equal(api.addInvite(room, 'i1', 'inv2'), false);
  assert.equal(api.addInvite(room, 'i2', 'inv1'), false);
  assert.equal(api.addInvite(room, 'i2', 'inv2'), true);
  assert.equal(api.addInvite(room, 'i3', 'host'), false);
  assert.equal(api.addInvite(room, '', 'inv9'), false);
  assert.equal(api.addInvite(room, 'i9', ''), false);
  const join = api.consumeInvite(room, 'inv1', 'b1', 'pt1');
  assert.deepEqual(join, { ok: true, inviteId: 'i1', binding: 'b1' });
  assert.equal(room.players.b1.online, true);
  assert.equal(room.players.b1.inviteId, 'i1');
  assert.deepEqual(api.consumeInvite(room, 'inv1', 'b2', 'pt2'), { ok: false, reason: 'invite-used' });
  assert.deepEqual(api.consumeInvite(room, 'nope', 'b2', 'pt2'), { ok: false, reason: 'unknown-invite' });
  assert.deepEqual(api.consumeInvite(room, 'inv2', '', 'pt2'), { ok: false, reason: 'invalid' });
  assert.deepEqual(api.consumeInvite(room, 'inv2', 'b2', ''), { ok: false, reason: 'invalid' });
  assert.deepEqual(api.consumeInvite(room, 'inv2', 'b2', 'host'), { ok: false, reason: 'token-collision' });
  assert.equal(room.invites.i2.usedBy, null);
  api.closeRoom(room);
  assert.deepEqual(api.consumeInvite(room, 'inv2', 'b3', 'pt3'), { ok: false, reason: 'closed' });
  assert.deepEqual(room.invites, {});
  assert.deepEqual(room.inviteTokens, {});
  assert.deepEqual(room.players, {});
  assert.deepEqual(room.playerTokens, {});
  assert.equal(room.hostToken, '');
});

test('重连：玩家拿回同一个 binding，主持 token 不串用', () => {
  const room = api.createRoomState('R', 'host');
  api.addInvite(room, 'i1', 'inv1');
  api.consumeInvite(room, 'inv1', 'b1', 'pt1');
  api.playerDisconnect(room, 'b1');
  assert.equal(room.players.b1.online, false);
  assert.equal(api.playerReconnect(room, 'pt1'), 'b1');
  assert.equal(room.players.b1.online, true);
  assert.equal(api.playerReconnect(room, 'nope'), null);
  assert.equal(api.playerReconnect(room, 'host'), null);
  api.hostDisconnect(room);
  assert.equal(api.isHostToken(room, 'host'), true);
  assert.equal(api.hostReconnect(room, 'host'), true);
  assert.equal(api.hostReconnect(room, 'bad'), false);
});

test('relay 路由：主持→在线 binding，玩家→主持，错房/离线都拒绝', () => {
  const room = api.createRoomState('R', 'host');
  api.addInvite(room, 'i1', 'inv1');
  api.consumeInvite(room, 'inv1', 'b1', 'pt1');
  assert.deepEqual(api.relayRoute(room, 'host', 'host', 'b1'), { from: 'host', to: 'b1' });
  assert.deepEqual(api.relayRoute(room, 'player', 'pt1', undefined), { from: 'player', to: 'host' });
  assert.equal(api.relayRoute(room, 'host', 'host', 'b2'), null);
  assert.equal(api.relayRoute(room, 'host', 'pt1', 'b1'), null);
  assert.equal(api.relayRoute(room, 'player', 'host', undefined), null);
  api.playerDisconnect(room, 'b1');
  assert.equal(api.relayRoute(room, 'host', 'host', 'b1'), null);
  assert.equal(api.relayRoute(room, 'player', 'pt1', undefined), null);
  api.playerReconnect(room, 'pt1');
  api.hostDisconnect(room);
  assert.equal(api.relayRoute(room, 'host', 'host', 'b1'), null);
  assert.equal(api.relayRoute(room, 'player', 'pt1', undefined), null);
  api.hostReconnect(room, 'host');
  assert.equal(api.relayRoute(room, 'player', 'host', undefined), null);
  api.closeRoom(room);
  assert.equal(api.relayRoute(room, 'host', 'host', 'b1'), null);
});
