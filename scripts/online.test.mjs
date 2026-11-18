import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-online-'));
const serverFile = join(temp, 'server.cjs');
await build({
  entryPoints: [join(root, 'server/index.ts')],
  outfile: serverFile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const { startServer } = createRequire(import.meta.url)(serverFile);
const servers = [];
after(async () => {
  while (servers.length) await servers.pop().close();
  await rm(temp, { recursive: true, force: true });
});

const storage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.BroadcastChannel = class { postMessage() {} addEventListener() {} removeEventListener() {} close() {} };
globalThis.window = { setTimeout: () => 0, setInterval: () => 0, addEventListener: () => {}, removeEventListener: () => {}, opener: null, open: () => null };
const load = async (name, role, search) => {
  const file = join(temp, name);
  await build({
    stdin: { contents: `export * from './src/runtime/onlineRoom'; export * from './src/runtime/sync'; export * from './src/core/defaults'; export * from './src/core/store'; export * from './src/runtime/actions';`, resolveDir: root },
    outfile: file, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    define: { 'import.meta.env': JSON.stringify({ VITE_APP_ROLE: role }) },
  });
  globalThis.location = { origin: role === 'player' ? 'http://localhost:5179' : 'http://localhost:5178', href: `${role === 'player' ? 'http://localhost:5179' : 'http://localhost:5178'}/${search}`, search };
  return createRequire(import.meta.url)(file);
};
const waitFor = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('等待超时');
};

test('线上闭环：主持建房、发邀请、玩家加入、hello/world/say 双向', async () => {
  const server = await startServer({ port: 0, host: '127.0.0.1', playerOrigin: 'http://localhost:5179', allowNoOrigin: true });
  servers.push(server);
  const url = `ws://127.0.0.1:${server.port}`;

  const host = await load('host.cjs', 'host', '');
  const w = host.emptyWorld();
  w.party = [{ id: 'pc', name: '甲', tags: [], color: '#fff' }];
  host.replaceWorld(w);
  const hostSeen = [];
  host.listen((m, _source, from) => hostSeen.push({ type: m.type, from }));
  const localWindow = { closed: false, messages: [], postMessage(data) { this.messages.push(data); } };
  globalThis.window.open = () => localWindow;
  host.openPlayerWindow('pc');
  const created = await host.createOnlineHostRoom(url);
  assert.ok(localWindow.messages.some((m) => m.type === 'clear')); // 切线上前旧本地窗口要收到 clear
  assert.ok(created.roomId);
  const joinUrl = await host.inviteOnlinePlayer('pc');
  const u = new URL(joinUrl);
  assert.equal(u.searchParams.get('view'), 'player');
  assert.equal(u.searchParams.get('room'), created.roomId);

  const player = await load('player.cjs', 'player', u.search);
  const joined = await player.joinOnlinePlayer(u.searchParams.get('room'), u.searchParams.get('invite'), url);
  assert.ok(joined.binding);
  await waitFor(() => host.pcIdForBinding(joined.binding) === 'pc');

  host.listenAsEditor(() => host.send({ type: 'world', world: host.getWorld() }));
  const playerSeen = [];
  player.listenAsPlayer((m) => playerSeen.push(m), { online: true, binding: joined.binding });
  await waitFor(() => playerSeen.some((m) => m.type === 'world' && m.world.viewerId === 'pc'));
  assert.ok(hostSeen.some((m) => m.type === 'hello' && m.from === joined.binding));

  host.update((d) => { d.media.push({ id: 'm1', name: '图', mime: 'image/png', size: 1, key: 'k1' }); d.media.push({ id: 'm2', name: '本地', mime: 'audio/mpeg', size: 1, key: 'k2' }); });
  const seenBefore = playerSeen.length;
  host.playMedia('m1', '图', true);
  await waitFor(() => playerSeen.slice(seenBefore).some((m) => m.type === 'play'));
  const played = playerSeen.slice(seenBefore).find((m) => m.type === 'play');
  assert.ok(played);
  assert.equal(played.mediaId, 'k1'); // 内容 key，玩家拿它去走 asset 分块
  assert.equal(played.blob, undefined); // 线上不把 Blob 塞进 relay

  // 广播中的 key 应该进了这个 binding 的 allow；没有 IndexedDB 时读不到文件，但原因不能是 forbidden。
  const assetSeenBefore = playerSeen.length;
  player.send({ type: 'asset-request', requestId: 'r1', keys: ['k1'] });
  await waitFor(() => playerSeen.slice(assetSeenBefore).some((m) => m.type === 'asset-fail' && m.key === 'k1'));
  const assetFail = playerSeen.slice(assetSeenBefore).find((m) => m.type === 'asset-fail' && m.key === 'k1');
  assert.notEqual(assetFail.reason, 'forbidden');

  // 停止广播后，allow 只保留 world 真用到的媒体；这个文件没挂在任何物件上，应该立刻变成 forbidden。
  host.stopMedia();
  await waitFor(() => playerSeen.some((m) => m.type === 'stop'));
  const stoppedBefore = playerSeen.length;
  player.send({ type: 'asset-request', requestId: 'r2', keys: ['k1'] });
  await waitFor(() => playerSeen.slice(stoppedBefore).some((m) => m.type === 'asset-fail' && m.key === 'k1' && m.reason === 'forbidden'));

  // 广播中再点「▶ 仅主持人」：必须先给玩家 stop，并把广播 key 的 allow 收走；否则玩家永远停不下来。
  const replayBefore = playerSeen.length;
  host.playMedia('m1', '图', true);
  await waitFor(() => playerSeen.slice(replayBefore).some((m) => m.type === 'play'));
  const localPlayBefore = playerSeen.length;
  host.playMedia('m2', '本地', false);
  await waitFor(() => playerSeen.slice(localPlayBefore).some((m) => m.type === 'stop'));
  host.stopMedia();
  assert.equal(host.getUI().nowPlaying, null);
  const afterLocalBefore = playerSeen.length;
  player.send({ type: 'asset-request', requestId: 'r3', keys: ['k1'] });
  await waitFor(() => playerSeen.slice(afterLocalBefore).some((m) => m.type === 'asset-fail' && m.key === 'k1' && m.reason === 'forbidden'));

  player.send({ type: 'say', text: '你好', targetTokenId: null });
  await waitFor(() => hostSeen.some((m) => m.type === 'say' && m.from === joined.binding));

  // 刷新玩家端：切回本地再凭 playerToken 重连，binding 不变，主持人补一份 world。
  player.useLocalTransport();
  const re = await player.reconnectOnlinePlayer(url);
  assert.equal(re.binding, joined.binding);
  const playerSeenAgain = [];
  player.listenAsPlayer((m) => playerSeenAgain.push(m), { online: true, binding: re.binding });
  await waitFor(() => playerSeenAgain.some((m) => m.type === 'world' && m.world.viewerId === 'pc'));

  const closed = [];
  player.onOnlinePlayerClosed((reason) => closed.push(reason));
  await host.closeOnlineHostRoom();
  await waitFor(() => closed.includes('host-closed'));
  assert.equal(sessionStorage.getItem('ts-online-player'), null);
});
