import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-dialogue-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/rules/dialogue'; export * from './src/rules/combat'; export * from './src/core/defaults'; export * from './src/core/schema.js'; export * from './src/runtime/trial'; export * from './src/core/store'; export * from './src/runtime/actions'; export * from './src/runtime/sync';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.location = { search: '', origin: 'http://localhost' };
globalThis.window = { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, open: () => ({ closed: false, postMessage() {} }) };
globalThis.document = { addEventListener() {}, removeEventListener() {} };
globalThis.BroadcastChannel = class { postMessage() {} };
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
const api = createRequire(import.meta.url)(bundle);
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

/** 搭一个最小的试玩现场：两个活人 + 一个 NPC。 */
function scene() {
  const w = api.emptyWorld();
  const m = api.newMap('书房', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  m.fog = m.fog.map(() => 1);
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [
    { id: 'a', name: '阿甲', color: '#fff', tags: [], attributes: attrs },
    { id: 'b', name: '阿乙', color: '#0f0', tags: [], attributes: attrs },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '阿甲', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '阿乙', color: '#0f0', x: 3, y: 2 },
    { id: 'npc', name: '看门人', color: '#c33', x: 4, y: 2 },
  ];
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '阿甲' }], current: 0, combat: false, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  return m;
}

test('玩家说什么就记什么，一个字都不改', () => {
  scene();
  assert.equal(api.say('  我要去跟那傻子评评理  '), null);
  const all = api.getWorld().utterances;
  assert.equal(all.length, 1);
  assert.equal(all[0].text, '我要去跟那傻子评评理', '首尾空白去掉，中间的保持不变');
  assert.equal(all[0].pcName, '阿甲');
  assert.equal(all[0].resolution, null, '刚说完还没接住');
});

test('空话和超长话都不收，死了也说不出来', () => {
  const m = scene();
  assert.match(api.say('   ') ?? '', /说点什么/);
  assert.match(api.say('啊'.repeat(api.UTTERANCE_MAX + 1)) ?? '', /最多/);
  // 死了就不许说话
  api.update((d) => { d.maps[0].tokens.find((t) => t.id === 'ta').corpse = true; });
  assert.match(api.say('我还活着') ?? '', /死了/);
});

test('非试玩状态不收话', () => {
  scene();
  api.setUI({ trial: null });
  assert.match(api.say('喂') ?? '', /试玩/);
});

test('见证者把一句话接成动作：不强制掷骰', () => {
  scene();
  api.say('我要去跟那傻子评评理');
  const id = api.pendingUtterances()[0].id;
  assert.equal(api.resolveUtterance(id, { label: '和看门人理论', outcome: '看门人让步，让开了门' }), null);
  const u = api.getWorld().utterances.find((x) => x.id === id);
  assert.equal(u.resolution.label, '和看门人理论');
  assert.equal(u.resolution.roll, null, '对话的效果按内容直接判，不需要骰子');
  assert.equal(u.resolution.by, 'witness');
  assert.equal(api.pendingUtterances().length, 0, '接住之后就不在待办里了');
});

test('同一句话不能接两次；没写动作名不收', () => {
  scene();
  api.say('帮我把门推开');
  const id = api.pendingUtterances()[0].id;
  assert.match(api.resolveUtterance(id, { label: '  ' }) ?? '', /什么动作/);
  assert.equal(api.resolveUtterance(id, { label: '推门' }), null);
  assert.match(api.resolveUtterance(id, { label: '再推一次' }) ?? '', /接过/);
  assert.match(api.resolveUtterance('不存在', { label: 'x' }) ?? '', /找不到/);
});

test('玩家只看到自己说的、对全场的、和指名对自己说的', () => {
  scene();
  api.say('大家好');                 // 没指名 → 全场都能看到
  api.say('悄悄话给阿乙', 'tb');      // 指名阿乙
  api.say('对着看门人喊', 'npc');     // 指名 NPC，同队的人不该看到
  const forA = api.utterancesFor('a');
  const forB = api.utterancesFor('b');
  assert.equal(forA.length, 3, '阿甲自己说的三句都看得到');
  assert.equal(forB.length, 2, '阿乙看得到对全场的那句，和被指名给他的那句');
  assert.ok(forB.some((u) => u.text === '悄悄话给阿乙'));
  assert.ok(!forB.some((u) => u.text === '对着看门人喊'), '指名说给别人的话不该漏过来');
});

test('能说给谁：同图活人，不含死人', () => {
  const m = scene();
  assert.deepEqual(api.speakTargets().map((x) => x.name), ['阿甲', '阿乙', '看门人']);
  api.update((d) => { d.maps[0].tokens.find((t) => t.id === 'tb').corpse = true; });
  assert.ok(!api.speakTargets().some((x) => x.name === '阿乙'), '尸体不在说话对象里');
});

test('NPC 被挪走之后：在视野里的人看得见，看不见的人看不到', async () => {
  // 这条测的是 playerWorld 的裁剪：移动之后棋子会不会漏给看不见的人
  const w = api.emptyWorld();
  const m = api.newMap('走廊', '现实', 1, 20, 10, 'floor', false);
  m.objects = [];
  const attrs = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
  w.party = [
    { id: 'a', name: '近的人', color: '#fff', tags: [], attributes: attrs },
    { id: 'b', name: '远的人', color: '#0f0', tags: [], attributes: attrs },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '近的人', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '远的人', color: '#0f0', x: 18, y: 8 },
    { id: 'npc', name: '活板门守卫', color: '#c33', x: 3, y: 2 },
  ];
  // 各自独立视野
  w.visionMode = 'individual';
  m.fog = m.fog.map(() => 0);
  w.maps = [m];
  api.replaceWorld(w);
  // 守卫挪到 4,2（主持人把棋子拖过去）
  assert.equal(api.moveMapToken(m.id, 'npc', { x: 4, y: 2 }), null);
  // 视野层必须在移动之后再写：moveMapToken 会重算视野，
  // 先写会被覆盖掉。真实场景里也是「人走过去了，视野才更新」。
  api.update((d) => {
    const dm = d.maps[0];
    const blank = dm.fog.map(() => 0);
    dm.views = {
      a: { fog: dm.fog.map((_, i) => (i % dm.width) <= 5 && Math.floor(i / dm.width) <= 4 ? 1 : 0), seen: { cells: blank.slice(), objects: [] } },
      b: { fog: blank.slice(), seen: { cells: blank.slice(), objects: [] } },
    };
  });

  const near = api.playerWorld(api.getWorld(), m.id, 'a');
  const far = api.playerWorld(api.getWorld(), m.id, 'b');
  assert.ok(near.maps[0].tokens.some((t) => t.id === 'npc'), '近的人看得见挪动后的守卫');
  assert.ok(!far.maps[0].tokens.some((t) => t.id === 'npc'), '远的人在视野外，不该看到守卫');
});
