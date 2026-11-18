// asset 在途账本：引用上限、总在途上限、cancel、旧连接换新账本。
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-asset-sessions-'));
const bundle = join(temp, 'asset-sessions.cjs');
await build({
  stdin: { contents: `export * from './src/runtime/assetSessions';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
after(() => rm(temp, { recursive: true, force: true }));
const api = createRequire(import.meta.url)(bundle);

test('同一 requestId 最多 4 个 serve，第 5 个不占引用', () => {
  const s = api.AssetSession.fresh();
  for (let i = 0; i < api.ASSET_MAX_REFS; i++) assert.equal(s.tryAcquire('r'), true);
  assert.equal(s.tryAcquire('r'), false);
  assert.equal(s.get('r'), api.ASSET_MAX_REFS);
  assert.equal(s.activeCount, api.ASSET_MAX_REFS);
  for (let i = 0; i < api.ASSET_MAX_REFS; i++) s.release('r');
  assert.equal(s.get('r'), 0);
  assert.equal(s.activeCount, 0);
});

test('总在途上限 64；到顶后新 requestId 不占', () => {
  const s = api.AssetSession.fresh();
  for (let i = 0; i < api.ASSET_MAX_ACTIVE; i++) assert.equal(s.tryAcquire(`r${i}`), true);
  assert.equal(s.activeCount, api.ASSET_MAX_ACTIVE);
  assert.equal(s.tryAcquire('r-new'), false);
  s.release('r0');
  assert.equal(s.tryAcquire('r-new'), true);
});

test('cancel 只认在途 requestId；key 上限 64；引用归零清 cancel', () => {
  const s = api.AssetSession.fresh();
  assert.equal(s.cancel('late'), false);
  assert.equal(s.tryAcquire('r'), true);
  assert.equal(s.tryAcquire('r'), true); // 两个 serve 共用 cancel
  assert.equal(s.cancel('r', 'a'), true);
  assert.equal(s.isCancelled('r', 'a'), true);
  assert.equal(s.isCancelled('r', 'b'), false);
  for (let i = 0; i < api.ASSET_MAX_CANCEL_KEYS + 5; i++) s.cancel('r', `k${i}`);
  assert.equal(s.isCancelled('r', 'k0'), true); // 前 64 个保留
  assert.equal(s.isCancelled('r', `k${api.ASSET_MAX_CANCEL_KEYS + 4}`), false);
  assert.equal(s.cancel('r'), true); // 不带 key = 整个 requestId
  assert.equal(s.isCancelled('r', 'b'), true);
  s.release('r');
  assert.equal(s.isCancelled('r', 'a'), true); // 还有一个 serve，不能丢 cancel
  s.release('r');
  assert.equal(s.isCancelled('r', 'a'), false); // 归零才清
});

test('换新账本后旧 serve 的 release 不碰新连接', () => {
  const old = api.AssetSession.fresh();
  assert.equal(old.tryAcquire('same'), true);
  const fresh = api.AssetSession.fresh();
  assert.equal(fresh.tryAcquire('same'), true);
  old.release('same');
  assert.equal(fresh.get('same'), 1);
  assert.equal(fresh.activeCount, 1);
});
