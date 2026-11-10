// 试玩（沙盒）里不许撤销：世界退回去、账本和日志退不回去，屏幕会和日志打架。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-undo-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: {
    contents: `export * from './src/core/store';
export * from './src/core/defaults';`,
    resolveDir: root,
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.location = { search: '', origin: 'http://localhost' };
globalThis.window = { setTimeout: () => 0, open: () => ({ closed: false, postMessage() {} }) };
globalThis.BroadcastChannel = class { postMessage() {} };
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
const api = createRequire(import.meta.url)(bundle);
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

test('试玩里撤销/重做被挡住；退出试玩后照常能撤', () => {
  api.replaceWorld(api.emptyWorld());
  api.update((d) => { d.name = '正式名'; });

  api.beginSandbox();
  api.update((d) => { d.name = '试玩里改的'; });
  api.undo();
  assert.equal(api.getWorld().name, '试玩里改的', '试玩里 undo 不许生效');
  assert.match(api.getUI().toast ?? '', /试玩里不能撤销/);
  api.redo();
  assert.equal(api.getWorld().name, '试玩里改的', '试玩里 redo 也不许生效');
  assert.match(api.getUI().toast ?? '', /试玩里不能重做/);

  // 退出试玩：世界回到试玩前的样子
  api.endSandbox();
  assert.equal(api.getWorld().name, '正式名');

  // 正常模式撤销没被误伤
  api.update((d) => { d.name = '又改'; });
  api.undo();
  assert.equal(api.getWorld().name, '正式名');
});
