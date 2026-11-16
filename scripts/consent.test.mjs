import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const host = 'http://localhost:5178', player = 'http://localhost:5179';
const temp = await mkdtemp(join(tmpdir(), 'ts-consent-'));
const bundle = join(temp, 'consent.cjs');
await build({
  stdin: {
    contents: `export * from './src/runtime/sync'; export * from './src/rules/consent'; export * from './src/rules/skillCast'; export * from './src/rules/skills'; export * from './src/core/defaults'; export * from './src/core/store';`,
    resolveDir: root,
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  define: { 'import.meta.env': JSON.stringify({ VITE_APP_ROLE: 'host', VITE_HOST_ORIGIN: host, VITE_PLAYER_ORIGIN: player }) },
});
const storage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.location = { origin: host, href: host + '/', search: '' };
const handlers = [];
let opened = [];
globalThis.window = {
  setTimeout: () => 0, setInterval: () => 0,
  addEventListener: (n, f) => { if (n === 'message') handlers.push(f); },
  removeEventListener: () => {},
  open: (url) => {
    const win = { url, closed: false, messages: [], postMessage(data, target) { this.messages.push({ data, target }); } };
    opened.push(win);
    return win;
  },
};
globalThis.BroadcastChannel = class { postMessage() {} addEventListener() {} removeEventListener() {} close() {} };
const api = createRequire(import.meta.url)(bundle);
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

function fixture() {
  const w = api.emptyWorld();
  w.party = [
    { id: 'pc', name: '甲', tags: [], color: '#fff', me: 20, meMax: 20, skills: ['037-9-101'] },
    { id: 'other', name: '乙', tags: [], color: '#fff', me: 20, meMax: 20, skills: [] },
  ];
  api.replaceWorld(w);
}
const decision = (castId) => ({ type: 'skill-decision', castId, ok: true, __ts: 'ts-map', seq: Math.random().toString(36), from: api.SESSION, inst: 'i', born: 1 });

test('技能同意只认发动者绑定的窗口', () => {
  fixture();
  api.openPlayerWindow('pc');
  api.openPlayerWindow('other');
  const [winPc, winOther] = opened;
  const off = api.listenPlayerDecisions();
  api.beginSkillCast('pc', '037-9-101', 'gm');
  const id = api.castOf().id;
  assert.equal(api.castOf().step, 'approval');

  // 不在 peers 里的攻击窗口：origin 对也没用
  handlers[0]({ origin: player, source: {}, data: decision(id) });
  assert.equal(api.castOf().step, 'approval');

  // 另一个玩家窗口（绑了 other）知道 castId 也不能替 pc 同意
  handlers[0]({ origin: player, source: winOther, data: decision(id) });
  assert.equal(api.castOf().step, 'approval');

  handlers[0]({ origin: player, source: winPc, data: decision(id) });
  assert.equal(api.castOf().step, 'confirm');
  off();
});
