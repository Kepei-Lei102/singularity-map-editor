import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-assets-'));
const bundle = join(temp, 'assets.cjs');
await build({
  stdin: { contents: `export * from './src/runtime/assets'; export { contentKey } from './src/runtime/media';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
const api = createRequire(import.meta.url)(bundle);
after(() => rm(temp, { recursive: true, force: true }));

const tick = () => new Promise((r) => setTimeout(r, 30));
const pattern = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);

test('base64 往返不丢字节，跨 256 KiB 边界也对', () => {
  const bytes = pattern(api.ASSET_CHUNK_BYTES + 137);
  const text = api.bytesToBase64(bytes);
  assert.deepEqual(api.base64ToBytes(text), bytes);
});

test('主持端按 key 分块发，玩家拼回并校验内容哈希', async () => {
  const bytes = pattern(api.ASSET_CHUNK_BYTES + 137);
  const blob = new Blob([bytes], { type: 'image/png' });
  const key = await api.contentKey(blob);
  const saved = [];
  const ready = [];
  const requests = [];
  const rec = api.createAssetReceiver({
    send: (body) => requests.push(body),
    load: async () => undefined,
    save: async (k, b) => { saved.push({ key: k, bytes: new Uint8Array(await b.arrayBuffer()), mime: b.type }); },
    onReady: (k) => ready.push(k),
  });
  await rec.request([key]);
  const req = requests[0];
  assert.equal(req.type, 'asset-request');
  const sent = [];
  await api.serveAssetRequest(req, {
    send: (body) => { sent.push(body); return true; },
    load: async () => blob,
    meta: (k) => k === key ? { mime: 'image/png' } : undefined,
    paceMs: 0,
  });
  const chunks = sent.filter((m) => m.type === 'asset-chunk');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].index, 0);
  assert.equal(chunks[0].count, 2);
  const start = sent.find((m) => m.type === 'asset-start' && m.key === key);
  assert.ok(start);
  assert.equal(start.bytes, blob.size); // 旧玩家端会忽略这个可选字段
  assert.ok(sent.some((m) => m.type === 'asset-end' && m.key === key && m.bytes === blob.size));

  for (const m of sent) rec.handle(m);
  await tick();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].key, key);
  assert.deepEqual(saved[0].bytes, bytes);
  assert.equal(saved[0].mime, 'image/png');
  assert.deepEqual(ready, [key]);
});

test('已缓存的 key 不再请求；超过 32 个 key 分批', async () => {
  const requests = [];
  const rec = api.createAssetReceiver({ send: (body) => requests.push(body), load: async (k) => k === 'cached' ? new Blob(['x']) : undefined, save: async () => {} });
  const keys = ['cached', ...Array.from({ length: 40 }, (_, i) => `k${i}`)];
  await rec.request(keys);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((m) => m.keys.length), [32, 8]);
});

test('65/200 个 key 继续按 32 个一批拆', async () => {
  for (const [n, expected] of [[65, [32, 32, 1]], [200, [32, 32, 32, 32, 32, 32, 8]]]) {
    const requests = [];
    const rec = api.createAssetReceiver({ send: (body) => requests.push(body), load: async () => undefined, save: async () => {}, timeoutMs: 0 });
    await rec.request(Array.from({ length: n }, (_, i) => `k${i}`));
    assert.deepEqual(requests.map((m) => m.keys.length), expected, `${n} keys`);
  }
});

test('32 个 key 全 load 超时：fail 续 watchdog，不会误杀整条流', async () => {
  let timedOut = 0;
  const sent = [];
  const keys = Array.from({ length: 32 }, (_, i) => `k${i}`);
  await api.serveAssetRequest({ type: 'asset-request', requestId: 'r-32-fail', keys }, {
    send: (body) => { sent.push(body); return true; },
    load: () => new Promise(() => {}),
    meta: () => ({ mime: 'image/png' }),
    paceMs: 0,
    loadTimeoutMs: 10,
    flowTimeoutMs: 50,
    onFlowTimeout: () => { timedOut++; },
  });
  assert.equal(timedOut, 0);
  assert.equal(sent.filter((m) => m.type === 'asset-fail' && m.reason === 'missing').length, 32);
});

test('主持端拒绝不在允许集合里的 key，缺文件/超大/读失败各有 fail', async () => {
  const cases = [
    ['forbidden', undefined, new Blob(['x']), undefined, {}],
    ['missing', { mime: 'image/png' }, undefined, undefined, {}],
    ['too-large', { mime: 'image/png' }, new Blob([pattern(10)]), undefined, { maxBytes: 4 }],
    ['read-failed', { mime: 'image/png' }, undefined, new Error('read'), {}],
  ];
  for (const [reason, meta, blob, error, extra] of cases) {
    const sent = [];
    let loads = 0;
    await api.serveAssetRequest({ type: 'asset-request', requestId: 'r' + reason, keys: ['k'] }, {
      send: (body) => { sent.push(body); return true; },
      load: async () => { loads++; if (error) throw error; return blob; },
      meta: () => meta,
      paceMs: 0,
      ...extra,
    });
    assert.equal(sent.length, 1, reason);
    assert.equal(sent[0].type, 'asset-fail');
    assert.equal(sent[0].reason, reason);
    if (reason === 'forbidden') assert.equal(loads, 0, '没允许的 key 不读本机文件');
  }
});

test('玩家收到 asset-fail 会清掉 pending 并回调', async () => {
  const requests = [];
  const fails = [];
  const rec = api.createAssetReceiver({ send: (body) => requests.push(body), load: async () => undefined, save: async () => {}, onFail: (k, r) => fails.push([k, r]) });
  await rec.request(['k']);
  const req = requests[0];
  rec.handle({ type: 'asset-fail', requestId: req.requestId, key: 'k', reason: 'missing' });
  assert.deepEqual(fails, [['k', 'missing']]);
  await rec.request(['k']);
  assert.equal(requests.length, 1, '失败后冷却期内不重问');
  rec.reset();
  await rec.request(['k']);
  assert.equal(requests.length, 2);
});

test('坏 chunk / 不完整的 end 不写文件也不抛', async () => {
  const requests = [];
  const saved = [];
  const rec = api.createAssetReceiver({ send: (body) => requests.push(body), load: async () => undefined, save: async (k, b) => saved.push(k) });
  await rec.request(['k']);
  const req = requests[0];
  assert.doesNotThrow(() => {
    rec.handle({ type: 'asset-start', requestId: req.requestId, key: 'k' });
    rec.handle({ type: 'asset-chunk', requestId: req.requestId, key: 'k', mime: 'image/png', index: 0, count: 2, data: 'not base64!!' });
    rec.handle({ type: 'asset-end', requestId: req.requestId, key: 'k', bytes: 1 });
  });
  assert.equal(saved.length, 0);
});

test('哈希不符会重试一次，第二次还错才失败', async () => {
  const wrong = new Blob([pattern(16)], { type: 'image/png' });
  const wrongKey = await api.contentKey(new Blob([pattern(15)]));
  const requests = [];
  const fails = [];
  const saved = [];
  const rec = api.createAssetReceiver({ send: (body) => requests.push(body), load: async () => undefined, save: async (k) => saved.push(k), onFail: (k, r) => fails.push([k, r]) });
  await rec.request([wrongKey]);
  const first = requests[0];
  const sent = [];
  await api.serveAssetRequest(first, {
    send: (body) => { sent.push(body); return true; },
    load: async () => wrong,
    meta: () => ({ mime: 'image/png' }),
    paceMs: 0,
  });
  for (const m of sent) rec.handle(m);
  await tick();
  assert.equal(saved.length, 0);
  assert.equal(requests.length, 2, '第一次哈希错后要再请求一次');
  assert.equal(requests[1].type, 'asset-request');
  assert.deepEqual(requests[1].keys, [wrongKey]);

  const sent2 = [];
  await api.serveAssetRequest(requests[1], {
    send: (body) => { sent2.push(body); return true; },
    load: async () => wrong,
    meta: () => ({ mime: 'image/png' }),
    paceMs: 0,
  });
  for (const m of sent2) rec.handle(m);
  await tick();
  assert.equal(saved.length, 0);
  assert.deepEqual(fails, [[wrongKey, 'read-failed']]);
});


test('主持端被取消后不再发后面的块，也不发 end', async () => {
  const blob = new Blob([pattern(api.ASSET_CHUNK_BYTES + 1)]);
  let cancelled = false;
  const sent = [];
  await api.serveAssetRequest({ type: 'asset-request', requestId: 'r-cancel', keys: ['k'] }, {
    send: (body) => { sent.push(body); if (body.type === 'asset-chunk' && body.index === 0) cancelled = true; return true; },
    load: async () => blob,
    meta: () => ({ mime: 'image/png' }),
    paceMs: 0,
    isCancelled: () => cancelled,
  });
  assert.equal(sent.filter((m) => m.type === 'asset-chunk').length, 1);
  assert.equal(sent.some((m) => m.type === 'asset-end'), false);
});

test('玩家 reset 会给在途请求发 cancel，之后可以重新请求', async () => {
  const requests = [];
  const rec = api.createAssetReceiver({ send: (body) => requests.push(body), load: async () => undefined, save: async () => {}, timeoutMs: 0 });
  await rec.request(['k']);
  const first = requests[0];
  rec.reset();
  assert.equal(requests[1]?.type, 'asset-cancel');
  assert.equal(requests[1]?.requestId, first.requestId);
  await rec.request(['k']);
  assert.equal(requests[2]?.type, 'asset-request');
});

test('排队 watchdog：没等到 asset-start 会 fail 并清 pending', async () => {
  const requests = [];
  const fails = [];
  const rec = api.createAssetReceiver({ send: (body) => requests.push(body), load: async () => undefined, save: async () => {}, onFail: (k, r) => fails.push([k, r]), timeoutMs: 5, queueTimeoutMs: 5 });
  await rec.request(['k']);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fails, [['k', 'read-failed']]);
  assert.ok(requests.some((m) => m.type === 'asset-cancel' && m.key === 'k'), '超时要让主持端别再发这个 key');
  const before = requests.length;
  await rec.request(['k']);
  assert.equal(requests.length, before, '冷却期内不重问');
});

test('块超过 256 KiB、end bytes 不符都会 fail，不写文件', async () => {
  const mk = () => {
    const requests = [];
    const fails = [];
    const saved = [];
    const rec = api.createAssetReceiver({ send: (body) => requests.push(body), load: async () => undefined, save: async (k) => saved.push(k), onFail: (k, r) => fails.push([k, r]), timeoutMs: 0 });
    return { rec, requests, fails, saved };
  };
  {
    const { rec, requests, fails, saved } = mk();
    await rec.request(['big']);
    const req = requests[0];
    rec.handle({ type: 'asset-start', requestId: req.requestId, key: 'big' });
    rec.handle({ type: 'asset-chunk', requestId: req.requestId, key: 'big', mime: 'image/png', index: 0, count: 1, data: api.bytesToBase64(pattern(api.ASSET_CHUNK_BYTES + 1)) });
    assert.deepEqual(fails, [['big', 'too-large']]);
    assert.equal(saved.length, 0);
  }
  {
    const { rec, requests, fails, saved } = mk();
    await rec.request(['k']);
    const req = requests[0];
    rec.handle({ type: 'asset-start', requestId: req.requestId, key: 'k' });
    rec.handle({ type: 'asset-chunk', requestId: req.requestId, key: 'k', mime: 'image/png', index: 0, count: 1, data: api.bytesToBase64(pattern(3)) });
    rec.handle({ type: 'asset-end', requestId: req.requestId, key: 'k', bytes: 99 });
    assert.deepEqual(fails, [['k', 'read-failed']]);
    assert.equal(saved.length, 0);
  }
});


test('world 换 allow 后不再读文件/不再发下一块，发 forbidden', async () => {
  let allowed = true;
  let loads = 0;
  const sent = [];
  await api.serveAssetRequest({ type: 'asset-request', requestId: 'r-live', keys: ['k'] }, {
    send: (body) => { sent.push(body); if (body.type === 'asset-chunk' && body.index === 0) allowed = false; return true; },
    load: async () => { loads++; return new Blob([pattern(api.ASSET_CHUNK_BYTES + 1)]); },
    meta: () => allowed ? { mime: 'image/png' } : undefined,
    paceMs: 0,
  });
  assert.equal(loads, 1);
  assert.equal(sent.filter((m) => m.type === 'asset-chunk').length, 1);
  assert.equal(sent.some((m) => m.type === 'asset-end'), false);
  assert.ok(sent.some((m) => m.type === 'asset-fail' && m.reason === 'forbidden'));
});

test('meta 说文件超大时不先读整份 Blob', async () => {
  let loads = 0;
  const sent = [];
  await api.serveAssetRequest({ type: 'asset-request', requestId: 'r-big', keys: ['k'] }, {
    send: (body) => { sent.push(body); return true; },
    load: async () => { loads++; return new Blob([pattern(100)]); },
    meta: () => ({ mime: 'image/png', size: 100 }),
    maxBytes: 50,
    paceMs: 0,
  });
  assert.equal(loads, 0);
  assert.deepEqual(sent.map((m) => [m.type, m.reason]), [['asset-fail', 'too-large']]);
});


test('同批多 key：一个 key 的 timer 不影响另一个；收到 chunk 会续期', async () => {
  const requests = [];
  const fails = [];
  const rec = api.createAssetReceiver({ send: (body) => requests.push(body), load: async () => undefined, save: async () => {}, onFail: (k, r) => fails.push([k, r]), timeoutMs: 20 });
  await rec.request(['a', 'b']);
  const req = requests[0];
  rec.handle({ type: 'asset-start', requestId: req.requestId, key: 'a' });
  rec.handle({ type: 'asset-start', requestId: req.requestId, key: 'b' });
  await new Promise((r) => setTimeout(r, 10));
  rec.handle({ type: 'asset-chunk', requestId: req.requestId, key: 'b', mime: 'image/png', index: 0, count: 2, data: api.bytesToBase64(pattern(1)) });
  await new Promise((r) => setTimeout(r, 12));
  assert.deepEqual(fails, [['a', 'read-failed']], 'a 到点，b 因为收到块被续期');
  await new Promise((r) => setTimeout(r, 12));
  assert.deepEqual(fails, [['a', 'read-failed'], ['b', 'read-failed']]);
  assert.ok(requests.some((m) => m.type === 'asset-cancel' && m.key === 'b'));
});

test('最后一块之后 allow 被撤，不再发 end，改发 forbidden', async () => {
  let allowed = true;
  const sent = [];
  await api.serveAssetRequest({ type: 'asset-request', requestId: 'r-end', keys: ['k'] }, {
    send: (body) => { sent.push(body); if (body.type === 'asset-chunk' && body.index === 1) allowed = false; return true; },
    load: async () => new Blob([pattern(api.ASSET_CHUNK_BYTES + 1)]),
    meta: () => allowed ? { mime: 'image/png' } : undefined,
    paceMs: 0,
  });
  assert.equal(sent.filter((m) => m.type === 'asset-chunk').length, 2);
  assert.equal(sent.some((m) => m.type === 'asset-end'), false);
  assert.ok(sent.some((m) => m.type === 'asset-fail' && m.reason === 'forbidden'));
});


test('asset-start 到达会把排队 watchdog 换成这个 key 的 inactivity timer', async () => {
  const requests = [];
  const fails = [];
  const rec = api.createAssetReceiver({ send: (body) => requests.push(body), load: async () => undefined, save: async () => {}, onFail: (k, r) => fails.push([k, r]), timeoutMs: 10, queueTimeoutMs: 20 });
  await rec.request(['k']);
  const req = requests[0];
  await new Promise((r) => setTimeout(r, 15));
  rec.handle({ type: 'asset-start', requestId: req.requestId, key: 'k' });
  await new Promise((r) => setTimeout(r, 8));
  assert.deepEqual(fails, [], '排队 watchdog 已被 start 清掉，inactivity 还没到');
  await new Promise((r) => setTimeout(r, 8));
  assert.deepEqual(fails, [['k', 'read-failed']], 'start 后 10ms 没有块才超时');
});


test('start 前的 chunk/end 被忽略；start 后正常拼回', async () => {
  const requests = [];
  const saved = [];
  const ready = [];
  const fails = [];
  const rec = api.createAssetReceiver({ send: (body) => requests.push(body), load: async () => undefined, save: async (k) => saved.push(k), onReady: (k) => ready.push(k), onFail: (k, r) => fails.push([k, r]), timeoutMs: 0 });
  await rec.request(['k']);
  const req = requests[0];
  rec.handle({ type: 'asset-chunk', requestId: req.requestId, key: 'k', mime: 'image/png', index: 0, count: 1, data: api.bytesToBase64(pattern(3)) });
  rec.handle({ type: 'asset-end', requestId: req.requestId, key: 'k', bytes: 3 });
  await tick();
  assert.equal(saved.length, 0, 'start 前不接收');
  assert.deepEqual(fails, [], 'start 前 end 被忽略，不该提前 fail');
  rec.handle({ type: 'asset-start', requestId: req.requestId, key: 'k' });
  rec.handle({ type: 'asset-end', requestId: req.requestId, key: 'k', bytes: 3 });
  await tick();
  assert.equal(saved.length, 0);
  assert.deepEqual(fails, [['k', 'read-failed']], 'start 前的 chunk 没有被偷偷留下，end 才会因为缺块失败');
  rec.reset();
  await rec.request(['k']);
  const req2 = requests.filter((m) => m.type === 'asset-request')[1];
  rec.handle({ type: 'asset-start', requestId: req2.requestId, key: 'k' });
  rec.handle({ type: 'asset-chunk', requestId: req2.requestId, key: 'k', mime: 'image/png', index: 0, count: 1, data: api.bytesToBase64(pattern(3)) });
  rec.handle({ type: 'asset-end', requestId: req2.requestId, key: 'k', bytes: 3 });
  await tick();
  assert.equal(saved.length, 1);
  assert.deepEqual(ready, ['k']);
});

test('重复 start 不会把 inactivity 往后推', async () => {
  const requests = [];
  const fails = [];
  const rec = api.createAssetReceiver({ send: (body) => requests.push(body), load: async () => undefined, save: async () => {}, onFail: (k, r) => fails.push([k, r]), timeoutMs: 20, queueTimeoutMs: 0 });
  await rec.request(['k']);
  const req = requests[0];
  rec.handle({ type: 'asset-start', requestId: req.requestId, key: 'k' });
  await new Promise((r) => setTimeout(r, 10));
  rec.handle({ type: 'asset-start', requestId: req.requestId, key: 'k' });
  await new Promise((r) => setTimeout(r, 12));
  assert.deepEqual(fails, [['k', 'read-failed']], '第二次 start 不该续命');
});

test('load 后、start 前 cancel 不再发 start，也不发 fail', async () => {
  let cancelled = false;
  const sent = [];
  await api.serveAssetRequest({ type: 'asset-request', requestId: 'r-load', keys: ['k'] }, {
    send: (body) => { sent.push(body); return true; },
    load: async () => { cancelled = true; return new Blob([pattern(3)]); },
    meta: () => ({ mime: 'image/png' }),
    paceMs: 0,
    isCancelled: () => cancelled,
  });
  assert.deepEqual(sent, []);
});

test('整条 flow 卡住：watchdog 触发后不再发 start', async () => {
  let timedOut = 0;
  let release;
  const sent = [];
  const task = api.serveAssetRequest({ type: 'asset-request', requestId: 'r-flow-hang', keys: ['k'] }, {
    send: (body) => { sent.push(body); return true; },
    load: () => new Promise((r) => { release = r; }),
    meta: () => ({ mime: 'image/png' }),
    paceMs: 0,
    flowTimeoutMs: 20,
    onFlowTimeout: () => { timedOut++; },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(timedOut, 1);
  release(new Blob([pattern(3)]));
  await task;
  assert.deepEqual(sent, []);
});

test('flowTimeoutMs:0 完全关掉 watchdog，慢 load 仍能正常发完', async () => {
  let release;
  let timedOut = 0;
  const sent = [];
  const task = api.serveAssetRequest({ type: 'asset-request', requestId: 'r-flow-off', keys: ['k'] }, {
    send: (body) => { sent.push(body); return true; },
    load: () => new Promise((r) => { release = r; }),
    meta: () => ({ mime: 'image/png' }),
    paceMs: 0,
    flowTimeoutMs: 0,
    onFlowTimeout: () => { timedOut++; },
  });
  await new Promise((r) => setTimeout(r, 30));
  release(new Blob([pattern(3)]));
  await task;
  assert.equal(timedOut, 0);
  assert.deepEqual(sent.map((m) => m.type), ['asset-start', 'asset-chunk', 'asset-end']);
});

test('watchdog 每发一块就续命，正常两块不会被误杀', async () => {
  let timedOut = 0;
  const sent = [];
  await api.serveAssetRequest({ type: 'asset-request', requestId: 'r-flow-alive', keys: ['k'] }, {
    send: (body) => { sent.push(body); return true; },
    load: async () => new Blob([pattern(api.ASSET_CHUNK_BYTES + 137)]),
    meta: () => ({ mime: 'image/png' }),
    paceMs: 30,
    flowTimeoutMs: 80,
    onFlowTimeout: () => { timedOut++; },
  });
  assert.equal(timedOut, 0);
  assert.equal(sent.filter((m) => m.type === 'asset-end').length, 1);
});

test('最后一块后、end 的节流窗口里 cancel，不再发 end', async () => {
  let cancelled = false;
  const sent = [];
  await api.serveAssetRequest({ type: 'asset-request', requestId: 'r-end-cancel', keys: ['k'] }, {
    send: (body) => {
      sent.push(body);
      // 0ms 定时器排在 end 的 50ms 节流之前；静态 end 检查发生在这一拍内，所以 cancel 只会被回调看到。
      if (body.type === 'asset-chunk') setTimeout(() => { cancelled = true; }, 0);
      return true;
    },
    load: async () => new Blob([pattern(3)]),
    meta: () => ({ mime: 'image/png' }),
    paceMs: 50,
    isCancelled: () => cancelled,
  });
  assert.equal(sent.some((m) => m.type === 'asset-end'), false);
});


test('同一个 key 并发 request 只发一次', async () => {
  const requests = [];
  const rec = api.createAssetReceiver({ send: (body) => requests.push(body), load: async () => undefined, save: async () => {}, timeoutMs: 0 });
  await Promise.all([rec.request(['k']), rec.request(['k'])]);
  assert.equal(requests.filter((m) => m.type === 'asset-request').length, 1);
});

test('reset 后正在 save 的旧 finish 不再 onReady', async () => {
  let release;
  let saves = 0;
  const ready = [];
  const requests = [];
  const rec = api.createAssetReceiver({
    send: (body) => requests.push(body),
    load: async () => undefined,
    save: async () => { saves++; await new Promise((r) => { release = r; }); },
    onReady: (k) => ready.push(k),
    timeoutMs: 0,
  });
  await rec.request(['k']);
  const req = requests[0];
  rec.handle({ type: 'asset-start', requestId: req.requestId, key: 'k' });
  rec.handle({ type: 'asset-chunk', requestId: req.requestId, key: 'k', mime: 'image/png', index: 0, count: 1, data: api.bytesToBase64(pattern(3)) });
  rec.handle({ type: 'asset-end', requestId: req.requestId, key: 'k', bytes: 3 });
  assert.equal(saves, 1);
  rec.reset();
  release();
  await tick();
  assert.deepEqual(ready, []);
});


test('reset 会 fence 还在 load 的 request，不再发 asset-request', async () => {
  let release;
  const requests = [];
  const rec = api.createAssetReceiver({
    send: (body) => requests.push(body),
    load: async () => { await new Promise((r) => { release = r; }); return undefined; },
    save: async () => {},
    timeoutMs: 0,
  });
  const pending = rec.request(['k']);
  await tick();
  rec.reset();
  release();
  await pending;
  assert.equal(requests.filter((m) => m.type === 'asset-request').length, 0);
});

test('fail 也走节流钟', async () => {
  const start = Date.now();
  await api.serveAssetRequest({ type: 'asset-request', requestId: 'r-pace', keys: ['a', 'b'] }, {
    send: () => true,
    load: async () => undefined,
    meta: () => undefined,
    paceMs: 8,
  });
  assert.ok(Date.now() - start >= 6, '两个 fail 至少要隔一个节流间隔');
});

test('节流/排队常量守住 60 条/s 预算', () => {
  assert.ok(api.ASSET_PACE_MS >= 40);
  assert.ok(api.ASSET_QUEUE_TIMEOUT_MS >= 120_000);
});


test('load 后、start 前 allow 被撤掉，不发 start，发 forbidden', async () => {
  let allowed = true;
  const sent = [];
  await api.serveAssetRequest({ type: 'asset-request', requestId: 'r-load-allow', keys: ['k'] }, {
    send: (body) => { sent.push(body); return true; },
    load: async () => { allowed = false; return new Blob([pattern(3)]); },
    meta: () => allowed ? { mime: 'image/png' } : undefined,
    paceMs: 0,
  });
  assert.equal(sent.some((m) => m.type === 'asset-start'), false);
  assert.ok(sent.some((m) => m.type === 'asset-fail' && m.reason === 'forbidden'));
});

test('单 key 在 end 前被 cancel 只跳过这个 key，同批后面的 key 继续', async () => {
  const canceled = new Set();
  const sent = [];
  await api.serveAssetRequest({ type: 'asset-request', requestId: 'r-end-two', keys: ['a', 'b'] }, {
    send: (body) => {
      sent.push(body);
      if (body.type === 'asset-chunk' && body.key === 'a') canceled.add('a');
      return true;
    },
    load: async () => new Blob([pattern(3)]),
    meta: () => ({ mime: 'image/png' }),
    paceMs: 0,
    isCancelled: (key) => !!key && canceled.has(key),
  });
  assert.equal(sent.some((m) => m.type === 'asset-end' && m.key === 'a'), false);
  assert.ok(sent.some((m) => m.type === 'asset-end' && m.key === 'b'));
});


test('start 的 paced 窗口里 allow 撤掉：只拒绝这个 key，同批后面的 key 继续', async () => {
  // 先把全局节流钟推到未来，保证 a 的 start 真的会等一会儿。
  await api.serveAssetRequest({ type: 'asset-request', requestId: 'warm', keys: ['w'] }, {
    send: () => true, load: async () => new Blob([pattern(1)]), meta: () => ({ mime: 'image/png' }), paceMs: 40,
  });
  let allowA = true;
  const sent = [];
  const task = api.serveAssetRequest({ type: 'asset-request', requestId: 'r-start-revoke', keys: ['a', 'b'] }, {
    send: (body) => { sent.push(body); return true; },
    load: async () => new Blob([pattern(3)]),
    meta: (key) => (key === 'a' ? (allowA ? { mime: 'image/png' } : undefined) : { mime: 'image/png' }),
    paceMs: 20,
  });
  setTimeout(() => { allowA = false; }, 5);
  await task;
  assert.equal(sent.some((m) => m.type === 'asset-start' && m.key === 'a'), false);
  assert.ok(sent.some((m) => m.type === 'asset-fail' && m.key === 'a' && m.reason === 'forbidden'));
  assert.ok(sent.some((m) => m.type === 'asset-start' && m.key === 'b'));
  assert.ok(sent.some((m) => m.type === 'asset-end' && m.key === 'b'));
});

test('start 的 paced 窗口里 cancel 掉 a：a 不 start，同批 b 继续', async () => {
  // 单独跑也要把全局节流钟推到未来，否则 a 的 start 可能在 5ms cancel 前就发出去了。
  await api.serveAssetRequest({ type: 'asset-request', requestId: 'warm-start-cancel', keys: ['w'] }, {
    send: () => true, load: async () => new Blob([pattern(1)]), meta: () => ({ mime: 'image/png' }), paceMs: 40,
  });
  let canceled = false;
  const sent = [];
  const task = api.serveAssetRequest({ type: 'asset-request', requestId: 'r-start-cancel', keys: ['a', 'b'] }, {
    send: (body) => { sent.push(body); return true; },
    load: async () => new Blob([pattern(3)]),
    meta: () => ({ mime: 'image/png' }),
    paceMs: 20,
    isCancelled: (key) => key === 'a' && canceled,
  });
  setTimeout(() => { canceled = true; }, 5);
  await task;
  assert.equal(sent.some((m) => m.type === 'asset-start' && m.key === 'a'), false);
  assert.ok(sent.some((m) => m.type === 'asset-start' && m.key === 'b'));
  assert.ok(sent.some((m) => m.type === 'asset-end' && m.key === 'b'));
});

test('end 的节流窗口里只 cancel a：a 跳过 end，同批 b 继续', async () => {
  let cancelA = false;
  const sent = [];
  const task = api.serveAssetRequest({ type: 'asset-request', requestId: 'r-end-window', keys: ['a', 'b'] }, {
    send: (body) => {
      sent.push(body);
      if (body.type === 'asset-chunk' && body.key === 'a') setTimeout(() => { cancelA = true; }, 5);
      return true;
    },
    load: async () => new Blob([pattern(3)]),
    meta: () => ({ mime: 'image/png' }),
    paceMs: 20,
    isCancelled: (key) => key === 'a' && cancelA,
  });
  await task;
  assert.equal(sent.some((m) => m.type === 'asset-end' && m.key === 'a'), false);
  assert.ok(sent.some((m) => m.type === 'asset-end' && m.key === 'b'));
});


test('retry 绕过一次失败冷却', async () => {
  const requests = [];
  const rec = api.createAssetReceiver({ send: (body) => requests.push(body), load: async () => undefined, save: async () => {}, timeoutMs: 0 });
  await rec.request(['k']);
  const req = requests[0];
  rec.handle({ type: 'asset-fail', requestId: req.requestId, key: 'k', reason: 'read-failed' });
  await rec.request(['k']);
  assert.equal(requests.filter((m) => m.type === 'asset-request').length, 1, '冷却期内普通 request 不发');
  await rec.retry(['k']);
  assert.equal(requests.filter((m) => m.type === 'asset-request').length, 2);
});


test('第一块发出前 allow 在节流窗口被撤：不发 chunk，发 forbidden', async () => {
  let allowed = true;
  const sent = [];
  await api.serveAssetRequest({ type: 'asset-request', requestId: 'r-chunk-window', keys: ['k'] }, {
    send: (body) => {
      sent.push(body);
      if (body.type === 'asset-start') setTimeout(() => { allowed = false; }, 0);
      return true;
    },
    load: async () => new Blob([pattern(3)]),
    meta: () => (allowed ? { mime: 'image/png' } : undefined),
    paceMs: 50,
  });
  assert.equal(sent.some((m) => m.type === 'asset-chunk'), false);
  assert.ok(sent.some((m) => m.type === 'asset-fail' && m.reason === 'forbidden'));
});

test('end 的节流窗口里 allow 被撤：不发 end，发 forbidden', async () => {
  let allowed = true;
  const sent = [];
  await api.serveAssetRequest({ type: 'asset-request', requestId: 'r-end-allow-window', keys: ['k'] }, {
    send: (body) => {
      sent.push(body);
      if (body.type === 'asset-chunk') setTimeout(() => { allowed = false; }, 0);
      return true;
    },
    load: async () => new Blob([pattern(3)]),
    meta: () => (allowed ? { mime: 'image/png' } : undefined),
    paceMs: 50,
  });
  assert.equal(sent.some((m) => m.type === 'asset-end'), false);
  assert.ok(sent.some((m) => m.type === 'asset-fail' && m.reason === 'forbidden'));
});


test('接收端按 asset-start 的总字节数报进度', async () => {
  const requests = [];
  const progress = [];
  const ready = [];
  const rec = api.createAssetReceiver({
    send: (body) => requests.push(body),
    load: async () => undefined,
    save: async () => {},
    onProgress: (key, received, total) => progress.push([key, received, total]),
    onReady: (key) => ready.push(key),
  });
  await rec.request(['k']);
  const req = requests[0];
  rec.handle({ type: 'asset-start', requestId: req.requestId, key: 'k', bytes: 3 });
  rec.handle({ type: 'asset-chunk', requestId: req.requestId, key: 'k', mime: 'image/png', index: 0, count: 1, data: api.bytesToBase64(Uint8Array.from([1, 2, 3])) });
  rec.handle({ type: 'asset-end', requestId: req.requestId, key: 'k', bytes: 3 });
  await tick();
  assert.deepEqual(progress, [['k', 0, 3], ['k', 3, 3], ['k', 3, 3]]);
  assert.deepEqual(ready, ['k']);
});

test('asset-start 没带字节数时进度不编百分比', async () => {
  const requests = [];
  const progress = [];
  const rec = api.createAssetReceiver({
    send: (body) => requests.push(body),
    load: async () => undefined,
    save: async () => {},
    onProgress: (key, received, total) => progress.push([key, received, total]),
  });
  await rec.request(['k']);
  const req = requests[0];
  rec.handle({ type: 'asset-start', requestId: req.requestId, key: 'k' });
  rec.handle({ type: 'asset-chunk', requestId: req.requestId, key: 'k', mime: 'image/png', index: 0, count: 1, data: api.bytesToBase64(Uint8Array.from([1, 2, 3])) });
  rec.handle({ type: 'asset-end', requestId: req.requestId, key: 'k', bytes: 3 });
  await tick();
  assert.deepEqual(progress, [['k', 0, undefined], ['k', 3, undefined], ['k', 3, undefined]]);
});


test('cancel(key) 只取消这个 key，晚到的块不再写、也不报失败', async () => {
  const requests = [];
  const saved = [];
  const fails = [];
  const rec = api.createAssetReceiver({
    send: (body) => requests.push(body),
    load: async () => undefined,
    save: async (k) => saved.push(k),
    onFail: (k, r) => fails.push([k, r]),
  });
  await rec.request(['a', 'b']);
  const req = requests[0];
  rec.handle({ type: 'asset-start', requestId: req.requestId, key: 'a' });
  rec.handle({ type: 'asset-start', requestId: req.requestId, key: 'b' });
  rec.cancel(['a']);
  assert.ok(requests.some((m) => m.type === 'asset-cancel' && m.key === 'a'));
  assert.equal(requests.filter((m) => m.type === 'asset-cancel').length, 1);
  rec.handle({ type: 'asset-chunk', requestId: req.requestId, key: 'a', mime: 'image/png', index: 0, count: 1, data: api.bytesToBase64(Uint8Array.from([9])) });
  rec.handle({ type: 'asset-end', requestId: req.requestId, key: 'a', bytes: 1 });
  rec.handle({ type: 'asset-fail', requestId: req.requestId, key: 'a', reason: 'missing' });
  rec.handle({ type: 'asset-chunk', requestId: req.requestId, key: 'b', mime: 'image/png', index: 0, count: 1, data: api.bytesToBase64(Uint8Array.from([1])) });
  rec.handle({ type: 'asset-end', requestId: req.requestId, key: 'b', bytes: 1 });
  await tick();
  assert.deepEqual(saved, ['b']);
  assert.deepEqual(fails, []);
});


test('同批前一个 key 开始传，会给还没轮到的 key 续排队 watchdog', async () => {
  const requests = [];
  const fails = [];
  const saved = [];
  const rec = api.createAssetReceiver({
    send: (body) => requests.push(body),
    load: async () => undefined,
    save: async (k) => saved.push(k),
    onFail: (k, r) => fails.push([k, r]),
    timeoutMs: 0,
    queueTimeoutMs: 100,
  });
  await rec.request(['a', 'b']);
  const req = requests[0];
  await new Promise((r) => setTimeout(r, 80)); // a 还没开始，b 的原始 100ms 死线快到了
  rec.handle({ type: 'asset-start', requestId: req.requestId, key: 'a' });
  await new Promise((r) => setTimeout(r, 50)); // 已过原始 100ms，但 a start 把 b 续到 ~180ms
  assert.deepEqual(fails, []);
  rec.handle({ type: 'asset-start', requestId: req.requestId, key: 'b' });
  rec.handle({ type: 'asset-chunk', requestId: req.requestId, key: 'b', mime: 'image/png', index: 0, count: 1, data: api.bytesToBase64(Uint8Array.from([1])) });
  rec.handle({ type: 'asset-end', requestId: req.requestId, key: 'b', bytes: 1 });
  await tick();
  assert.deepEqual(saved, ['b']);
});


test('主持端 load 卡住会按超时当 missing，不吊住整批', async () => {
  const sent = [];
  await api.serveAssetRequest({ type: 'asset-request', requestId: 'r-load', keys: ['k'] }, {
    send: (body) => { sent.push(body); return true; },
    load: () => new Promise(() => {}),
    meta: () => ({ mime: 'image/png', size: 1 }),
    paceMs: 0,
    loadTimeoutMs: 20,
  });
  assert.ok(sent.some((m) => m.type === 'asset-fail' && m.key === 'k' && m.reason === 'missing'));
});


test('主持端从 Blob 切片也设上限，arrayBuffer 卡住会 fail 并停这个 key', async () => {
  const sent = [];
  const stuck = { size: 1, slice: () => ({ arrayBuffer: () => new Promise(() => {}) }) };
  await api.serveAssetRequest({ type: 'asset-request', requestId: 'r-slice', keys: ['k'] }, {
    send: (body) => { sent.push(body); return true; },
    load: async () => stuck,
    meta: () => ({ mime: 'image/png', size: 1 }),
    paceMs: 0,
    sliceTimeoutMs: 20,
  });
  assert.ok(sent.some((m) => m.type === 'asset-start' && m.key === 'k'));
  assert.ok(sent.some((m) => m.type === 'asset-fail' && m.key === 'k' && m.reason === 'read-failed'));
  assert.equal(sent.some((m) => m.type === 'asset-end'), false);
});
