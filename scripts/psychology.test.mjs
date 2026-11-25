import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-psychology-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/core/types'; export * from './src/core/defaults'; export * from './src/core/schema.js'; export * from './src/core/store'; export * from './src/scene/memory'; export * from './src/rules/psychology'; export * from './src/rules/actionLibrary'; export * from './src/runtime/actions'; export * from './src/runtime/hostSession'; export * from './src/runtime/trial'; export * from './src/rules/dialogue';`, resolveDir: root },
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
after(() => rm(temp, { recursive: true, force: true }));

const ATTRS = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };

function setup({ known = false, targetWeak = true, targetMe = 10, targetPc = false, targetStatus, roller } = {}) {
  const w = api.emptyWorld();
  const m = api.newMap('心理实验', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  m.fog = m.fog.map(() => 1);
  w.party = [
    { id: 'a', name: '甲', color: '#fff', tags: [], attributes: { ...ATTRS }, skills: [], me: 5, meMax: 10, hp: 20, hpMax: 20 },
    ...(targetPc ? [{ id: 'b', name: '乙', color: '#f00', tags: [], attributes: { ...ATTRS }, skills: [], me: targetMe, meMax: 10, hp: 20, hpMax: 20 }] : []),
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2, me: 5, meMax: 10 },
    { id: 'tb', pcId: targetPc ? 'b' : null, name: '乙', color: '#f00', x: 3, y: 2,
      ...(targetPc ? {} : { me: targetMe, meMax: 10 }),
      ...(targetWeak ? { weakness: { psychological: true } } : {}),
      ...(known ? { weaknessKnownBy: { a: { psychological: true } } } : {}),
      ...(targetStatus ? { status: targetStatus } : {}) },
  ];
  w.maps = [m];
  api.replaceWorld(w);
  api.setUI({ mapId: m.id });
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0, combat: false, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.say('我就要说这一句。', 'tb');
  const u = api.getWorld().utterances.at(-1);
  return { w, m, u, roll: roller ?? (() => 4) };
}

test('观察者各记各的：不知道 1D4，知道 1D8', () => {
  let s = setup({ known: false, targetMe: 10, roller: () => 4 });
  const sides = [];
  const roll4 = (n) => { sides.push(n); return 4; };
  assert.equal(api.trialPsychUtterance(s.u.id, '38', true, { roller: roll4 }), null);
  let tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.me, 6, '不知道弱点只打 1D4');
  assert.deepEqual(sides, [4], '不知道时必须真的掷 1D4，不能借 1D8 的 4 蒙混');
  assert.match(api.getWorld().events.at(-1).note, /1D4 ME/);

  s = setup({ known: true, targetMe: 10, roller: () => 8 });
  const sides8 = [];
  const roll8 = (n) => { sides8.push(n); return 8; };
  assert.equal(api.trialPsychUtterance(s.u.id, '38', true, { roller: roll8 }), null);
  assert.deepEqual(sides8, [8], '知道弱点时必须真的掷 1D8');
  tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.me, 2, '知道弱点打 1D8');
  assert.match(api.getUI().trial.msg, /已知弱点 1D8/);
  assert.match(api.getWorld().events.at(-1).note, /1D8 ME/);
});

test('反复鞭尸：没有全局一次限制，同一目标连打两次都按 1D8', () => {
  const s = setup({ known: true, targetMe: 20, roller: () => 8 });
  assert.equal(api.trialPsychUtterance(s.u.id, '38', true, { roller: () => 8 }), null);
  api.say('再来一句。', 'tb');
  const u2 = api.getWorld().utterances.at(-1);
  assert.equal(api.trialPsychUtterance(u2.id, '38', true, { roller: () => 8 }), null);
  const tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.me, 4);
});

test('目标没有心理弱点也走普通 ME 伤害 1D4，不冒充真伤', () => {
  const s = setup({ known: false, targetWeak: false, targetMe: 10, roller: () => 4 });
  assert.equal(api.trialPsychUtterance(s.u.id, '38', true, { roller: s.roll }), null);
  const tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.me, 6);
  assert.match(api.getUI().trial.msg, /普通 ME 1D4/);
  assert.doesNotMatch(api.getUI().trial.msg, /未知弱点/);
  assert.match(api.getWorld().events.at(-1).note, /普通 1D4 ME/);
});

test('心理真伤只挂在已有动作上；不新增动作库条目', () => {
  assert.ok(api.ACTION_LIBRARY.length >= 186, '动作库至少保留原 186 条；不要求永远不变');
  assert.equal(api.ACTION_LIBRARY.some((a) => a.name === '心理突防'), false);
  assert.equal(api.isPsychActionId('38'), true);
  assert.equal(api.isPsychActionId('149'), true);
  assert.equal(api.isPsychActionId('8'), false, '批评/恐吓这一包不开放');
  const s = setup();
  assert.match(api.trialPsychUtterance(s.u.id, '8', true), /嘴炮.*群嘲/);
});

test('ME 归零 → 被驱逐；回到 1 点自动解除', () => {
  const s = setup({ known: true, targetPc: true, targetMe: 5, roller: () => 8 });
  assert.equal(api.trialPsychUtterance(s.u.id, '38', true, { roller: () => 8 }), null);
  let tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(api.getWorld().party.find((p) => p.id === 'b').me, 0);
  assert.equal(tok.status.label, '被驱逐');
  assert.equal(tok.status.blocksAction, true);
  const ev = api.getWorld().events.at(-1);
  assert.ok(ev.deltas.some((d) => d.kind === 'status' && d.to === '被驱逐'), '被驱逐也要进账本');
  api.update((d) => { d.party.find((p) => p.id === 'b').me = 1; });
  tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.status, undefined, 'ME 恢复后 store 统一解除');
});

test('攻击技能也按攻击者自己的认知：别人知道不等于我知道', () => {
  const w = api.emptyWorld();
  const m = api.newMap('攻击认知', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  m.fog = m.fog.map(() => 1);
  w.party = [
    { id: 'a', name: '甲', color: '#fff', tags: [], attributes: { ...ATTRS }, skills: ['007-9-203'], me: 5, meMax: 10, hp: 20, hpMax: 20 },
    { id: 'c', name: '丙', color: '#0f0', tags: [], attributes: { ...ATTRS }, skills: ['007-9-203'], me: 5, meMax: 10, hp: 20, hpMax: 20 },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2, me: 5, meMax: 10 },
    { id: 'tc', pcId: 'c', name: '丙', color: '#0f0', x: 2, y: 3, me: 5, meMax: 10 },
    { id: 'tb', pcId: null, name: '乙', color: '#f00', x: 3, y: 2, hp: 40, hpMax: 40, me: 10, meMax: 10,
      weakness: { psychological: true }, weaknessKnownBy: { a: { psychological: true } } },
  ];
  w.maps = [m];
  api.replaceWorld(w);
  api.setUI({ mapId: m.id });
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }, { tokenId: 'tc', pcId: 'c', name: '丙' }], current: 1, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  // 丙不知道：只抽一个效果（掷 1 抽到眩晕），不降智。
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 1, skillId: '007-9-203' }), null);
  let tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.me, 10, '丙不知道，不触发降智');
  assert.equal(tok.status.label, '眩晕');

  // 换回甲（知道）：抽两个效果，眩晕 + 降智各 1，ME 掉 1。
  api.setUI({ trial: { ...api.getUI().trial, current: 0, acted: {}, turn: 2 } });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 1, skillId: '007-9-203' }), null);
  tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.me, 9, '甲知道，降智 1D6=1 落地');
  assert.equal(tok.status.label, '眩晕');
});

test('落空不扣 ME，但这句话仍然落成既有动作', () => {
  const s = setup({ known: true, targetMe: 10 });
  assert.equal(api.trialPsychUtterance(s.u.id, '149', false), null);
  const tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.me, 10);
  const u = api.getWorld().utterances.find((x) => x.id === s.u.id);
  assert.equal(u.resolution.actionId, '149');
  assert.equal(u.resolution.outcome, '落空');
});

test('旧档迁移：旧 false 不迁成有弱点；true → 有弱点 + 全队知道', () => {
  const w = api.emptyWorld();
  const m = api.newMap('旧档', '现实', 1, 10, 10, 'floor', false);
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: { ...ATTRS }, skills: [], me: 5, meMax: 10, hp: 20, hpMax: 20 }];
  m.tokens = [
    { id: 'tb', pcId: null, name: '乙', color: '#f00', x: 2, y: 2, weakness: { psychological: true } },
    { id: 'tc', pcId: null, name: '丙', color: '#0f0', x: 3, y: 2, weakness: { psychological: false } },
  ];
  w.maps = [m];
  w.version = 1;
  api.migrateWorld(w);
  const t = w.maps[0].tokens.find((x) => x.id === 'tb');
  const f = w.maps[0].tokens.find((x) => x.id === 'tc');
  assert.equal(t.weakness.psychological, true);
  assert.equal(t.weaknessKnownBy.a.psychological, true);
  assert.equal(f.weakness.psychological, false);
  assert.equal(f.weaknessKnownBy, undefined, '旧 false 只是「不知道」，不能迁成存在');
});

test('旧 v2 也迁；新 v3 的「存在但无人知道」不被迁成全队知道', () => {
  const legacy = api.emptyWorld();
  const lm = api.newMap('旧 v2', '现实', 1, 10, 10, 'floor', false);
  legacy.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: { ...ATTRS }, skills: [], me: 5, meMax: 10, hp: 20, hpMax: 20 }];
  lm.tokens = [{ id: 'tb', pcId: null, name: '乙', color: '#f00', x: 2, y: 2, weakness: { psychological: true } }];
  legacy.maps = [lm];
  legacy.version = 2;
  api.migrateWorld(legacy);
  assert.equal(legacy.version, 3);
  assert.equal(legacy.maps[0].tokens[0].weaknessKnownBy.a.psychological, true);

  const fresh = api.emptyWorld(); // version 3
  const fm = api.newMap('新 v3', '现实', 1, 10, 10, 'floor', false);
  fm.fog = fm.fog.map(() => 1);
  fm.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 1, y: 2 },
    { id: 'tb', pcId: null, name: '乙', color: '#f00', x: 2, y: 2, weakness: { psychological: true } },
  ];
  fresh.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: { ...ATTRS }, skills: [], me: 5, meMax: 10, hp: 20, hpMax: 20 }];
  fresh.maps = [fm];
  api.replaceWorld(fresh);
  const after = api.getWorld();
  assert.equal(after.version, 3);
  assert.equal(after.maps[0].tokens.find((x) => x.id === 'tb').weaknessKnownBy, undefined, '新档没有任何人知道，重载后仍无人知道');
  const pm = api.playerWorld(after, fm.id, 'a');
  assert.equal(pm.maps[0].tokens.find((x) => x.id === 'tb').weakness?.psychological, undefined, '玩家看不到未获知的心理弱点');
});

test('parseWorld 的 v3 JSON 往返不把「无人知道」迁成全队知道', () => {
  const w = api.emptyWorld();
  const m = api.newMap('往返', '现实', 1, 10, 10, 'floor', false);
  m.fog = m.fog.map(() => 1);
  m.tokens = [{ id: 'tb', pcId: null, name: '乙', color: '#f00', x: 2, y: 2, weakness: { psychological: true } }];
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: { ...ATTRS }, skills: [], me: 5, meMax: 10, hp: 20, hpMax: 20 }];
  w.maps = [m];
  const parsed = api.parseWorld(JSON.stringify(w));
  assert.equal(parsed.version, 3);
  assert.equal(parsed.maps[0].tokens[0].weaknessKnownBy, undefined);
});

test('幽灵 knownBy：没有心理弱点时不泄露，schema 拒绝', () => {
  const w = api.emptyWorld();
  const m = api.newMap('幽灵', '现实', 1, 10, 10, 'floor', false);
  m.fog = m.fog.map(() => 1);
  m.tokens = [{ id: 'tb', pcId: null, name: '乙', color: '#f00', x: 2, y: 2, weaknessKnownBy: { a: { psychological: true } } }];
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], attributes: { ...ATTRS }, skills: [], me: 5, meMax: 10, hp: 20, hpMax: 20 }];
  w.maps = [m];
  const pm = api.playerWorld(w, m.id, 'a');
  assert.equal(pm.maps[0].tokens.find((x) => x.id === 'tb').weakness?.psychological, undefined);
  assert.throws(() => api.checkWorld(w), /weaknessKnownBy/);
});

test('NPC 的 ME 归零被驱逐后，恢复到 1 点也自动解除', () => {
  const s = setup({ known: true, targetMe: 5, roller: () => 8 });
  assert.equal(api.trialPsychUtterance(s.u.id, '38', true, { roller: () => 8 }), null);
  let tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.me, 0);
  assert.equal(tok.status.label, '被驱逐');
  api.update((d) => { d.maps[0].tokens.find((x) => x.id === 'tb').me = 1; });
  tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.status, undefined);
});

test('事件账本按实际落地写：没填 ME / 已 0 ME 不冒充 1D8/1D4', () => {
  let s = setup({ known: true, targetMe: null, roller: () => 8 });
  assert.equal(api.trialPsychUtterance(s.u.id, '38', true, { roller: () => 8 }), null);
  let ev = api.getWorld().events.at(-1);
  assert.equal(ev.deltas.some((d) => d.kind === 'me'), false);
  assert.match(ev.note, /没填 ME/);

  s = setup({ known: true, targetMe: 0, roller: () => 8 });
  assert.equal(api.trialPsychUtterance(s.u.id, '38', true, { roller: () => 8 }), null);
  ev = api.getWorld().events.at(-1);
  assert.equal(ev.deltas.some((d) => d.kind === 'me'), false);
  assert.match(ev.note, /已无 ME/);
});

test('战斗里不能替非当前玩家结算心理动作', () => {
  const w = api.emptyWorld();
  const m = api.newMap('回合', '现实', 1, 10, 10, 'floor', false);
  m.fog = m.fog.map(() => 1);
  w.party = [
    { id: 'a', name: '甲', color: '#fff', tags: [], attributes: { ...ATTRS }, skills: [], me: 5, meMax: 10, hp: 20, hpMax: 20 },
    { id: 'b', name: '乙', color: '#f00', tags: [], attributes: { ...ATTRS }, skills: [], me: 5, meMax: 10, hp: 20, hpMax: 20 },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2, me: 5, meMax: 10 },
    { id: 'tb', pcId: 'b', name: '乙', color: '#f00', x: 3, y: 2, me: 5, meMax: 10 },
  ];
  w.maps = [m];
  api.replaceWorld(w);
  api.setUI({ mapId: m.id });
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '甲' }, { tokenId: 'tb', pcId: 'b', name: '乙' }], current: 0, combat: true, moved: {}, acted: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  api.say('我来试试。', 'ta', { pcId: 'b', tokenId: 'tb', mapId: m.id, name: '乙' });
  const u = api.getWorld().utterances.at(-1);
  assert.match(api.trialPsychUtterance(u.id, '38', true), /当前行动角色/);
});

test('同一句话只接一次；战斗中行动点用掉后不能再接', () => {
  const s = setup({ known: true, targetMe: 10, roller: () => 8 });
  api.setUI({ trial: { ...api.getUI().trial, combat: true } });
  assert.equal(api.trialPsychUtterance(s.u.id, '38', true, { roller: () => 8 }), null);
  assert.match(api.trialPsychUtterance(s.u.id, '38', true), /已经接过了/);
  api.say('第二句。', 'tb');
  const u2 = api.getWorld().utterances.at(-1);
  assert.match(api.trialPsychUtterance(u2.id, '149', true), /行动点已经用掉了/);
});

test('发起者被暂停时不能结算心理动作', () => {
  const s = setup({ known: true, targetMe: 10, roller: () => 8 });
  api.setUI({ trial: { ...api.getUI().trial, players: [{ ...api.getUI().trial.players[0], paused: true }] } });
  assert.match(api.trialPsychUtterance(s.u.id, '38', true), /被暂停/);
  const tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.me, 10);
  assert.equal(api.getWorld().utterances.find((x) => x.id === s.u.id).resolution ?? null, null);
});

test('目标 blocksAction 不拦嘴炮（和攻击口径一致），文档写明', () => {
  const s = setup({ known: true, targetMe: 10, targetStatus: { label: '眩晕', blocksAction: true, skipTurns: true }, roller: () => 8 });
  assert.equal(api.trialPsychUtterance(s.u.id, '38', true, { roller: () => 8 }), null);
  const tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.me, 2);
  assert.equal(tok.status.label, '眩晕');
});

test('v4 在 migrateWorld/replaceWorld 被拒绝，不静默降成 v3', () => {
  const w = api.emptyWorld(); w.version = 4;
  assert.throws(() => api.migrateWorld(w), /工程版本/);
  const w2 = api.emptyWorld(); w2.version = 4;
  assert.throws(() => api.replaceWorld(w2), /工程版本/);
});

test('schema 接受真实 v1 结构：没有 fineCells 也能给 CLI 搬运', () => {
  const w = api.emptyWorld(); w.version = 1; delete w.maps[0].fineCells;
  assert.doesNotThrow(() => api.checkWorld(w));
  assert.throws(() => { const bad = api.emptyWorld(); bad.version = 4; api.checkWorld(bad); }, /version/);
});

test('玩家载荷不泄露别人知道的心理弱点', () => {
  setup({ known: true, targetMe: 10 });
  api.update((d) => {
    d.party.push({ id: 'c', name: '丙', color: '#0f0', tags: [], attributes: { ...ATTRS }, skills: [], me: 5, meMax: 10, hp: 20, hpMax: 20 });
    const t = d.maps[0].tokens.find((x) => x.id === 'tb');
    t.weaknessKnownBy = { a: { psychological: true } };
  });
  const w = api.getWorld();
  const a = api.playerWorld(w, w.maps[0].id, 'a');
  const c = api.playerWorld(w, w.maps[0].id, 'c');
  const ta = a.maps[0].tokens.find((x) => x.id === 'tb');
  const tc = c.maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(ta.weakness.psychological, true);
  assert.equal(ta.weaknessKnownBy, undefined);
  assert.equal(tc.weakness?.psychological, undefined, '不知道的人连「有没有」都不该看到');
  assert.equal(tc.weaknessKnownBy, undefined);
});

test('schema 拒绝坏的 weaknessKnownBy', () => {
  const w = api.emptyWorld();
  const m = api.newMap('坏档', '现实', 1, 10, 10, 'floor', false);
  m.tokens = [{ id: 'tb', pcId: null, name: '乙', color: '#f00', x: 2, y: 2, weakness: { psychological: true }, weaknessKnownBy: { a: { psychological: 'yes' } } }];
  w.maps = [m];
  assert.throws(() => api.checkWorld(w), /weaknessKnownBy/);
});
