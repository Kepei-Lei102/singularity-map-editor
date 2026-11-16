import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-rooms-'));
const bundle = join(temp, 'rooms.cjs');
await build({
  stdin: { contents: `export * from './server/rooms'; export * from './src/protocol';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const api = createRequire(import.meta.url)(bundle);
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

test('关房后房间从表里删掉，size 归零', () => {
  let now = 0;
  const rooms = new api.RoomService({ now: () => now });
  const state = rooms.create('R', 'host');
  assert.ok(state);
  assert.equal(rooms.size(), 1);
  rooms.issueInvite('R', 'host', 'i1', 'inv1');
  const joined = rooms.join('R', 'inv1', 'b1', 'pt1');
  assert.equal(joined.ok, true);
  assert.equal(rooms.close('R', 'host').closed, true);
  assert.equal(rooms.size(), 0);
  assert.equal(rooms.relay('R', 'player', 'pt1'), null);
});

test('TTL：坏 token 不续命；到点 sweep 清掉', () => {
  let now = 0;
  const rooms = new api.RoomService({ now: () => now, ttlMs: 100 });
  rooms.create('R', 'host');
  now = 50;
  assert.equal(rooms.join('R', 'bad', 'b1', 'pt1').ok, false);
  now = 101;
  assert.deepEqual(rooms.sweep(), ['R']);
  assert.equal(rooms.size(), 0);
  assert.equal(rooms.peek('R'), null);
});

test('sweep 只清过期房，活着的房保留', () => {
  let now = 0;
  const rooms = new api.RoomService({ now: () => now, ttlMs: 100 });
  rooms.create('old', 'h1');
  now = 50;
  rooms.create('fresh', 'h2');
  now = 101;
  assert.deepEqual(rooms.sweep(), ['old']);
  assert.equal(rooms.size(), 1);
  assert.ok(rooms.peek('fresh'));
});
