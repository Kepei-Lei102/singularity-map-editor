import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-attack-skills-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/rules/combat'; export * from './src/rules/attackSkills'; export * from './src/rules/interaction'; export * from './src/core/defaults'; export * from './src/core/schema.js'; export * from './src/runtime/trial'; export * from './src/runtime/sync'; export * from './src/core/store'; export * from './src/runtime/actions'; export * from './src/scene/architecture'; export * from './src/scene/sight';`, resolveDir: root },
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

const ATTRS = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };
const seq = (values) => () => { const v = values.shift(); assert.notEqual(v, undefined, '骰子序列用完了'); return v; };

function setup({ skills = ['007-9-004'], me = 5, target = {}, partyB = false, window = false } = {}) {
  const w = api.emptyWorld();
  const m = api.newMap('攻击技能', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  m.fog = m.fog.map(() => 1);
  w.party = [
    { id: 'a', name: '甲', color: '#fff', tags: [], attributes: { ...ATTRS }, skills, me, meMax: 10, hp: 20, hpMax: 20 },
    ...(partyB ? [{ id: 'b', name: '乙', color: '#f00', tags: [], attributes: { ...ATTRS }, skills: [], me: 5, meMax: 10, hp: 20, hpMax: 20, sharp: true }] : []),
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '甲', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: partyB ? 'b' : null, name: '乙', color: '#f00', x: 3, y: 2,
      hp: target.hp ?? 40, hpMax: target.hpMax ?? 40, ...(target.me !== undefined ? { me: target.me, meMax: target.meMax ?? target.me } : {}),
      ...(target.status ? { status: target.status } : {}), ...(target.weakness ? { weakness: target.weakness } : {}), ...(target.down ? { down: true } : {}) },
  ];
  w.maps = [m];
  api.replaceWorld(w);
  api.setUI({ mapId: m.id });
  api.startTrial();
  api.setUI({ trial: { mapId: m.id, players: partyB ? [{ tokenId: 'ta', pcId: 'a', name: '甲' }, { tokenId: 'tb', pcId: 'b', name: '乙' }] : [{ tokenId: 'ta', pcId: 'a', name: '甲' }], current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false } });
  if (window) api.openPlayerWindow('a', true);
  return { w, m };
}

test('随机效果表：不知道弱点 1 种，知道 2 种且不重复', () => {
  assert.deepEqual(api.pickRiderEffects('007-9-004', false, () => 1), ['暴击']);
  assert.deepEqual(api.pickRiderEffects('007-9-004', true, seq([1, 1])), ['暴击', '流血']);
  assert.deepEqual(api.pickRiderEffects('007-9-203', true, seq([2, 2])), ['降智', '恐惧']);
  assert.deepEqual(api.pickRiderEffects('007-9-203', false, () => 3), ['恐惧']);
  const bleed = api.riderStatus('流血');
  assert.equal(bleed.damageDie, 6);
  assert.equal(bleed.damageTarget, 'hp');
  assert.equal(bleed.blocksAction, false);
  assert.equal(api.riderStatus('恐惧').blocksAction, true);
  assert.equal(api.riderStatus('去除武器').blocksAction, false);
});

test('事件卡标签：档位颗数和额外颗数分开，不把暴击/5 倍当大成功', () => {
  assert.deepEqual(api.attackDiceLabels(1, 1), { band: null, extra: '额外 +1 颗伤害骰' });
  assert.deepEqual(api.attackDiceLabels(1, 4), { band: null, extra: '额外 +4 颗伤害骰' });
  assert.deepEqual(api.attackDiceLabels(2, 1), { band: '大成功 ×2', extra: '额外 +1 颗伤害骰' });
  assert.deepEqual(api.attackDiceLabels(4, 16), { band: '特大成功 ×4', extra: '额外 +16 颗伤害骰' });
  assert.deepEqual(api.attackDiceLabels(1, 0), { band: null, extra: null });
  // 旧事件没有 diceBase/extraDice：按总颗数兜底，不把 5 颗瞎猜成大成功。
  assert.deepEqual(api.attackDiceMeta({ dice: 2 }), { diceBase: 2, extraDice: 0, labels: { band: '大成功 ×2', extra: null } });
  assert.deepEqual(api.attackDiceMeta({ dice: 5 }), { diceBase: 5, extraDice: 0, labels: { band: null, extra: null } });
  assert.deepEqual(api.attackDiceMeta({ dice: 4 }), { diceBase: 4, extraDice: 0, labels: { band: '特大成功 ×4', extra: null } });
  assert.deepEqual(api.attackDiceMeta({ dice: 5, diceBase: 1, extraDice: 4 }), { diceBase: 1, extraDice: 4, labels: { band: null, extra: '额外 +4 颗伤害骰' } });
});

test('眩晕打击：伤害骰出 8 或已知物理弱点才触发；打眩晕的人 5 倍颗数', () => {
  assert.equal(api.passiveStunTriggers({ hit: false, damageRolls: [8], physicalWeaknessKnown: true }), false);
  assert.equal(api.passiveStunTriggers({ hit: true, damageRolls: [8] }), true);
  assert.equal(api.passiveStunTriggers({ hit: true, damageRolls: [3] }), false);
  assert.equal(api.passiveStunTriggers({ hit: true, damageRolls: [3], physicalWeaknessKnown: true }), true);
  assert.equal(api.stunnedDamageDiceMultiplier('眩晕'), 5);
  assert.equal(api.stunnedDamageDiceMultiplier('流血'), 1);
  // 5 倍是额外颗数，不改攻击档位；普通命中仍不是 crit。
  const five = api.rollAttack(6, 8, () => 1, 5);
  assert.equal(five.dice, 5);
  assert.equal(five.crit, false);
  const missFive = api.rollAttack(2, 8, () => 8, 5);
  assert.equal(missFive.dice, 0);
  assert.equal(missFive.damage, 0);
  const normal = api.rollAttack(6, 8, () => 1, 1);
  assert.equal(normal.crit, false);
  const great = api.rollAttack(95, 8, () => 1, 1);
  assert.equal(great.crit, true);
});

test('全力攻击：命中随机流血，扣 1 ME，进事件账本', () => {
  setup();
  assert.equal(api.trialAttack('tb', { roll: 50, roller: seq([4, 2]), skillId: '007-9-004' }), null);
  const w = api.getWorld();
  const tok = w.maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(w.party[0].me, 4);
  assert.deepEqual({ hp: tok.hp, hpMax: tok.hpMax }, { hp: 36, hpMax: 40 });
  assert.equal(tok.status.label, '流血');
  assert.equal(tok.status.damageDie, 6);
  const ev = w.events.at(-1);
  assert.equal(ev.action.source, '技能');
  assert.match(ev.action.name, /全力攻击/);
  assert.ok(ev.deltas.some((d) => d.kind === 'status' && d.to === '流血'));
  assert.ok(ev.deltas.some((d) => d.kind === 'me' && d.id === 'a' && d.from === 5 && d.to === 4), '发动者 ME 也要进账本');
  assert.match(ev.note, /消耗 1 ME/);
});

test('全力攻击：已知物理弱点叠两种，暴击补一颗伤害骰', () => {
  setup({ target: { weakness: { physical: true } } });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: seq([1, 1, 1, 6]), skillId: '007-9-004' }), null);
  const ev = api.getUI().trial.event;
  const tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.status.label, '流血');
  assert.equal(tok.hp, 33, '1 + 暴击补的 6');
  assert.equal(ev.damage, 7);
  assert.equal(ev.dice, 2, '普通 1 颗 + 暴击 1 颗');
  assert.equal(ev.diceBase, 1);
  assert.equal(ev.extraDice, 1);
  assert.equal(ev.crit, false, '额外颗数不等于攻击档位大成功');
  assert.match(ev.note, /暴击/);
});

test('灵巧攻击：心理弱点叠降智 + 恐惧，恐惧挡行动', () => {
  setup({ skills: ['007-9-203'], target: { weakness: { psychological: true }, me: 10 } });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: seq([2, 2, 2, 5]), skillId: '007-9-203' }), null);
  const w = api.getWorld();
  const tok = w.maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.me, 5, '降智 1D6=5');
  assert.equal(tok.status.label, '恐惧');
  assert.equal(tok.status.blocksAction, true);
  assert.equal(w.party[0].me, 4);
  const ev = w.events.at(-1);
  assert.ok(ev.deltas.some((d) => d.kind === 'me' && d.from === 10 && d.to === 5));
  assert.ok(ev.deltas.some((d) => d.kind === 'status' && d.to === '恐惧'));
});

test('眩晕打击被动：伤害骰出 8 给目标一回合眩晕', () => {
  setup({ skills: ['009-9-003'] });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 8 }), null);
  const tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.status.label, '眩晕');
  assert.equal(tok.status.skipTurns, 1);
  assert.equal(api.getWorld().party[0].me, 5, '被动不扣 ME');
});

test('眩晕打击被动：已知物理弱点且命中，伤害骰不是 8 也眩晕', () => {
  setup({ skills: ['009-9-003'], target: { weakness: { physical: true } } });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 3 }), null);
  assert.equal(api.getWorld().maps[0].tokens.find((x) => x.id === 'tb').status.label, '眩晕');
});

test('状态槽只有一个：新状态覆盖旧状态，事件记 from/to', () => {
  setup({ target: { status: { label: '中毒', perRound: 1, damageTarget: 'hp', blocksAction: false } } });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: seq([4, 2]), skillId: '007-9-004' }), null);
  const tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.status.label, '流血');
  const ev = api.getWorld().events.at(-1);
  assert.ok(ev.deltas.some((d) => d.kind === 'status' && d.from === '中毒' && d.to === '流血'));
});

test('打已经倒地的人：伤害照扣，但不再往上叠流血/眩晕', () => {
  setup({ target: { down: true, status: { label: '中毒', perRound: 1, damageTarget: 'hp', blocksAction: false } } });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: seq([3, 2]), skillId: '007-9-004' }), null);
  const tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.status.label, '中毒');
  assert.match(api.getWorld().events.at(-1).note, /已经(倒地|昏厥)/);
});

test('昏厥目标：降智的即时 ME 伤害照扣，但不往上叠状态', () => {
  setup({ skills: ['007-9-203'], target: { down: true, me: 10 } });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: seq([2, 2, 5]), skillId: '007-9-203' }), null);
  const w = api.getWorld();
  const tok = w.maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.me, 5);
  assert.equal(tok.status, undefined);
  assert.match(w.events.at(-1).note, /降智/);
});

test('昏厥目标中暴击：额外伤害照落，但流血不挂，note 要说清', () => {
  setup({ skills: ['007-9-004'], target: { down: true, weakness: { physical: true } } });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: seq([3, 1, 1, 6]), skillId: '007-9-004' }), null);
  const w = api.getWorld();
  const tok = w.maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.hp, 31, '3 + 暴击额外 6');
  assert.equal(tok.status, undefined);
  assert.match(w.events.at(-1).note, /暴击/);
  assert.match(w.events.at(-1).note, /流血没挂/);
});

test('昏厥目标：203 选中眩晕 + 009 被动眩晕，note 不重复状态名', () => {
  setup({ skills: ['007-9-203', '009-9-003'], target: { down: true, weakness: { physical: true } } });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: seq([1, 1]), skillId: '007-9-203' }), null);
  const note = api.getWorld().events.at(-1).note;
  assert.match(note, /目标已经昏厥，眩晕没挂/);
  assert.doesNotMatch(note, /眩晕、眩晕/);
});

test('锐器致死 + 暴击：暴击伤害照落，note 只说附加状态没落', () => {
  setup({ skills: ['007-9-004'], partyB: true, target: { hp: 3, hpMax: 40, weakness: { physical: true } } });
  api.update((d) => {
    d.party.find((p) => p.id === 'a').sharp = true;
    const b = d.party.find((p) => p.id === 'b');
    b.hp = 3;
    b.hpMax = 40;
  });
  assert.equal(api.trialAttack('tb', { roll: 50, sharp: true, skillId: '007-9-004', roller: seq([3, 1, 1, 6]) }), null);
  const w = api.getWorld();
  const tok = w.maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.status.label, '濒死');
  assert.match(w.events.at(-1).note, /暴击：伤害骰 \+1/);
  assert.match(w.events.at(-1).note, /附加状态没落/);
  assert.doesNotMatch(w.events.at(-1).note, /附加效果没落/);
});

test('没有血条的 NPC：伤害没落地，但技能状态照样挂', () => {
  setup({ skills: ['007-9-203'], target: { hp: 0, hpMax: 0 } });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: seq([2, 1]), skillId: '007-9-203' }), null);
  const tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.status.label, '眩晕');
  assert.match(api.getWorld().events.at(-1).note, /没有血条/);
});

test('恐惧挡行动：中了恐惧的人下一回合攻击被拒', () => {
  setup({ skills: ['007-9-203'], partyB: true });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: seq([2, 3]), skillId: '007-9-203' }), null);
  assert.equal(api.getWorld().maps[0].tokens.find((x) => x.id === 'tb').status.label, '恐惧');
  api.switchTrialPlayer(1);
  assert.match(api.trialAttack('ta', { sharp: false }) ?? '', /恐惧中/);
});

test('眩晕打击：打已经眩晕的人，伤害骰颗数 ×5', () => {
  setup({ skills: ['009-9-003'], target: { status: { label: '眩晕', skipTurns: 1, blocksAction: true }, hp: 50, hpMax: 50 } });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 8 }), null);
  const ev = api.getUI().trial.event;
  assert.equal(ev.dice, 5, '普通命中 1 颗 ×5');
  assert.equal(ev.diceBase, 1);
  assert.equal(ev.extraDice, 4);
  assert.equal(ev.damage, 40);
  assert.equal(api.getWorld().maps[0].tokens.find((x) => x.id === 'tb').hp, 10);
});

test('去除武器：1 回合内不能用锐器，钝器照打', () => {
  setup({ partyB: true });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: seq([3, 3]), skillId: '007-9-004' }), null);
  const b = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(b.status.label, '去除武器');
  assert.equal(b.status.blocksAction, false);
  api.switchTrialPlayer(1);
  assert.match(api.trialAttack('ta', { sharp: true }) ?? '', /武器被去除/);
  assert.equal(api.trialAttack('ta', { sharp: false, roll: 50, roller: () => 3 }), null);
  assert.equal(api.getWorld().party.find((x) => x.id === 'a').hp, 17);
});

test('攻击技能：落空也扣 1 ME，不挂状态；没解锁/没 ME 挡在发起前', () => {
  setup();
  assert.equal(api.trialAttack('tb', { roll: 1, skillId: '007-9-004' }), null);
  const w = api.getWorld();
  assert.equal(w.party[0].me, 4);
  assert.equal(w.maps[0].tokens.find((x) => x.id === 'tb').status, undefined);

  setup({ skills: [] });
  assert.match(api.trialAttack('tb', { roll: 50, skillId: '007-9-004' }) ?? '', /没有解锁/);
  setup({ me: 0 });
  assert.match(api.trialAttack('tb', { roll: 50, skillId: '007-9-004' }) ?? '', /ME 不够/);
  assert.match(api.trialAttack('tb', { roll: 50, skillId: '009-9-003' }) ?? '', /被动/);
});

test('降智遇到没填 ME 的目标：只写日志，不扣 ME', () => {
  setup({ skills: ['007-9-203'], target: {} });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: seq([2, 2, 2]), skillId: '007-9-203' }), null);
  const tok = api.getWorld().maps[0].tokens.find((x) => x.id === 'tb');
  assert.equal(tok.status, undefined);
  assert.match(api.getWorld().events.at(-1).note, /没填 ME/);
});

test('攻击技能：没填 ME / 技能 id 不认识都挡在发起前', () => {
  setup({ me: null });
  assert.match(api.trialAttack('tb', { roll: 50, skillId: '007-9-004' }) ?? '', /还没填 ME/);
  setup();
  assert.match(api.trialAttack('tb', { roll: 50, skillId: '999-9-999' }) ?? '', /没有这个攻击技能/);
});

test('攻击挂起：非 D100 拒绝、不落账；目标跑了则收掉挂起', () => {
  setup({ window: true, skills: ['007-9-004'] });
  assert.equal(api.trialAttack('tb', { skillId: '007-9-004' }), null);
  const bad = api.settlePendingJudgment({ rollId: 'r', sides: 4, value: 2, tens: null, units: null, material: 'wood', seed: 1 });
  assert.match(bad ?? '', /骰面或骰子数量/);
  assert.ok(api.getUI().pendingJudgment, '骰面不对时留着，让玩家用正确骰面重掷');
  assert.equal(api.getWorld().party.find((x) => x.id === 'a').me, 5);

  // value 和 values 对不上，不能按 values 过校验、再拿 value 落账。
  const badValue = api.settlePendingJudgment({ rollId: 'r', sides: 100, value: 1, values: [50], tens: 50, units: 0, material: 'wood', seed: 1 });
  assert.match(badValue ?? '', /骰面或骰子数量/);
  assert.ok(api.getUI().pendingJudgment, 'value/values 不一致时留着让玩家重掷');
  assert.equal(api.getWorld().party.find((x) => x.id === 'a').me, 5);
  assert.equal(api.getWorld().maps[0].tokens.find((x) => x.id === 'tb').hp, 40);

  // tens/units 和 value 对不上：D100 记录本身无效，不能先扣血再等 publish 报错。
  const badTens = api.settlePendingJudgment({ rollId: 'r', sides: 100, value: 50, values: [50], tens: 5, units: 0, material: 'wood', seed: 1 });
  assert.match(badTens ?? '', /百分骰结果不一致/);
  assert.ok(api.getUI().pendingJudgment, '百分位不一致时留着让玩家重掷');
  assert.equal(api.getWorld().party.find((x) => x.id === 'a').me, 5);
  assert.equal(api.getWorld().maps[0].tokens.find((x) => x.id === 'tb').hp, 40);

  // 目标移出攻击距离后，按正确 D100 结算也应当报错并收掉挂起，不能半截留账。
  api.update((d) => { const t = d.maps[0].tokens.find((x) => x.id === 'tb'); t.x = 9; t.y = 9; });
  const err = api.settlePendingJudgment({ rollId: 'r', sides: 100, value: 50, tens: 50, units: 0, material: 'wood', seed: 2 });
  assert.match(err ?? '', /攻击距离|距离|不在/);
  assert.equal(api.getUI().pendingJudgment, null);
  assert.equal(api.getWorld().party.find((x) => x.id === 'a').me, 5, '失败结算不能扣 ME');
});

test('攻击挂起绑定发起者：切到乙之后仍由甲结算，不拿乙的手和 ME', () => {
  setup({ window: true, skills: ['007-9-004'], partyB: true });
  // 乙也有同一技能，确保旧实现能“借”乙结算；再放一个 NPC 当靶子。
  api.update((d) => {
    d.party.find((p) => p.id === 'b').skills = ['007-9-004'];
    const tb = d.maps[0].tokens.find((t) => t.id === 'tb');
    d.maps[0].tokens.push({ ...tb, id: 'tn', pcId: null, name: '靶', x: 3, y: 3, hp: 40, hpMax: 40, status: undefined, weakness: undefined });
  });
  assert.equal(api.trialAttack('tn', { skillId: '007-9-004' }), null);
  assert.ok(api.getUI().pendingJudgment?.attack, '攻击判定应该挂着');
  api.switchTrialPlayer(1);
  const err = api.settlePendingJudgment({ rollId: 'switch', sides: 100, value: 50, tens: 50, units: 0, material: 'wood', seed: 3 });
  assert.equal(err, null);
  const w = api.getWorld();
  assert.equal(w.events.at(-1).actor.id, 'a', '事件必须记发起者甲');
  assert.equal(w.party.find((p) => p.id === 'a').me, 4, '扣甲的 ME');
  assert.equal(w.party.find((p) => p.id === 'b').me, 5, '乙的 ME 不动');
  assert.equal(api.getUI().trial.acted?.ta, true, '甲的 action 被用掉');
  assert.equal(api.getUI().trial.acted?.tb, undefined, '乙的 action 不动');
  assert.ok(w.maps[0].tokens.find((t) => t.id === 'tn').hp < 40, '靶子掉血');
});

test('攻击挂起：发起者眩晕/已行动时整笔收掉', () => {
  setup({ window: true, skills: ['007-9-004'] });
  assert.equal(api.trialAttack('tb', { skillId: '007-9-004' }), null);
  api.update((d) => { d.maps[0].tokens.find((t) => t.id === 'ta').status = { label: '眩晕', roundsLeft: 1, skipTurns: 1, blocksAction: true }; });
  const stun = api.settlePendingJudgment({ rollId: 'stun', sides: 100, value: 50, tens: 50, units: 0, material: 'wood', seed: 5 });
  assert.match(stun ?? '', /眩晕/);
  assert.equal(api.getUI().pendingJudgment, null);
  assert.equal(api.getWorld().party.find((p) => p.id === 'a').me, 5);
  assert.equal(api.getWorld().maps[0].tokens.find((t) => t.id === 'tb').hp, 40);

  setup({ window: true, skills: ['007-9-004'] });
  assert.equal(api.trialAttack('tb', { skillId: '007-9-004' }), null);
  api.setUI({ trial: { ...api.getUI().trial, acted: { ta: true } } });
  const acted = api.settlePendingJudgment({ rollId: 'acted', sides: 100, value: 50, tens: 50, units: 0, material: 'wood', seed: 6 });
  assert.match(acted ?? '', /行动点/);
  assert.equal(api.getUI().pendingJudgment, null);
  assert.equal(api.getWorld().party.find((p) => p.id === 'a').me, 5);
  assert.equal(api.getWorld().maps[0].tokens.find((t) => t.id === 'tb').hp, 40);
});

test('攻击挂起：结算后广播失败也收掉 pending，不留可重复结算', () => {
  setup({ window: true, skills: ['007-9-004'] });
  assert.equal(api.trialAttack('tb', { skillId: '007-9-004' }), null);
  const p = api.getUI().pendingJudgment;
  // 模拟广播前定时/标题被清掉这种边界：攻击已经落地，publish 会失败。
  api.setUI({ pendingJudgment: { ...p, title: '' } });
  const err = api.settlePendingJudgment({ rollId: 'broadcast-fail', sides: 100, value: 50, tens: 50, units: 0, material: 'wood', seed: 7 });
  assert.match(err ?? '', /广播失败/);
  assert.equal(api.getUI().pendingJudgment, null, '广播失败后不能再留一笔可重复结算的挂起');
  const w = api.getWorld();
  assert.equal(w.party.find((x) => x.id === 'a').me, 4);
  assert.ok(w.maps[0].tokens.find((x) => x.id === 'tb').hp < 40);
  assert.equal(w.events.length, 1);
});

test('攻击挂起：重复 rollId 在落地前拒绝，不改世界', () => {
  setup({ window: true, skills: ['007-9-004'] });
  assert.equal(api.trialAttack('tb', { skillId: '007-9-004' }), null);
  api.update((d) => {
    d.judgments = [{
      id: 'old', title: '旧判定', ruling: '', recipients: [], subjectId: 'a', place: null, at: 1,
      roll: { id: 'dup', sides: 100, value: 50, tens: 50, units: 0, material: 'wood', persona: 'player', seed: 1 },
    }];
  });
  const err = api.settlePendingJudgment({ rollId: 'dup', sides: 100, value: 50, tens: 50, units: 0, material: 'wood', seed: 2 });
  assert.match(err ?? '', /已经发布过/);
  assert.ok(api.getUI().pendingJudgment, '重复这颗先别把 pending 收掉，让玩家换一颗');
  assert.equal(api.getWorld().party.find((x) => x.id === 'a').me, 5);
  assert.equal(api.getWorld().maps[0].tokens.find((x) => x.id === 'tb').hp, 40);
  assert.equal((api.getWorld().events ?? []).length, 0);
  assert.equal((api.getWorld().judgments ?? []).length, 1);
});

test('攻击挂起：判定角色从 party 消失时收掉挂起，不落账', () => {
  setup({ window: true, skills: ['007-9-004'] });
  assert.equal(api.trialAttack('tb', { skillId: '007-9-004' }), null);
  api.update((d) => { d.party = []; });
  const err = api.settlePendingJudgment({ rollId: 'gone', sides: 100, value: 50, tens: 50, units: 0, material: 'wood', seed: 8 });
  assert.match(err ?? '', /角色已经不在了/);
  assert.equal(api.getUI().pendingJudgment, null);
  assert.equal((api.getWorld().events ?? []).length, 0);
  assert.equal(api.getWorld().maps[0].tokens.find((x) => x.id === 'tb').hp, 40);
});

test('攻击挂起：发起者结束回合后不再结算，整笔收掉', () => {
  setup({ window: true, skills: ['007-9-004'] });
  assert.equal(api.trialAttack('tb', { skillId: '007-9-004' }), null);
  api.setUI({ trial: { ...api.getUI().trial, ended: { ta: true } } });
  const err = api.settlePendingJudgment({ rollId: 'ended', sides: 100, value: 50, tens: 50, units: 0, material: 'wood', seed: 4 });
  assert.match(err ?? '', /结束了/);
  assert.equal(api.getUI().pendingJudgment, null);
  assert.equal(api.getWorld().party.find((p) => p.id === 'a').me, 5);
  assert.equal(api.getWorld().maps[0].tokens.find((x) => x.id === 'tb').hp, 40);
});

test('挂起攻击判定带上技能，结算前不扣 ME', () => {
  setup({ window: true });
  assert.equal(api.trialAttack('tb', { skillId: '007-9-004' }), null);
  const p = api.getUI().pendingJudgment;
  assert.equal(p.attack.skillId, '007-9-004');
  assert.equal(api.getWorld().party[0].me, 5);
  api.cancelPendingJudgment();
});
