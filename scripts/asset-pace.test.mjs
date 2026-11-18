import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-asset-pace-'));
const bundle = join(temp, 'asset-pace.cjs');
await build({
  stdin: { contents: `export * from './src/runtime/assets';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
after(() => rm(temp, { recursive: true, force: true }));
const api = createRequire(import.meta.url)(bundle);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('两个 binding 按轮转拿全局 token，不会一个占满', async () => {
  const pacer = new api.AssetPacer();
  const seen = [];
  await Promise.all([0, 1, 2, 3].map((i) => pacer.wait(i % 2 === 0 ? 'a' : 'b', api.ASSET_PACE_MS).then(() => seen.push(i % 2 === 0 ? 'a' : 'b'))));
  assert.deepEqual(seen, ['a', 'b', 'a', 'b']);
});

test('单 binding 两块之间至少隔基线 45ms', async () => {
  const pacer = new api.AssetPacer();
  const times = [];
  await Promise.all([0, 1].map((i) => pacer.wait('solo', api.ASSET_PACE_MS).then(() => times.push(Date.now()))));
  assert.ok(times[1] - times[0] >= api.ASSET_PACE_MS - 5, `间隔 ${times[1] - times[0]}ms`);
});

test('全局 token 连续发时约 20ms 一块', async () => {
  const pacer = new api.AssetPacer();
  const times = [];
  await Promise.all([0, 1, 2].map((i) => pacer.wait(`g${i}`, 0).then(() => times.push(Date.now()))));
  const gaps = [times[1] - times[0], times[2] - times[1]];
  assert.ok(gaps.every((g) => g >= 10 && g < 200), `gap=${gaps.join(',')}`);
});
