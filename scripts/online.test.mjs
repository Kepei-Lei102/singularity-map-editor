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
// 最小内存版 IndexedDB：线上测试要真跑一遍 asset 分块落盘，不装 fake-indexeddb。
// host/player 用两套库，模拟两个浏览器；测试里显式切 __setIDBSide。
const heldIDBKeys = new Set();
const heldIDBRequests = new Map();
globalThis.__holdIDB = (key) => { heldIDBKeys.add(key); };
globalThis.__releaseIDB = (key) => {
  heldIDBKeys.delete(key);
  const runs = heldIDBRequests.get(key) ?? [];
  heldIDBRequests.delete(key);
  for (const run of runs) run();
};
function makeFakeIDB() {
  const stores = new Map();
  const db = {
    createObjectStore(name) { if (!stores.has(name)) stores.set(name, new Map()); },
    transaction(name) {
      const data = stores.get(name) ?? new Map();
      stores.set(name, data);
      const t = { oncomplete: null, onerror: null, onabort: null, error: null };
      const req = (fn, key) => {
        const r = { result: undefined, error: null };
        const run = () => {
          try { r.result = fn(); } catch (e) { r.error = e; }
          setTimeout(() => t.oncomplete?.(), 0);
        };
        if (typeof key === 'string' && heldIDBKeys.has(key)) {
          const runs = heldIDBRequests.get(key) ?? [];
          runs.push(run);
          heldIDBRequests.set(key, runs);
        }
        else setTimeout(run, 0);
        return r;
      };
      const store = {
        get: (key) => req(() => data.get(key), key),
        put: (value, key) => req(() => { data.set(key, value); return key; }, key),
        delete: (key) => req(() => { data.delete(key); return undefined; }, key),
      };
      t.objectStore = () => store;
      return t;
    },
    close() {},
    openRequest() {
      const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      setTimeout(() => { req.onupgradeneeded?.(); req.onsuccess?.(); }, 0);
      return req;
    },
  };
  return db;
}
function installFakeIndexedDB() {
  const host = makeFakeIDB();
  const player = makeFakeIDB();
  let side = 'host';
  globalThis.__setIDBSide = (next) => { side = next; };
  globalThis.indexedDB = { open: () => (side === 'player' ? player : host).openRequest() };
}
installFakeIndexedDB();
globalThis.BroadcastChannel = class { postMessage() {} addEventListener() {} removeEventListener() {} close() {} };
globalThis.window = { setTimeout: () => 0, setInterval: () => 0, addEventListener: () => {}, removeEventListener: () => {}, opener: null, open: () => null };
const load = async (name, role, search) => {
  const file = join(temp, name);
  await build({
    stdin: { contents: `export * from './src/runtime/onlineRoom'; export * from './src/runtime/sync'; export * from './src/core/defaults'; export * from './src/core/store'; export * from './src/runtime/actions'; export * from './src/runtime/media'; export * from './src/runtime/assets'; export * from './src/runtime/trial';`, resolveDir: root },
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
  w.maps[0].spawn = { x: 1, y: 1 };
  host.setUI({ mapId: w.maps[0].id });
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

  host.update((d) => { d.media.push({ id: 'm1', name: '图', mime: 'image/png', size: 1, key: 'k1' }); d.media.push({ id: 'm2', name: '本地', mime: 'audio/mpeg', size: 1, key: 'k2' });  });
  const seenBefore = playerSeen.length;
  host.playMedia('m1', '图', true);
  await waitFor(() => playerSeen.slice(seenBefore).some((m) => m.type === 'play'));
  const played = playerSeen.slice(seenBefore).find((m) => m.type === 'play');
  assert.ok(played);
  assert.equal(played.mediaId, 'k1'); // 内容 key，玩家拿它去走 asset 分块
  assert.equal(played.blob, undefined); // 线上不把 Blob 塞进 relay

  // 广播中的 key 应该进了这个 binding 的 allow；真跑一遍分块：主持端从 IndexedDB 读，玩家端拼回并落盘。
  const bytes = new Uint8Array(1_048_576).fill(7);
  await host.putRaw('k1', new Blob([bytes], { type: 'image/png' }));
  await host.putRaw('k2', new Blob([new Uint8Array([6])], { type: 'audio/mpeg' }));
  const readyKeys = [];
  const assetFails = [];
  const assetProgress = [];
  const hostTransferDuring = [];
  const hostStatsSamples = [];
  let statEvents = 0;
  const assets = player.createAssetReceiver({
    send: player.send,
    load: async () => undefined, // 模拟另一个浏览器：玩家本地没有这份文件，必须先请求
    save: async (key, blob) => {
      globalThis.__setIDBSide('player');
      try { await player.putRaw(key, blob); } finally { globalThis.__setIDBSide('host'); }
    },
    onReady: (k) => readyKeys.push(k),
    onFail: (k, r) => assetFails.push([k, r]),
    onProgress: (k, received, total) => { assetProgress.push([k, received, total]); const st = host.assetTransferStats(); hostTransferDuring.push(st.players); hostStatsSamples.push(st); },
  });
  const offAssets = player.listenAsPlayer((m) => { if (player.isAssetMessage(m)) assets.handle(m); }, { online: true, binding: joined.binding });
  const offStats = host.subscribeAssetTransferStats(() => { statEvents++; });
  const assetSeenBefore = playerSeen.length;
  void assets.retry(['k1']);
  await waitFor(() => readyKeys.includes('k1'));
  assert.deepEqual(assetFails, []);
  assert.ok(assetProgress.some(([k, received, total]) => k === 'k1' && received === bytes.length && total === bytes.length));
  assert.ok(hostTransferDuring.some((n) => n === 1)); // 玩家收到时主持端 dock 能看到 1 个在传
  const liveStats = hostStatsSamples.find((st) => st.bytes > 0);
  assert.ok(liveStats);
  assert.equal(liveStats.players, 1);
  assert.equal(liveStats.totalBytes, bytes.length);
  assert.equal(liveStats.queued, 0);
  assert.equal(liveStats.bindings.length, 1);
  assert.equal(liveStats.bindings[0].binding, joined.binding);
  assert.equal(liveStats.bindings[0].pcId, 'pc');
  assert.equal(liveStats.bindings[0].name, '甲');
  assert.equal(liveStats.inFlight, 1);
  assert.equal(liveStats.bindings[0].inFlight, 1);
  assert.ok(liveStats.bindings[0].bytes > 0);
  assert.ok(liveStats.rate > 0);
  await waitFor(() => host.assetTransferStats().players === 0);
  await waitFor(() => statEvents >= 2);
  const rateAt = Date.now();
  assert.equal(host.rateFromSamples([{ at: rateAt - 1000, bytes: 0 }, { at: rateAt, bytes: 1000 }], rateAt), 1000);
  assert.equal(host.rateFromSamples([{ at: rateAt - 1000, bytes: 0 }, { at: rateAt, bytes: 1000 }], rateAt + 1000), 500);
  assert.equal(host.rateFromSamples([{ at: rateAt - 1000, bytes: 0 }, { at: rateAt, bytes: 1000 }], rateAt + 1900), 500);
  assert.equal(host.rateFromSamples([{ at: rateAt - 1000, bytes: 0 }, { at: rateAt, bytes: 1000 }], rateAt + 2001), 0);
  assert.equal(host.rateFromSamples([{ at: rateAt - 1000, bytes: 0 }, { at: rateAt, bytes: 1000 }], rateAt + 2500), 0);
  offStats();
  globalThis.__setIDBSide('player');
  const raw = await player.getRaw('k1');
  globalThis.__setIDBSide('host');
  assert.ok(raw);
  assert.deepEqual([...new Uint8Array(await raw.arrayBuffer())], [...bytes]);
  const assetMsgs = playerSeen.slice(assetSeenBefore);
  assert.ok(assetMsgs.some((m) => m.type === 'asset-start' && m.key === 'k1'));
  assert.ok(assetMsgs.some((m) => m.type === 'asset-chunk' && m.key === 'k1'));
  assert.ok(assetMsgs.some((m) => m.type === 'asset-end' && m.key === 'k1' && m.bytes === bytes.length));
  offAssets();

  // 整条 flow watchdog：load 卡住时 60 秒（测试里压到 25ms）收掉账本，释放后也不再发块。
  const realTimer = globalThis.setTimeout;
  try {
    globalThis.setTimeout = (fn, ms, ...args) => realTimer(fn, ms === 60_000 ? 25 : ms, ...args);
    globalThis.__holdIDB('k1');
    const hangBefore = playerSeen.length;
    player.send({ type: 'asset-request', requestId: 'r-flow-hang', keys: ['k1'] });
    await waitFor(() => host.assetTransferStats().players === 1);
    await waitFor(() => host.assetTransferStats().players === 0);
    globalThis.__releaseIDB('k1');
    await new Promise((r) => realTimer(r, 30));
    assert.equal(playerSeen.slice(hangBefore).some((m) => m.requestId === 'r-flow-hang'), false);
  } finally {
    globalThis.__releaseIDB('k1');
    globalThis.setTimeout = realTimer;
  }

  // 同一条 binding 第三条在途请求先排队；前两条结束后，第三条仍要传完，不能直接漏图。
  const capBefore = playerSeen.length;
  const capIds = new Set(['r-cap1', 'r-cap2', 'r-cap3']);
  player.send({ type: 'asset-request', requestId: 'r-cap1', keys: ['k1'] });
  player.send({ type: 'asset-request', requestId: 'r-cap2', keys: ['k1'] });
  player.send({ type: 'asset-request', requestId: 'r-cap3', keys: ['k1'] });
  await waitFor(() => {
    const ended = new Set(playerSeen.slice(capBefore).filter((m) => m.type === 'asset-end' && capIds.has(m.requestId)).map((m) => m.requestId));
    return ended.size === 3;
  });
  assert.equal(playerSeen.slice(capBefore).some((m) => m.type === 'asset-fail' && m.requestId === 'r-cap3'), false);
  await waitFor(() => host.assetTransferStats().players === 0);

  // 队列上限 8：2 条在途 + 8 条排队 = 10 条能进；第 11/12 条才 forbidden。
  const queueBefore = playerSeen.length;
  const queueIds = Array.from({ length: 12 }, (_, i) => `r-q${i}`);
  for (const requestId of queueIds) player.send({ type: 'asset-request', requestId, keys: ['k1'] });
  await waitFor(() => {
    const ended = new Set(playerSeen.slice(queueBefore).filter((m) => m.type === 'asset-end' && queueIds.includes(m.requestId)).map((m) => m.requestId));
    const failed = new Set(playerSeen.slice(queueBefore).filter((m) => m.type === 'asset-fail' && queueIds.includes(m.requestId)).map((m) => m.requestId));
    return ended.size >= 10 && failed.size === 2;
  }, 5000);
  await waitFor(() => host.assetTransferStats().players === 0);

  // 排队 watchdog：两条 active 占着，第三条排队超过 120 秒（测试压到 25ms）要回 forbidden，不能一直挂着。
  const queueTimerReal = globalThis.setTimeout;
  try {
    globalThis.setTimeout = (fn, ms, ...args) => queueTimerReal(fn, ms === 120_000 ? 25 : ms, ...args);
    const timeoutBefore = playerSeen.length;
    player.send({ type: 'asset-request', requestId: 'r-timeout-active1', keys: ['k1'] });
    player.send({ type: 'asset-request', requestId: 'r-timeout-active2', keys: ['k1'] });
    player.send({ type: 'asset-request', requestId: 'r-timeout-queued', keys: ['k1'] });
    await waitFor(() => playerSeen.slice(timeoutBefore).some((m) => m.type === 'asset-fail' && m.requestId === 'r-timeout-queued' && m.reason === 'forbidden'));
    await waitFor(() => host.assetTransferStats().players === 0);
    await new Promise((r) => queueTimerReal(r, 80));
    await waitFor(() => host.assetTransferStats().requests === 0);
    assert.equal(playerSeen.slice(timeoutBefore).some((m) => m.requestId === 'r-timeout-queued' && (m.type === 'asset-start' || m.type === 'asset-end')), false, '队列 timer reject 后不能又被 drain 启动');
  } finally {
    globalThis.setTimeout = queueTimerReal;
  }

  // 同一个 requestId 在途时再来一条：不能开第二条，直接回 forbidden。
  const dupBefore = playerSeen.length;
  player.send({ type: 'asset-request', requestId: 'r-dup', keys: ['k1'] });
  player.send({ type: 'asset-request', requestId: 'r-dup', keys: ['k1'] });
  await waitFor(() => playerSeen.slice(dupBefore).some((m) => m.type === 'asset-fail' && m.requestId === 'r-dup' && m.reason === 'forbidden'));
  await waitFor(() => host.assetTransferStats().players === 0);
  const dupMsgs = playerSeen.slice(dupBefore);
  assert.equal(dupMsgs.filter((m) => m.type === 'asset-start' && m.requestId === 'r-dup').length, 1, '第一条 r-dup 只能开一次');
  assert.equal(dupMsgs.some((m) => m.type === 'asset-end' && m.requestId === 'r-dup'), true, '第一条 r-dup 要正常传完');

  // 排队中的整条请求 cancel：直接从队列拿掉，不启动、不发 fail，也不影响 active 的两条。
  const wholeBefore = playerSeen.length;
  player.send({ type: 'asset-request', requestId: 'r-qcancel-hold1', keys: ['k1'] });
  player.send({ type: 'asset-request', requestId: 'r-qcancel-hold2', keys: ['k1'] });
  player.send({ type: 'asset-request', requestId: 'r-qcancel', keys: ['k1'] });
  await waitFor(() => host.assetTransferStats().requests === 2);
  player.send({ type: 'asset-cancel', requestId: 'r-qcancel' });
  await waitFor(() => host.assetTransferStats().players === 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(playerSeen.slice(wholeBefore).some((m) => m.requestId === 'r-qcancel'), false);

  // 排队中的请求被单 key cancel：只拿掉 k2，剩下的 k1 仍要传完，不能整条被删。
  const singleBefore = playerSeen.length;
  player.send({ type: 'asset-request', requestId: 'r-hold1', keys: ['k1'] });
  player.send({ type: 'asset-request', requestId: 'r-hold2', keys: ['k1'] });
  player.send({ type: 'asset-request', requestId: 'r-single', keys: ['k1', 'k2'] });
  await waitFor(() => host.assetTransferStats().requests === 2);
  player.send({ type: 'asset-cancel', requestId: 'r-single', key: 'k2' });
  await waitFor(() => {
    const msgs = playerSeen.slice(singleBefore);
    return msgs.some((m) => m.type === 'asset-end' && m.requestId === 'r-single' && m.key === 'k1');
  }, 6000);
  await waitFor(() => host.assetTransferStats().players === 0);
  const singleMsgs = playerSeen.slice(singleBefore);
  assert.equal(singleMsgs.some((m) => m.type === 'asset-end' && m.requestId === 'r-single' && m.key === 'k2'), false);
  assert.equal(singleMsgs.some((m) => m.type === 'asset-fail' && m.requestId === 'r-single'), false);

  // 一条请求里两个 key：前一个 start 后，后一个还在队列里，dock 应该看得到 queued=1。
  const queueStats = [];
  const offQueueStats = host.subscribeAssetTransferStats(() => queueStats.push(host.assetTransferStats()));
  player.send({ type: 'asset-request', requestId: 'r-queued', keys: ['k1', 'k2'] });
  await waitFor(() => queueStats.some((st) => st.queued === 1 && st.players === 1));
  // k2 forbidden 后要从排队里拿掉，不能一直算 queued。
  await waitFor(() => queueStats.some((st) => st.queued === 0 && st.players === 1));
  offQueueStats();
  await waitFor(() => host.assetTransferStats().players === 0);

  // 玩家 cancel 整个请求：账本要马上收起，不能等 serve 下一次检查。
  player.send({ type: 'asset-request', requestId: 'r-cancel', keys: ['k1'] });
  await waitFor(() => host.assetTransferStats().players === 1);
  player.send({ type: 'asset-cancel', requestId: 'r-cancel' });
  await waitFor(() => host.assetTransferStats().players === 0);

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

  // 试玩开始前还广播着：先给真实玩家发 stop、收走广播 key；试玩结束不自动恢复。
  host.playMedia('m1', '图', true);
  await waitFor(() => playerSeen.slice(afterLocalBefore).some((m) => m.type === 'play'));
  const trialBefore = playerSeen.length;
  host.startTrial();
  assert.ok(host.getUI().trial);
  await waitFor(() => playerSeen.slice(trialBefore).some((m) => m.type === 'stop'));
  assert.equal(host.getUI().nowPlaying, null);
  const trialAssetBefore = playerSeen.length;
  player.send({ type: 'asset-request', requestId: 'r-trial', keys: ['k1'] });
  await waitFor(() => playerSeen.slice(trialAssetBefore).some((m) => m.type === 'asset-fail' && m.key === 'k1' && m.reason === 'forbidden'));
  host.endTrial();
  assert.equal(host.getUI().trial, null);
  assert.equal(host.getUI().nowPlaying, null);

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

test('watchdog 收掉 active 后队列继续；reset 清掉排队请求', async () => {
  const server = await startServer({ port: 0, host: '127.0.0.1', playerOrigin: 'http://localhost:5179', allowNoOrigin: true });
  servers.push(server);
  const url = `ws://127.0.0.1:${server.port}`;

  const host = await load('host2.cjs', 'host', '');
  const w = host.emptyWorld();
  w.party = [{ id: 'pc', name: '甲', tags: [], color: '#fff' }];
  host.replaceWorld(w);
  w.maps[0].spawn = { x: 1, y: 1 };
  host.setUI({ mapId: w.maps[0].id });
  const localWindow = { closed: false, messages: [], postMessage(data) { this.messages.push(data); } };
  globalThis.window.open = () => localWindow;
  host.openPlayerWindow('pc');
  const created = await host.createOnlineHostRoom(url);
  const joinUrl = await host.inviteOnlinePlayer('pc');
  const u = new URL(joinUrl);
  const player = await load('player2.cjs', 'player', u.search);
  const joined = await player.joinOnlinePlayer(u.searchParams.get('room'), u.searchParams.get('invite'), url);
  await waitFor(() => host.pcIdForBinding(joined.binding) === 'pc');
  host.listenAsEditor(() => host.send({ type: 'world', world: host.getWorld() }));
  const playerSeen = [];
  player.listenAsPlayer((m) => playerSeen.push(m), { online: true, binding: joined.binding });
  await waitFor(() => playerSeen.some((m) => m.type === 'world' && m.world.viewerId === 'pc'));

  host.update((d) => { d.media.push({ id: 'm1', name: '图', mime: 'image/png', size: 1_048_576, key: 'k1' }); });
  await host.putRaw('k1', new Blob([new Uint8Array(1_048_576).fill(9)], { type: 'image/png' }));
  const playBefore = playerSeen.length;
  host.playMedia('m1', '图', true);
  await waitFor(() => playerSeen.slice(playBefore).some((m) => m.type === 'play'));

  // 两条 load 卡住的 active 被 watchdog 收掉；第三条排队，旧 serve 释放后要继续。
  const abortTimer = globalThis.setTimeout;
  const abortBefore = playerSeen.length;
  try {
    globalThis.setTimeout = (fn, ms, ...args) => abortTimer(fn, ms === 60_000 ? 100 : ms, ...args);
    globalThis.__holdIDB('k1');
    player.send({ type: 'asset-request', requestId: 'r-abort1', keys: ['k1'] });
    player.send({ type: 'asset-request', requestId: 'r-abort2', keys: ['k1'] });
    player.send({ type: 'asset-request', requestId: 'r-abort-queued', keys: ['k1'] });
    await waitFor(() => host.assetTransferStats().requests === 2);
    await waitFor(() => host.assetTransferStats().requests === 0);
    globalThis.setTimeout = abortTimer;
  } finally {
    globalThis.__releaseIDB('k1');
    globalThis.setTimeout = abortTimer;
  }
  await waitFor(() => playerSeen.slice(abortBefore).some((m) => m.type === 'asset-end' && m.requestId === 'r-abort-queued'), 6000);
  const abortMsgs = playerSeen.slice(abortBefore);
  assert.equal(abortMsgs.some((m) => (m.requestId === 'r-abort1' || m.requestId === 'r-abort2') && (m.type === 'asset-start' || m.type === 'asset-end')), false);
  await waitFor(() => host.assetTransferStats().requests === 0);

  // reset 同时清 active 账本和排队请求：不能留下一条会在后面启动的请求。
  const resetBefore = playerSeen.length;
  player.send({ type: 'asset-request', requestId: 'r-reset1', keys: ['k1'] });
  player.send({ type: 'asset-request', requestId: 'r-reset2', keys: ['k1'] });
  player.send({ type: 'asset-request', requestId: 'r-reset-queued', keys: ['k1'] });
  await waitFor(() => host.assetTransferStats().requests === 2);
  host.resetPlayerBindings();
  await waitFor(() => host.assetTransferStats().players === 0);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(host.assetTransferStats().requests, 0);
  assert.equal(playerSeen.slice(resetBefore).some((m) => m.requestId === 'r-reset-queued'), false);

  await host.closeOnlineHostRoom();
  assert.ok(created.roomId);
});
