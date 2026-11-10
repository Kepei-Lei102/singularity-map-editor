// 卡片接线的回归网：真的把 TrialEventCard 渲染出来看 HTML，而不是只测函数。
// 背景：只测 damageLost/damageLanded 抓不到「组件把 −{lost} 写成 −{ev.damage}」这类改动。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
// bundle 必须落在仓库里：外部依赖 react 要能从 bundle 位置解析到 node_modules（放 /tmp 会 MODULE_NOT_FOUND）。
const temp = await mkdtemp(join(root, '.card-test-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: {
    contents: `export * from './src/core/store';
export * from './src/core/defaults';
export { TrialEventCard } from './src/components/TrialEventCard';`,
    resolveDir: root,
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  external: ['react'],
});
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.location = { search: '', origin: 'http://localhost' };
globalThis.window = { setTimeout: () => 0, open: () => ({ closed: false, postMessage() {} }) };
globalThis.BroadcastChannel = class { postMessage() {} };
globalThis.crypto ??= (await import('node:crypto')).webcrypto;

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
// 服务端渲染没有 getServerSnapshot：替成直接读快照（组件里的 useEffect 在 SSR 本来也不跑）。
const realUseSyncExternalStore = React.useSyncExternalStore;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

const api = require(bundle);
const { after } = await import('node:test');
after(() => { React.useSyncExternalStore = realUseSyncExternalStore; return rm(temp, { recursive: true, force: true }); });

/** 直接把一条攻击结果塞进 UI，然后把卡片渲染成 HTML。 */
function render(ev) {
  api.replaceWorld(api.emptyWorld());
  api.setUI({ trial: { event: { at: 1, ...ev } } });
  return renderToStaticMarkup(React.createElement(api.TrialEventCard));
}

const hit = {
  kind: 'hit', attackerName: '甲', attackerPcId: 'a', targetName: '乙', targetPcId: 'b',
  roll: 50, crit: false, dice: 1, damage: 3, hpBefore: 6, hpAfter: 3, hpMax: 6, downed: null, note: '', at: 1,
};

test('正常命中：卡片显示实际扣血、HP 条', () => {
  const html = render(hit);
  assert.match(html, /−3/);
  assert.match(html, /伤害/);
  assert.match(html, /6<\/b> → <b[^>]*>3<\/b>/);
});

test('打残血：卡片写实际扣了 1，不是掷出的 3（接线回归网）', () => {
  const html = render({ ...hit, damage: 3, hpBefore: 1, hpAfter: 0, downed: 'down' });
  assert.match(html, /−1/, '卡片必须写实际扣血');
  assert.doesNotMatch(html, /damage-num">−3/, '不能把掷出的伤害当扣血');
  assert.match(html, /掷出 3/);
});

test('打已经倒地的人：不显示伤害块，只说明数值没变化', () => {
  const html = render({ ...hit, hpBefore: 0, hpAfter: 0, downed: 'down', note: '这一下数值没有变化（目标已经在倒地状态，或没有可扣的血量）' });
  assert.doesNotMatch(html, /damage-num/);
  assert.match(html, /数值没有变化/);
  assert.match(html, /昏厥/);
});

test('hp0 的晕厥被打成昏厥/濒死：没有伤害块，但 tag 和原因必须在（不能被伤害块吃掉）', () => {
  const blunt = render({ ...hit, hpBefore: 0, hpAfter: 0, downed: 'down', note: '这一下没有掉血，只改了状态' });
  assert.doesNotMatch(blunt, /damage-num/);
  assert.match(blunt, /昏厥/, '钝器的昏厥 tag 必须显示');
  assert.match(blunt, /只改了状态/);

  const sharp = render({ ...hit, hpBefore: 0, hpAfter: 0, downed: 'dying', note: '这一下没有掉血，只改了状态' });
  assert.doesNotMatch(sharp, /damage-num/);
  assert.match(sharp, /濒死/, '锐器的濒死 tag 必须显示');
});

test('落空：大失败 · 落空，没有伤害块', () => {
  const html = render({ ...hit, kind: 'miss', damage: 0, hpBefore: 6, hpAfter: 6, note: '' });
  assert.match(html, /大失败 · 落空/);
  assert.doesNotMatch(html, /damage-num/);
});

test('没有血条的 NPC：没有伤害块，note 说出原因，没有倒地 tag', () => {
  const html = render({ ...hit, hpBefore: null, hpAfter: null, hpMax: null, downed: null, note: '乙 没有血条（角色卡和棋子都没填 HP）；伤害没落地' });
  assert.doesNotMatch(html, /damage-num/);
  assert.match(html, /没有血条/);
  assert.doesNotMatch(html, /昏厥|濒死/);
});
