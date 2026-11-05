import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-interaction-test-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/interaction'; export { blocksMovement } from './src/perception';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const { attrValue, pickRoll, tierOfRoll, resolve, resolveContest, finalDC, sideAdvantage, planEffects, resolveOutcomes, materialize, applyTransitions, parseAdHoc, applyAdHoc, meCost, checkForSource, checkPreconditions, describeUnmet, resolveLuck, luckThreshold, blocksMovement } = await import(bundle);
after(() => rm(temp, { recursive: true, force: true }));

const sheet = (o = {}) => ({ 力量: 50, 敏捷: 50, 意志: 50, 观察: 50, 智慧: 50, 魅力: 50, ...o });
const one = (attr, mode = 'single') => ({ attributes: [attr], mode });

test('D20 区值：总属性÷5 向下取整', () => {
  assert.equal(attrValue(65), 13);
  assert.equal(attrValue(68), 13);
  assert.equal(attrValue(47), 9);
  assert.equal(attrValue(50, 'd100'), 50);
});

test('单一属性：属性区值＋骰点 ≥ 20', () => {
  assert.equal(resolve({ check: one('敏捷'), actor: sheet({ 敏捷: 65 }), d20s: [[7]] }).success, true);
  assert.equal(resolve({ check: one('敏捷'), actor: sheet({ 敏捷: 65 }), d20s: [[6]] }).success, false);
});

test('主动调整值是临时加值', () => {
  const r = resolve({ check: one('敏捷'), actor: sheet({ 敏捷: 65 }), d20s: [[6]], adjust: 2 });
  assert.equal(r.success, true);
  assert.equal(r.adjust, 2);
});

test('优势取高、劣势取低', () => {
  assert.equal(pickRoll([4, 17], 'advantage'), 17);
  assert.equal(pickRoll([4, 17], 'disadvantage'), 4);
  const adv = resolve({ check: one('敏捷'), actor: sheet({ 敏捷: 50 }), d20s: [[3, 18]], advantage: 'advantage' });
  assert.equal(adv.success, true);
});

test('D20 区：只有 20 和 1 是极值，没有补投', () => {
  assert.deepEqual(tierOfRoll('d20', 20), { tier: 'crit', level: 'normal' });
  assert.deepEqual(tierOfRoll('d20', 1), { tier: 'fumble', level: 'normal' });
  assert.deepEqual(tierOfRoll('d20', 19), { tier: null, level: null });
  // 即便给了补投，D20 区也不出现特大
  assert.deepEqual(tierOfRoll('d20', 20, 20), { tier: 'crit', level: 'normal' });
});

test('D100 区：000 才补投，1 特大失败 / 2–10 大失败 / 11–19 大成功 / 20 特大成功', () => {
  assert.deepEqual(tierOfRoll('d100', 100, 1), { tier: 'fumble', level: '特大' });
  assert.deepEqual(tierOfRoll('d100', 100, 5), { tier: 'fumble', level: 'normal' });
  assert.deepEqual(tierOfRoll('d100', 100, 15), { tier: 'crit', level: 'normal' });
  assert.deepEqual(tierOfRoll('d100', 100, 20), { tier: 'crit', level: '特大' });
  assert.deepEqual(tierOfRoll('d100', 37, undefined), { tier: null, level: null });
});

test('拼点：区值＋骰点，高者赢；平手算没做成', () => {
  const win = resolveContest({ actorValue: 13, actorRoll: 12, targetValue: 15, targetRoll: 9 });
  assert.equal(win.actorTotal, 25);
  assert.equal(win.targetTotal, 24);
  assert.equal(win.success, true);
  const tie = resolveContest({ actorValue: 13, actorRoll: 10, targetValue: 13, targetRoll: 10 });
  assert.equal(tie.success, null);
});

test('见证者裁决：不掷骰，成败留空由人定', () => {
  const r = resolve({ check: { attributes: [], mode: 'gm' }, actor: sheet() });
  assert.equal(r.success, null);
  assert.equal(r.tier, null);
});

test('多重检定：或 / 与 / 和', () => {
  const actor = sheet({ 敏捷: 70, 观察: 30 }); // 14 / 6
  const or = resolve({ check: { attributes: ['敏捷', '观察'], mode: 'or' }, actor, d20s: [[1], [15]] });
  assert.equal(or.success, true);
  const and = resolve({ check: { attributes: ['敏捷', '观察'], mode: 'and' }, actor, d20s: [[15], [5]] });
  assert.equal(and.success, false);
  const sum = resolve({ check: { attributes: ['敏捷', '观察'], mode: 'sum' }, actor, d20s: [[10], [10]] });
  assert.equal(sum.success, true); // (14+10)+(6+10)=40 ≥ 20
});

test('驱动地图：门的状态一改，通行自动变——不需要额外代码', () => {
  const door = { id: 'd1', kind: 'object', name: '门', x: 0, y: 0, w: 1, h: 1, height: 2.4, color: '', icon: '', states: ['关闭', '打开'], state: 0, blocksWhen: [0], notes: '', hidden: false, secrets: [], media: [] };
  const map = { id: 'm1', objects: [door] };
  assert.equal(blocksMovement(door), true);
  const def = { id: '1', name: '撬锁', category: '潜行·渗透', check: one('敏捷'),
    outcomes: { success: [{ ref: 'target', toState: 1 }], crit: [{ ref: 'target', toState: 1 }] } };
  const r = resolve({ check: def.check, actor: sheet({ 敏捷: 75 }), d20s: [[12]] });
  applyTransitions(map, materialize(map, planEffects(def, r.tier), 'd1'));
  assert.equal(door.state, 1);
  assert.equal(door.stateRev, 1);
  assert.equal(blocksMovement(door), false);
});

test('失败档没有效果就不动状态', () => {
  const door = { id: 'd1', kind: 'object', name: '门', states: ['关闭', '打开'], state: 0, blocksWhen: [0], height: 2.4, notes: '', hidden: false, secrets: [], media: [] };
  const map = { id: 'm1', objects: [door] };
  const def = { id: '1', name: '撬锁', category: '潜行·渗透', check: one('敏捷'), outcomes: { fail: [] } };
  applyTransitions(map, materialize(map, planEffects(def, 'fail'), 'd1'));
  assert.equal(door.state, 0);
});

test('规则书例子：A 魅力 13、B 魅力 12 → DC 19，骰点 6 过、5 不过', () => {
  assert.equal(finalDC({ actorValue: 13, targetValue: 12, opposed: true }), 19);
  const actor = sheet({ 魅力: 65 }); // 13
  const target = sheet({ 魅力: 60 }); // 12
  const guo = resolve({ check: one('魅力'), actor, target, d20s: [[6]] });
  assert.equal(guo.rolls[0].dc, 19);
  assert.equal(guo.success, true);
  const bu = resolve({ check: one('魅力'), actor, target, d20s: [[5]] });
  assert.equal(bu.success, false);
});

test('属性差 ≥4 才给优势／劣势（D20）', () => {
  assert.deepEqual(sideAdvantage('d20', 13, 9), { actor: 'advantage', target: 'disadvantage' });
  assert.deepEqual(sideAdvantage('d20', 9, 13), { actor: 'disadvantage', target: 'advantage' });
  assert.deepEqual(sideAdvantage('d20', 13, 10), { actor: 'normal', target: 'normal' });
  assert.deepEqual(sideAdvantage('d100', 60, 40), { actor: 'advantage', target: 'disadvantage' }); // 差 20
  assert.deepEqual(sideAdvantage('d100', 60, 45), { actor: 'normal', target: 'normal' }); // 差 15
});

test('对抗时优势自动生效：掷两颗取高', () => {
  const actor = sheet({ 敏捷: 70 });  // 14
  const target = sheet({ 敏捷: 50 }); // 10，差 4 → 优势
  const r = resolve({ check: one('敏捷'), actor, target, d20s: [[2, 15]] });
  assert.equal(r.rolls[0].roll, 15);
  assert.equal(r.rolls[0].dc, 16); // 20 − (14 − 10)
});

test('物件档案整档覆盖：同一条【砸】，橡皮泥和非牛顿流体不一样', () => {
  const def = { id: '9', name: '砸', category: '体术·格斗', check: one('力量'),
    outcomes: { success: [{ ref: 'target', toState: 1 }], crit: [{ ref: 'target', toState: 2 }] } };
  const clay = { id: 'p1', name: '橡皮泥', material: '橡皮泥' };
  const fluid = { id: 'p2', name: '非牛顿流体', material: '非牛顿流体' };
  const overrides = [
    { actionId: '9', match: { material: '橡皮泥' }, outcomes: { success: [{ ref: 'target', toState: 0 }], crit: [{ ref: 'target', toState: 0 }] } },
    { actionId: '9', match: { material: '非牛顿流体' }, outcomes: { success: [{ ref: 'target', toState: 1 }], crit: [{ ref: 'target', toState: 3 }] } },
  ];
  assert.equal(resolveOutcomes(def, 'success', clay, overrides)[0].toState, 0);   // 陷进去，形变但没坏
  assert.equal(resolveOutcomes(def, 'crit', fluid, overrides)[0].toState, 3);     // 变硬、裂
  assert.equal(resolveOutcomes(def, 'success', { id: 'p3', name: '玻璃', material: '玻璃' }, overrides)[0].toState, 1); // 没覆盖 → 默认
});

test('现挂：白名单校验，多余字段与未知类型一律拒绝', () => {
  const ok = parseAdHoc({ kind: 'object-state', mapId: 'm1', objectId: 'd1', toState: 2, reason: '大失败：门被撞变形' });
  assert.equal(ok.toState, 2);
  assert.equal(parseAdHoc({ kind: 'object-state', mapId: 'm1', objectId: 'd1', toState: 2, reason: 'x', code: 'evil()' }), null);
  assert.equal(parseAdHoc({ kind: 'run-code', mapId: 'm1', reason: 'x' }), null);
  assert.equal(parseAdHoc({ kind: 'object-state', mapId: 'm1', objectId: 'd1', toState: -1, reason: 'x' }), null);
});

test('现挂施加：只改状态／位置／开关，状态改动自增 rev', () => {
  const door = { id: 'd1', kind: 'object', name: '门', x: 1, y: 1, states: ['关闭', '卡住', '打开'], state: 0, blocksWhen: [0, 1], height: 2.4, notes: '', hidden: false, secrets: [], media: [] };
  const map = { id: 'm1', objects: [door], tokens: [] };
  applyAdHoc(map, [{ kind: 'object-state', mapId: 'm1', objectId: 'd1', toState: 1, reason: '撞歪了' }]);
  assert.equal(door.state, 1);
  assert.equal(door.stateRev, 1);
  assert.equal(blocksMovement(door), true); // 卡住也挡路
});

test('ME：原始动作不耗，技能动作默认 1，动作卡可覆盖', () => {
  const primitive = { source: 'primitive', cost: { me: { perTurn: 1 } } };
  assert.equal(meCost(primitive), 0);                       // 原始动作永远 0
  assert.equal(meCost({ source: 'skill' }), 1);             // 没写就默认 1
  assert.equal(meCost({ source: 'skill', cost: { me: 2 } }), 2);
  assert.equal(meCost({ source: 'skill', cost: { me: 1 } }, 3), 1);   // 卡优先于技能表
  assert.deepEqual(meCost({ source: 'skill' }, { perTurn: 1 }), { perTurn: 1 });
});

test('攻击命中：D100 掷 00 直接特大成功，不走补投', () => {
  assert.deepEqual(tierOfRoll('d100', 100, undefined, { attack: true }), { tier: 'crit', level: '特大' });
  assert.deepEqual(tierOfRoll('d100', 100, 5, { attack: true }), { tier: 'crit', level: '特大' }); // 补投被忽略
  assert.deepEqual(tierOfRoll('d100', 37, undefined, { attack: true }), { tier: null, level: null });
});

test('视环境（与或并存）：见证者当场选走或还是走与', () => {
  const actor = sheet({ 敏捷: 70, 观察: 30 }); // 14 / 6
  const check = { attributes: ['敏捷', '观察'], mode: 'situational' };
  assert.equal(resolve({ check, actor, d20s: [[1], [15]] }).success, true);                    // 默认走"或"
  assert.equal(resolve({ check, actor, d20s: [[1], [15]], situationalMode: 'and' }).success, false);
});

test('多来源不同：按角色已解锁的来源取属性和口径', () => {
  const def = {
    id: '1', name: '双持', category: '战斗·兵器',
    check: { attributes: ['敏捷', '观察'], mode: 'situational' },
    sources: [
      // 占位的假编号：不是技能库里的真实序号
      { skillId: '999-9-101', attributes: ['敏捷'], mode: 'single' },
      { skillId: '999-5-202', attributes: ['观察', '敏捷'], mode: 'or' },
    ],
  };
  assert.deepEqual(checkForSource(def, '999-9-101'), { attributes: ['敏捷'], mode: 'single' });
  assert.deepEqual(checkForSource(def, '999-5-202'), { attributes: ['观察', '敏捷'], mode: 'or' });
  assert.deepEqual(checkForSource(def), { attributes: ['敏捷', '观察'], mode: 'situational' }); // 没来源就用卡
});

test('带计数的判定：前 3 次劣势，用够 7 次后 +2', () => {
  const usage = { disadvantageFirst: 3, bonusAfter: { uses: 7, d20: 2, d100: 10 } };
  const check = { attributes: ['智慧'], mode: 'single' };
  const actor = sheet({ 智慧: 60 }); // 12
  // 第 1 次：劣势，掷两颗 [19,3] 取低 3 → 15 < 20 不过
  const first = resolve({ check, actor, d20s: [[19, 3]], uses: 0, usage });
  assert.equal(first.rolls[0].roll, 3);
  assert.equal(first.success, false);
  // 第 8 次：不再劣势，且有 +2 → 12+10+2=24 过
  const later = resolve({ check, actor, d20s: [[10]], uses: 7, usage });
  assert.equal(later.adjust, 2);
  assert.equal(later.success, true);
});

test('【幸运】不在六维里，走纯骰规则而不是属性 DC', () => {
  const actor = sheet({ 幸运: 60 });
  assert.equal(resolve({ check: { attributes: ['幸运'], mode: 'single' }, actor, d20s: [[9]] }).success, false);  // 9 < 11
  assert.equal(resolve({ check: { attributes: ['幸运'], mode: 'single' }, actor, d20s: [[12]] }).success, true);  // 12 ≥ 11
});

test('D100 区默认 DC 是 100，不是 20', () => {
  const actor = sheet({ 敏捷: 60 }); // D100 区直接用总属性 60
  const ok = resolve({ check: one('敏捷'), actor, d20s: [[45]], scale: 'd100' });
  assert.equal(ok.rolls[0].dc, 100);
  assert.equal(ok.rolls[0].value, 60);   // D100 区不除 5
  assert.equal(ok.success, true);        // 60+45=105 ≥ 100
  const no = resolve({ check: one('敏捷'), actor, d20s: [[30]], scale: 'd100' });
  assert.equal(no.success, false);       // 60+30=90 < 100
});

test('前置条件：【点火】要易燃物＋打火机，缺一条就报出来', () => {
  const fire = { id: '2', name: '点火', category: '运动·生存', check: one('敏捷'),
    preconditions: [{ kind: 'targetHasProp', prop: '易燃物' }, { kind: 'actorHas', tag: '打火机' }] };
  const ok = checkPreconditions(fire, { targetProps: ['易燃物'], actorTags: ['打火机'] });
  assert.equal(ok.ok, true);
  const no = checkPreconditions(fire, { targetProps: ['金属'], actorTags: [] });
  assert.equal(no.ok, false);
  assert.equal(no.unmet.length, 2);
  assert.match(describeUnmet(no.unmet), /易燃物/);
  assert.match(describeUnmet(no.unmet), /打火机/);
});

test('前置条件：射程与状态', () => {
  const pick = { id: '5', name: '撬锁', category: '潜行·渗透', check: one('敏捷'),
    preconditions: [{ kind: 'targetHasProp', prop: '物理锁具' }, { kind: 'withinRange', cells: 1 }, { kind: 'targetStateIn', states: [0] }] };
  assert.equal(checkPreconditions(pick, { targetProps: ['物理锁具'], distance: 1, targetState: 0 }).ok, true);
  assert.equal(checkPreconditions(pick, { targetProps: ['物理锁具'], distance: 3, targetState: 0 }).ok, false); // 太远
  assert.equal(checkPreconditions(pick, { targetProps: ['物理锁具'], distance: 1, targetState: 1 }).ok, false); // 已经开了
});

test('幸运：纯骰，D20 11–20 成，D100 51–00 成，不加属性不加调整值', () => {
  assert.equal(luckThreshold('d20'), 11);
  assert.equal(luckThreshold('d100'), 51);
  assert.equal(resolveLuck(10).success, false);
  assert.equal(resolveLuck(11).success, true);
  assert.equal(resolveLuck(50, 'd100').success, false);
  assert.equal(resolveLuck(51, 'd100').success, true);
  // 幸运不看属性、不吃调整值
  const actor = sheet({ 幸运: 5 });   // 区值 1，若按 DC 走必失败
  const low = resolve({ check: { attributes: ['幸运'], mode: 'single' }, actor, d20s: [[12]], adjust: -5 });
  assert.equal(low.success, true);    // 骰面 12 ≥ 11 即成功
  // 幸运掷 20 不产生特大成功，掷 1 也不产生大失败
  const twenty = resolve({ check: { attributes: ['幸运'], mode: 'single' }, actor, d20s: [[20]] });
  assert.equal(twenty.tier, 'success');
  const one = resolve({ check: { attributes: ['幸运'], mode: 'single' }, actor, d20s: [[1]] });
  assert.equal(one.tier, 'fail');
  // D100 掷 100（000）也不走补投链
  const hi = resolve({ check: { attributes: ['幸运'], mode: 'single' }, actor, d20s: [[100, 20]], scale: 'd100' });
  assert.equal(hi.success, true);   // 骰面 100 ≥ 51
  assert.equal(hi.tier, 'success'); // 幸运不参与极值：000 也不升特大
  assert.equal(hi.level, null);
});
