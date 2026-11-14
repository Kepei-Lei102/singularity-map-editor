// 事件账本：攻击落成一条 PhysicalEvent，句子由事件渲染；以及账本进存档校验、回合重置的边界。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-events-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: {
    contents: `export * from './src/rules/events';
export * from './src/rules/combat';
export * from './src/rules/interaction';
export * from './src/core/defaults';
export * from './src/core/schema.js';
export * from './src/runtime/trial';
export * from './src/runtime/sync';
export * from './src/core/store';
export * from './src/runtime/actions';
export * from './src/scene/architecture';
export * from './src/scene/sight';`,
    resolveDir: root,
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.location = { search: '', origin: 'http://localhost' };
const windows = [];
globalThis.window = {
  setTimeout: () => 0,
  open: () => {
    const w = { closed: false, got: [], postMessage(m) { this.got.push(m); } };
    windows.push(w);
    return w;
  },
};
globalThis.BroadcastChannel = class { postMessage() {} };
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
const api = createRequire(import.meta.url)(bundle);
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

const ATTRS = { 力量: 30, 敏捷: 30, 意志: 30, 观察: 30, 智慧: 30, 魅力: 30 };

/** 一张 10×10 的战斗图：攻击者 ta（pc a），目标 tb（pc b）。 */
function fight(opts = {}) {
  const w = api.emptyWorld();
  const m = api.newMap('战斗', '现实', 1, 10, 10, 'floor', false);
  m.objects = [];
  w.party = [
    { id: 'a', name: '攻击者', color: '#fff', tags: [], attributes: ATTRS },
    { id: 'b', name: '目标', color: '#f00', tags: [], attributes: ATTRS, ...(opts.targetHp !== undefined ? { hp: opts.targetHp } : {}) },
  ];
  m.tokens = [
    { id: 'ta', pcId: 'a', name: '攻击者', color: '#fff', x: 2, y: 2 },
    { id: 'tb', pcId: 'b', name: '目标', color: '#f00', x: 4, y: 2, ...(opts.targetToken ?? {}) },
  ];
  m.fog = m.fog.map(() => 1);
  w.maps = [m];
  api.replaceWorld(w);
  api.startTrial();
  api.setUI({ trial: {
    mapId: m.id, players: [{ tokenId: 'ta', pcId: 'a', name: '攻击者' }, { tokenId: 'tb', pcId: 'b', name: '目标' }],
    current: 0, combat: true, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false,
  } });
  return { w, m };
}

test('落空不写假账：伤害 0 就不该有「HP 从 6 改为 6」', () => {
  const { m } = fight();
  assert.equal(api.trialAttack('tb', { roll: 3, roller: () => 3 }), null);
  const w = api.getWorld();
  const ev = w.events.at(-1);
  assert.equal(ev.check.outcome, '落空');
  assert.equal(ev.check.success, false);
  assert.deepEqual(ev.deltas, [], '落空不该有状态变化');
  assert.equal(ev.check.rolledBy, 'host', 'NPC/主机现掷的要记成 host');
  assert.match(w.log.at(-1).text, /落空/);
  assert.doesNotMatch(w.log.at(-1).text, /改为/);
  assert.equal(api.findMap(w, m.id).tokens.find((t) => t.id === 'tb').hp, undefined);
});

test('打已经昏厥的目标：不写「状态从 昏厥 改为 昏厥」', () => {
  fight({ targetToken: { down: true }, targetHp: 0 });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 3 }), null);
  const w = api.getWorld();
  const ev = w.events.at(-1);
  assert.equal(ev.check.success, true);
  assert.deepEqual(ev.deltas, []);
  assert.match(ev.note ?? '', /数值没有变化/);
});

test('带非濒死状态被打到 0：status.from 是原来的状态名，不是 null', () => {
  fight({ targetHp: 2, targetToken: { status: { label: '晕厥', roundsLeft: 2 } } });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 3 }), null);
  const ev = api.getWorld().events.at(-1);
  const st = ev.deltas.find((d) => d.kind === 'status');
  assert.equal(st.from, '晕厥');
  assert.equal(st.to, '昏厥');
  // 状态改的是棋子，id 必须是 tokenId，不能拿 pcId 顶替
  assert.equal(st.id, 'tb');
});

test('没有血条的目标：伤害没落地这件事要进账本', () => {
  const { m } = fight();
  // 角色卡没填 HP 时 hpOf 会按公式算出来，所以「没有血条」只有 NPC 棋子才成立：
  // 把目标改成没有 pcId、也没有 hp/hpMax 的棋子。
  api.update((d) => {
    const t = api.findMap(d, m.id).tokens.find((x) => x.id === 'tb');
    delete t.pcId; delete t.hp; delete t.hpMax;
  });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 3 }), null);
  const ev = api.getWorld().events.at(-1);
  assert.deepEqual(ev.deltas, []);
  assert.match(ev.note ?? '', /没有血条/);
});

test('已昏厥且身上还挂着别的状态：状态被抹掉要入账', () => {
  fight({ targetHp: 2, targetToken: { down: true, status: { label: '中毒', roundsLeft: 3 } } });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 3 }), null);
  const st = api.getWorld().events.at(-1).deltas.find((d) => d.kind === 'status');
  assert.ok(st, 'status 被 delete 了就必须有 delta');
  assert.equal(st.from, '中毒');
  // 受击前就已经是 down（昏厥），这一步实际是「中毒被清掉」，不是「变成昏厥」
  assert.equal(st.to, null);
});

test('落空不许动状态：已昏厥且挂着中毒的目标挨空刀后状态还在', () => {
  const { m } = fight({ targetHp: 0, targetToken: { down: true, status: { label: '中毒', roundsLeft: 3 } } });
  assert.equal(api.trialAttack('tb', { roll: 3, roller: () => 3 }), null);
  const ev = api.getWorld().events.at(-1);
  assert.deepEqual(ev.deltas, [], '落空就不该有状态变化');
  const tok = api.findMap(api.getWorld(), m.id).tokens.find((t) => t.id === 'tb');
  assert.equal(tok.status?.label, '中毒', '落空不能把状态抹掉');
});

test('declareText：有属性但没 DC 时不渲染 undefined', () => {
  const text = api.eventText({ id: 'x', at: 0, session: 0,
    actor: { kind: 'pc', id: 'a', name: '甲' }, action: { name: '撬锁', source: '动作库' },
    check: { scale: 'd20', attrs: [{ attr: '敏捷', dice: 'single', value: 6 }], merge: 'single', total: 18, success: true, tier: null },
    deltas: [],
  });
  assert.doesNotMatch(text, /undefined|null/);
  assert.match(text, /敏捷/);
});

test('落空打没有血条的目标：不该说「伤害没落地」', () => {
  const { m } = fight();
  api.update((d) => {
    const t = api.findMap(d, m.id).tokens.find((x) => x.id === 'tb');
    delete t.pcId; delete t.hp; delete t.hpMax;
  });
  assert.equal(api.trialAttack('tb', { roll: 3, roller: () => 3 }), null);
  const ev = api.getWorld().events.at(-1);
  assert.deepEqual(ev.deltas, []);
  assert.equal(ev.note, undefined, '落空时本来就没伤害，别把原因归成没血条');
  assert.equal(ev.check.outcome, '落空');
});

test('攻击事件的 check 用的是 kind/band，不再拿 dc:0 当哨兵', () => {
  fight();
  api.settleAttack('tb', 50, { roller: () => 3, rolledBy: 'player' });
  const c = api.getWorld().events.at(-1).check;
  assert.equal(c.kind, 'attack');
  assert.equal(c.band, 'hit');
  assert.equal(c.dc, undefined);
  assert.equal(c.rolledBy, 'player');
  assert.equal(c.outcome, '命中');
});

test('卡片口径：没真扣到血就不算「伤害落地」，别显示 −N', () => {
  // 正常命中掉血
  fight();
  api.trialAttack('tb', { roll: 50, roller: () => 3 });
  assert.equal(api.damageLanded(api.getUI().trial.event), true);

  // 落空：伤害 0
  fight();
  api.trialAttack('tb', { roll: 3, roller: () => 3 });
  assert.equal(api.damageLanded(api.getUI().trial.event), false);

  // 打已经昏厥、hp 已 0 的人：0 → 0
  fight({ targetHp: 0, targetToken: { down: true } });
  api.trialAttack('tb', { roll: 50, roller: () => 3 });
  assert.equal(api.damageLanded(api.getUI().trial.event), false);

  // 打没血条的 NPC：hpBefore/hpAfter 都是 null
  const { m } = fight();
  api.update((d) => {
    const t = api.findMap(d, m.id).tokens.find((x) => x.id === 'tb');
    delete t.pcId; delete t.hp; delete t.hpMax;
  });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 3 }), null);
  assert.equal(api.damageLanded(api.getUI().trial.event), false);
});

test('damageLost 报实际扣血；命中却没掉血、只改状态时 note 要说清楚', () => {
  assert.equal(api.damageLost({ hpBefore: 1, hpAfter: 0 }), 1);
  assert.equal(api.damageLost({ hpBefore: 6, hpAfter: 3 }), 3);
  assert.equal(api.damageLost({ hpBefore: 6, hpAfter: 6 }), 0);
  assert.equal(api.damageLost({ hpBefore: null, hpAfter: null }), 0);
  // 半空/反向：别让 `null - null = 0` 这种巧合蒙过去
  assert.equal(api.damageLost({ hpBefore: 5, hpAfter: null }), 0);
  assert.equal(api.damageLost({ hpBefore: null, hpAfter: 5 }), 0);
  assert.equal(api.damageLost({ hpBefore: 3, hpAfter: 5 }), 0, '血变多不算扣血');

  // 真实攻击：hp 1 挨 3 点伤害，实际只扣 1
  fight({ targetHp: 1 });
  api.trialAttack('tb', { roll: 50, roller: () => 3 });
  const ev = api.getUI().trial.event;
  assert.equal(api.damageLost(ev), 1, '卡片要写 −1，不是 −3');

  // hp0 + 未倒地 + 挂晕厥：只改状态，卡片得说出「没有掉血」
  fight({ targetHp: 0, targetToken: { status: { label: '晕厥', roundsLeft: 2 } } });
  api.trialAttack('tb', { roll: 50, roller: () => 3 });
  const ev2 = api.getUI().trial.event;
  assert.equal(api.damageLanded(ev2), false);
  assert.match(ev2.note ?? '', /只改了状态/);
});

test('锐器是「这一击的选择」：打完自动回钝器，勾了没用掉也会在结束回合时清掉', () => {
  fight();
  api.update((d) => { d.party.find((p) => p.id === 'a').sharp = true; }); // 角色卡上带着锐器
  api.setUI({ trial: { ...api.getUI().trial, sharpAttack: { ta: true } } });
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 3, sharp: true }), null);
  assert.equal(api.getWorld().events.at(-1).action.name, '攻击（锐器）');
  assert.ok(!api.getUI().trial.sharpAttack.ta, '这一击打完就该回钝器');
  // 下一回合不勾：走钝器
  api.trialEndTurn();
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 3 }), null);
  assert.equal(api.getWorld().events.at(-1).action.name, '攻击（钝器）');
  // 勾了但没打：结束回合清掉
  api.setUI({ trial: { ...api.getUI().trial, sharpAttack: { ta: true } } });
  api.trialEndTurn();
  assert.ok(!api.getUI().trial.sharpAttack.ta);
});

test('进出战斗要重算点池：上一场的 300 点不能带进新一场', () => {
  fight();
  api.setUI({ trial: { ...api.getUI().trial, movePoints: { ta: 300 }, charge: { ta: { progress: 1, cells: 1 } } } });
  api.toggleCombat(); // 退出战斗
  api.toggleCombat(); // 再进战斗
  assert.deepEqual(api.getUI().trial.movePoints, {});
  assert.deepEqual(api.getUI().trial.charge, {});
});

test('真实路径：A 攻击后切到 B，B 的行动点是满的', () => {
  fight();
  assert.equal(api.trialAttack('tb', { roll: 50, roller: () => 3 }), null);
  assert.equal(api.actionsLeft(api.getUI().trial), 0);
  api.switchTrialPlayer(1); // 轮到目标那个角色
  assert.equal(api.getUI().trial.current, 1);
  assert.equal(api.actionsLeft(api.getUI().trial), 1);
});

test('存档校验：判定锚点不能落在图外（x==width 也不行，跟发布口一致）', () => {
  const w = api.emptyWorld();
  const m = w.maps[0];
  const judgment = (x, y) => ({
    id: 'j1', title: '判定', ruling: '', recipients: [], at: 1, session: 0,
    place: { mapId: m.id, x, y },
    roll: { id: 'r1', sides: 20, value: 10, material: 'wood', persona: 'witness', seed: 1 },
  });
  const withPlace = (x, y) => { const c = JSON.parse(JSON.stringify(w)); c.judgments = [judgment(x, y)]; return c; };
  api.checkWorld(withPlace(23.5, 2));
  assert.throws(() => api.checkWorld(withPlace(m.width, 2)), /判定位置超出地图/);
  assert.throws(() => api.checkWorld(withPlace(2, m.height)), /判定位置超出地图/);
});

test('autoReveal 按棋子建视野表：同一角色两个棋子姿态不同，不能用第一个的眼高去判第二个', () => {
  const w = api.emptyWorld();
  const m = api.newMap('多棋子', '测试', 0, 10, 6, 'floor', false);
  m.fog = m.fog.map(() => 1);
  m.objects = [
    // 矮墙：站着（眼高约 1.61）折算成本能越过，趴下（0.3）直接挡死——刚好能区分两份表
    { ...api.newObject('object', 3, 2, 2, 1), id: 'wall', name: '矮墙', height: 1 },
    // 线索本身不能高：物件高度 ≥ 眼高会把自己那格算成全挡，站着也看不见
    { ...api.newObject('object', 6, 2, 1, 1), id: 'target', name: '线索', height: 0,
      secrets: [{ id: 's', label: '线索', kind: 'auto', range: 10, check: '', tiers: { crit: '', success: '', fail: '', fumble: '' } }] },
  ];
  w.party = [{ id: 'a', name: '甲', color: '#fff', tags: [], sex: '男' }];
  // 趴着的棋子排在前面：以前 cache 按 pcId 取第一个，就会拿趴姿的眼高去判站姿的棋子
  m.tokens = [
    // 朝向必须给：没 facing 的棋子落在默认锥形外，跟姿态无关，测不出想测的东西
    { id: 't1', pcId: 'a', name: '甲（趴）', color: '#fff', x: 2, y: 2, stance: '趴', facing: '东' },
    { id: 't2', pcId: 'a', name: '甲（站）', color: '#fff', x: 2, y: 2, stance: '站', facing: '东' },
  ];
  w.maps = [m];
  api.replaceWorld(w);
  api.setUI({ mode: 'run', mapId: m.id });
  api.autoReveal(m.id);
  const target = api.getWorld().maps[0].objects.find((o) => o.id === 'target');
  assert.ok(target.secrets[0].discoveries?.a, '站姿棋子看得见，线索应当浮现');
});

test('存档校验：真事件能过校验；events 不是数组/超 200 条要报错，导入时裁到 200', () => {
  fight();
  api.trialAttack('tb', { roll: 50, roller: () => 3 }); // 先落一条真事件
  const w = api.getWorld();
  api.checkWorld(w); // 真事件必须能过校验
  const bad = JSON.parse(JSON.stringify(w));
  bad.events = 'x';
  assert.throws(() => api.checkWorld(bad), /events/);

  const many = JSON.parse(JSON.stringify(w));
  many.events = Array.from({ length: 205 }, (_, i) => ({
    id: `e${i}`, at: i, session: 0,
    actor: { kind: 'pc', id: 'a', name: '攻击者' },
    action: { name: '攻击', source: '临场' },
    deltas: [],
  }));
  assert.throws(() => api.checkWorld(many), /200/);

  const fixed = api.repairWorld(many);
  assert.match(fixed.join('；'), /200/);
  assert.equal(many.events.length, 200);
  assert.equal(many.events[0].id, 'e5');

  // 形状不对的条目要在 repair 阶段就被丢掉（跟 checkWorld 同一张单子）
  const partial = JSON.parse(JSON.stringify(w));
  partial.events = [
    partial.events[partial.events.length - 1],
    { id: 'broken', actor: { kind: 'pc', id: 'a', name: 'x' }, action: { name: '攻击', source: '临场' }, deltas: [] },
  ];
  const fixed2 = api.repairWorld(partial);
  assert.match(fixed2.join('；'), /形状不对/);
  assert.equal(partial.events.length, 1);
  assert.equal(partial.events[0].id, w.events.at(-1).id);
});

test('存档校验：check.attrs 的逐项成败/极值也要校验，坏条目导入时丢掉', () => {
  const w = api.emptyWorld();
  w.events = [api.newEvent(w, 1, { kind: 'pc', id: 'a', name: '甲' }, { name: '观察', source: '动作库' }, {
    check: {
      kind: 'check', scale: 'd20', merge: 'single', dc: 20, success: true, tier: null,
      attrs: [{ attr: '观察', dice: 'single', roll: 15, used: 15, value: 6, total: 21, success: true, tier: null }],
    },
    deltas: [],
  })];
  api.checkWorld(w);

  const badSuccess = JSON.parse(JSON.stringify(w));
  badSuccess.events[0].check.attrs[0].success = 'yes';
  assert.throws(() => api.checkWorld(badSuccess), /attrs\[0\]/);
  const fixed = api.repairWorld(badSuccess);
  assert.match(fixed.join('；'), /形状不对/);
  assert.equal(badSuccess.events.length, 0);

  const badTier = JSON.parse(JSON.stringify(w));
  badTier.events[0].check.attrs[0].tier = 'great';
  assert.throws(() => api.checkWorld(badTier), /attrs\[0\]/);
  assert.equal(api.repairWorld(badTier).some((x) => /形状不对/.test(x)), true);
});

test('移动落一条事件：只记 moved，转身和确认不记账', () => {
  const { m } = fight();
  api.toggleCombat(); // 自由行动
  const token = () => api.findMap(api.getWorld(), m.id).tokens.find((t) => t.id === 'ta');
  const before = token();
  const count = api.getWorld().events?.length ?? 0;

  api.trialMove(0, -1); // 只转身
  assert.equal(api.getWorld().events?.length ?? 0, count, '转身不落事件');
  assert.deepEqual([token().x, token().y], [before.x, before.y]);

  api.trialMove(0, -1); // 走
  const ev = api.getWorld().events.at(-1);
  assert.equal(ev.action.name, '移动');
  assert.equal(ev.target, undefined);
  assert.equal(ev.check, undefined);
  assert.deepEqual(ev.deltas, [{
    kind: 'moved', id: 'a', name: '攻击者',
    from: { x: before.x, y: before.y }, to: { x: before.x, y: before.y - 1 },
  }]);
  assert.match(api.getWorld().log.at(-1).text, /【移动】/);
  assert.doesNotMatch(api.getWorld().log.at(-1).text, /改为/);
});

test('推家具落一条「推」事件：目标物件位置 + 自己 moved', () => {
  const { m } = fight();
  api.toggleCombat();
  api.update((d) => {
    d.maps[0].objects = [{
      ...api.newObject('object', 2, 1, 1, 1), id: 'shelf', name: '书架',
      states: ['放着'], state: 0, height: 2, pushable: true, heavy: false, secrets: [],
    }];
  });

  api.trialMove(0, -1); // 转身
  api.trialMove(0, -1); // 推一格并走进去
  const ev = api.getWorld().events.at(-1);
  assert.equal(ev.action.name, '推');
  assert.deepEqual(ev.target, { kind: 'object', id: 'shelf', name: '书架' });
  assert.equal(ev.deltas.length, 2);
  assert.equal(ev.deltas[0].kind, 'moved');
  assert.deepEqual([ev.deltas[0].from, ev.deltas[0].to], [{ x: 2, y: 2 }, { x: 2, y: 1 }]);
  assert.deepEqual(ev.deltas[1], {
    kind: 'object', id: 'shelf', name: '书架', path: '位置',
    from: '(2, 1)', to: '(2, 0)',
  });
  assert.match(api.getWorld().log.at(-1).text, /【推】/);
});

test('感知落一条事件：记属性骰和候选 note，不改世界', () => {
  const { m } = fight();
  api.toggleCombat();
  api.update((d) => {
    d.maps[0].objects = [{
      ...api.newObject('object', 2, 3, 1, 1), id: 'clock', name: '钟',
      states: ['正常'], state: 0, height: 0.2, secrets: [{
        id: 's1', label: '刻痕', check: '观察', kind: 'roll', range: 2,
        tiers: { crit: '钟面有刻痕', success: '钟面有刻痕', fail: '', fumble: '' },
      }],
    }];
  });

  assert.equal(api.trialSense('observe', { targetObjectId: 'clock', roll: () => 20 }), null);
  const ev = api.getWorld().events.at(-1);
  assert.equal(ev.action.name, '观察');
  assert.deepEqual(ev.target, { kind: 'object', id: 'clock', name: '钟' });
  assert.equal(ev.check.success, true);
  assert.equal(ev.check.tier, 'crit');
  assert.equal(ev.check.attrs[0].attr, '观察');
  assert.equal(ev.check.attrs[0].roll, 20);
  assert.deepEqual(ev.deltas, [], '感知不改世界');
  assert.match(ev.note, /候选 1 条/);
  assert.match(api.getWorld().log.at(-1).text, /【观察】/);
});

test('战斗中移动：moved 之外，移动点变化也入账', () => {
  const { m } = fight(); // 战斗模式
  api.trialMove(0, -1); // 转身
  api.trialMove(0, -1); // 走一格
  const ev = api.getWorld().events.at(-1);
  assert.equal(ev.action.name, '移动');
  const moved = ev.deltas.find((d) => d.kind === 'moved');
  const points = ev.deltas.find((d) => d.kind === 'points');
  assert.ok(moved, '必须有 moved');
  assert.ok(points, '战斗里走一格要记移动点');
  assert.equal(points.pool, 'move');
  assert.equal(points.id, 'a');
  assert.ok(points.from > points.to, `点池应该变少：${points.from} → ${points.to}`);
  assert.deepEqual([api.findMap(api.getWorld(), m.id).tokens.find((t) => t.id === 'ta').x,
    api.findMap(api.getWorld(), m.id).tokens.find((t) => t.id === 'ta').y], [2, 1]);
});

test('推家具：后面攀爬检查失败，不该先挪家具、也不该落账', () => {
  const { m } = fight();
  api.toggleCombat();
  api.update((d) => {
    const map = d.maps[0];
    map.heights = new Array(map.width * map.height).fill(0);
    map.heights[1 * map.width + 2] = 2; // 书架脚下那格比人高 2 格：推过去要攀
    map.objects = [{
      ...api.newObject('object', 2, 1, 1, 1), id: 'shelf', name: '书架',
      states: ['放着'], state: 0, height: 2, pushable: true, heavy: false, secrets: [],
    }];
  });
  const beforeEvents = api.getWorld().events?.length ?? 0;
  api.trialMove(0, -1); // 转身
  api.trialMove(0, -1); // 推 + 攀，应该停在确认
  const map = api.findMap(api.getWorld(), m.id);
  const shelf = map.objects.find((o) => o.id === 'shelf');
  const tok = map.tokens.find((t) => t.id === 'ta');
  assert.deepEqual([shelf.x, shelf.y], [2, 1], '家具不能先挪');
  assert.deepEqual([tok.x, tok.y], [2, 2], '人也不能动');
  assert.equal(api.getWorld().events?.length ?? 0, beforeEvents, '确认阶段不落账');
  assert.match(api.getUI().trial.msg, /高 2 格|攀/);

  api.trialMove(0, -1); // 确认：这时才推 + 攀/跳
  const after = api.findMap(api.getWorld(), m.id);
  const shelf2 = after.objects.find((o) => o.id === 'shelf');
  const tok2 = after.tokens.find((t) => t.id === 'ta');
  assert.deepEqual([shelf2.x, shelf2.y], [2, 0], '确认后家具才动');
  assert.notDeepEqual([tok2.x, tok2.y], [shelf2.x, shelf2.y], '人不能和家具叠在一起');
  const pushEv = api.getWorld().events.findLast((e) => e.action.name === '推');
  assert.ok(pushEv, '确认后要补一条推的事件');
  assert.equal(pushEv.deltas.length, 1, '这条推事件只记家具，不记人的位移');
  assert.deepEqual(pushEv.deltas[0], {
    kind: 'object', id: 'shelf', name: '书架', path: '位置',
    from: '(2, 1)', to: '(2, 0)',
  });
});

test('推箱确认：攀爬前置条件不满足时不能先挪家具', () => {
  const { m } = fight();
  api.toggleCombat();
  api.update((d) => {
    const map = d.maps[0];
    map.heights = new Array(map.width * map.height).fill(0);
    map.heights[1 * map.width + 2] = 2;
    d.party[0].attributes = {}; // 六维没填，攀爬会被 beginUpClimb 拒绝
    map.objects = [{
      ...api.newObject('object', 2, 1, 1, 1), id: 'shelf', name: '书架',
      states: ['放着'], state: 0, height: 2, pushable: true, heavy: false, secrets: [],
    }];
  });
  const beforeEvents = api.getWorld().events?.length ?? 0;
  api.trialMove(0, -1);
  api.trialMove(0, -1); // 确认状态
  api.trialMove(0, -1); // 第三下：攀爬前置失败
  const map = api.findMap(api.getWorld(), m.id);
  const shelf = map.objects.find((o) => o.id === 'shelf');
  const tok = map.tokens.find((t) => t.id === 'ta');
  assert.deepEqual([shelf.x, shelf.y], [2, 1], '前置失败不能挪家具');
  assert.deepEqual([tok.x, tok.y], [2, 2], '人也不动');
  assert.equal(api.getWorld().events?.length ?? 0, beforeEvents, '不能先落推的账');
  assert.match(api.getUI().trial.msg, /六维/);
});

test('推箱下跳无检定：摔伤骰开不出时不能先挪家具', () => {
  const { m } = fight();
  api.toggleCombat();
  api.update((d) => {
    const map = d.maps[0];
    map.heights = new Array(map.width * map.height).fill(0);
    map.heights[1 * map.width + 2] = -6; // 书架脚下是 6 格深，没有技能就是必摔
    map.objects = [{
      ...api.newObject('object', 2, 1, 1, 1), id: 'shelf', name: '书架',
      states: ['放着'], state: 0, height: 2, pushable: true, heavy: false, secrets: [],
    }];
  });
  api.openPlayerWindow('a', true);
  api.setUI({ pendingJudgment: { id: 'old-judgment' } });
  const beforeEvents = api.getWorld().events?.length ?? 0;

  api.trialMove(0, -1);
  api.trialMove(0, -1); // 下跳确认
  api.trialMove(0, -1); // 第三下：摔伤骰开不出
  const map = api.findMap(api.getWorld(), m.id);
  const shelf = map.objects.find((o) => o.id === 'shelf');
  const tok = map.tokens.find((t) => t.id === 'ta');
  assert.deepEqual([shelf.x, shelf.y], [2, 1], '开不出摔伤骰，家具不能先动');
  assert.deepEqual([tok.x, tok.y], [2, 2], '人也不动');
  assert.equal(api.getWorld().events?.length ?? 0, beforeEvents, '不能先落推的账');
  assert.equal(api.getUI().pendingJudgment.id, 'old-judgment');
});

test('推箱下跳无检定：先落推，再开摔伤骰', () => {
  const { m } = fight();
  api.toggleCombat();
  api.update((d) => {
    const map = d.maps[0];
    map.heights = new Array(map.width * map.height).fill(0);
    map.heights[1 * map.width + 2] = -6;
    map.objects = [{
      ...api.newObject('object', 2, 1, 1, 1), id: 'shelf', name: '书架',
      states: ['放着'], state: 0, height: 2, pushable: true, heavy: false, secrets: [],
    }];
  });
  api.openPlayerWindow('a', true);
  const win = windows.at(-1);
  win.got.length = 0;
  api.trialMove(0, -1);
  api.trialMove(0, -1);
  api.trialMove(0, -1); // 推下去

  const ev = api.getWorld().events.at(-1);
  assert.equal(ev.action.name, '推');
  assert.ok(api.getUI().pendingJudgment, '摔伤骰要开出去');
  const log = api.getWorld().log;
  const pushIdx = log.findLastIndex((x) => /【推】/.test(x.text));
  const judgeIdx = log.findLastIndex((x) => /开出判定/.test(x.text));
  assert.ok(pushIdx >= 0 && judgeIdx >= 0);
  assert.ok(pushIdx < judgeIdx, '推的日志要在开摔伤骰之前');
});

test('感知：搜索失败时日志逐项标出是哪一项挂的', () => {
  const { m } = fight();
  api.toggleCombat();
  api.update((d) => {
    d.maps[0].objects = [{
      ...api.newObject('object', 2, 3, 1, 1), id: 'clock', name: '钟',
      states: ['正常'], state: 0, height: 0.2, secrets: [{
        id: 's1', label: '刻痕', check: '观察', kind: 'roll', range: 2,
        tiers: { crit: '钟面有刻痕', success: '钟面有刻痕', fail: '', fumble: '' },
      }],
    }];
  });
  const seq = [15, 1]; // 敏捷 15+区值6=21 过；观察掷 1 大失败
  assert.equal(api.trialSense('search', { targetObjectId: 'clock', roll: () => seq.shift() }), null);
  const ev = api.getWorld().events.at(-1);
  assert.equal(ev.check.merge, 'all');
  assert.equal(ev.check.success, false);
  assert.equal(ev.check.tier, 'fumble');
  assert.equal(ev.check.attrs[0].success, true);
  assert.equal(ev.check.attrs[1].success, false);
  assert.equal(ev.check.attrs[1].tier, 'fumble');
  const text = api.getWorld().log.at(-1).text;
  assert.match(text, /敏捷 15\+区值6✓/);
  assert.match(text, /观察 1\+区值6✗（大失败）/);
});

test('玩家载荷：移动/感知之后仍然不带 events 和 log', () => {
  const { m } = fight();
  api.toggleCombat();
  api.update((d) => {
    d.maps[0].objects = [{
      ...api.newObject('object', 2, 3, 1, 1), id: 'clock', name: '钟',
      states: ['正常'], state: 0, height: 0.2, secrets: [],
    }];
  });
  api.trialMove(0, -1);
  api.trialMove(0, -1);
  api.trialSense('observe', { targetObjectId: 'clock', roll: () => 20 });
  const payload = api.playerWorld(api.getWorld(), m.id, 'a');
  assert.deepEqual(payload.events, []);
  assert.deepEqual(payload.log, []);
  assert.doesNotMatch(JSON.stringify(payload), /刻痕|【观察】|【移动】/);
});

test('推箱下跳无检定：无玩家窗口时 host 结算的事件顺序是推→跳', () => {
  const { m } = fight();
  api.toggleCombat();
  api.update((d) => {
    const map = d.maps[0];
    map.heights = new Array(map.width * map.height).fill(0);
    map.heights[1 * map.width + 2] = -6;
    map.objects = [{
      ...api.newObject('object', 2, 1, 1, 1), id: 'shelf', name: '书架',
      states: ['放着'], state: 0, height: 2, pushable: true, heavy: false, secrets: [],
    }];
  });
  api.trialMove(0, -1);
  api.trialMove(0, -1);
  api.trialMove(0, -1);
  const events = api.getWorld().events;
  assert.ok(events.length >= 2);
  assert.equal(events.at(-2).action.name, '推');
  assert.match(events.at(-1).action.name, /往下跳/);
});

test('坑前确认：确认那一下不落移动账，跳过去仍走跳跃事件', () => {
  const { m } = fight();
  api.toggleCombat(); // 自由行动
  api.update((d) => { d.maps[0].cells[1 * 10 + 2] = 'hole'; });
  const before = api.getWorld().events?.length ?? 0;
  api.trialMove(0, -1); // 转身
  api.trialMove(0, -1); // 坑前提示
  assert.equal(api.getWorld().events?.length ?? 0, before, '坑前确认不落移动账');
  assert.ok(api.getUI().pendingGap);
  api.trialMove(0, -1); // 确认跳过去
  const ev = api.getWorld().events.at(-1);
  assert.match(ev.action.name, /跨过|跳过去/);
  assert.ok(!api.getWorld().events.some((e) => e.action.name === '移动'), '跳过去不能再记一条普通移动');
});
