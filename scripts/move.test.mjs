import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-move-'));
const bundle = join(temp, 'move.cjs');
await build({
  stdin: { contents: `export * from './src/rules/move';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const api = createRequire(import.meta.url)(bundle);
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

const pc = (attributes, extra = {}) => ({ id: 'a', name: '甲', color: '#fff', tags: [], attributes, ...extra });

test('基准值正好 5 格', () => {
  const b = api.moveBudget(pc({ 敏捷: 0, 力量: 0, 意志: 0 }));
  assert.equal(b.value, 375);
  assert.equal(b.cells, 5);
});

test('物理移动：敏捷 0.4、力量 0.3、意志 0.3', () => {
  const b = api.moveBudget(pc({ 敏捷: 50, 力量: 50, 意志: 50 }));
  // 375 + 20 + 15 + 15 = 425
  assert.equal(b.value, 425);
  assert.equal(b.cells, 5); // 425/75 = 5.67
  const parts = Object.fromEntries(b.parts.map((p) => [p.label, p.points]));
  assert.equal(parts['敏捷 ×0.4'], 20);
  assert.equal(parts['力量 ×0.3'], 15);
  assert.equal(parts['意志 ×0.3'], 15);
});

test('心理移动：智慧 0.4、观察 0.3、魅力 0.3', () => {
  const b = api.moveBudget(pc({ 智慧: 50, 观察: 50, 魅力: 50 }), 'mental');
  // 375 + 20 + 15 + 15 = 425
  assert.equal(b.value, 425);
  const parts = Object.fromEntries(b.parts.map((p) => [p.label, p.points]));
  assert.equal(parts['智慧 ×0.4'], 20);
  assert.equal(parts['观察 ×0.3'], 15);
  assert.equal(parts['魅力 ×0.3'], 15);
});

test('两套移动不一样：只堆智慧的人心理移动更快', () => {
  // 心理：375 + 0.4×120 = 423 → 5 格，只差一点
  // 物理：375 + 0.4×8 = 378 → 5 格
  // 所以直接比数值，不比格子（两者都在 5 格这一档）
  const p = pc({ 敏捷: 8, 力量: 0, 意志: 0, 智慧: 120, 观察: 0, 魅力: 0 });
  const phys = api.moveBudget(p, 'physical');
  const ment = api.moveBudget(p, 'mental');
  assert.ok(ment.value > phys.value, `心理 ${ment.value} 该大于物理 ${phys.value}`);

  // 把智慧再堆高一点就能多出一格
  const p2 = pc({ 敏捷: 0, 力量: 0, 意志: 0, 智慧: 200, 观察: 0, 魅力: 0 });
  // 心理 375+80=455 → 6 格；物理 375 → 5 格
  assert.equal(api.moveBudget(p2, 'mental').cells, 6);
  assert.equal(api.moveBudget(p2, 'physical').cells, 5);
});

test('身高：1.5 米起步，超出的厘米数直接加点', () => {
  assert.equal(api.heightBonus(150), 0);
  assert.equal(api.heightBonus(180), 30);
  assert.equal(api.heightBonus(145), 0, '不到 1.5 米不加也不扣');
  assert.equal(api.heightBonus(undefined), 0);

  const tall = api.moveBudget(pc({}, { heightCm: 180 }));
  assert.equal(tall.value, 375 + 30);
  assert.ok(tall.parts.some((p) => p.label.includes('180')));
});

test('身高只补物理移动，不补心理', () => {
  const attrs = { 智慧: 50, 观察: 50, 魅力: 50, 敏捷: 50, 力量: 50, 意志: 50 };
  const short = api.moveBudget(pc(attrs, { heightCm: 160 }), 'physical');
  const tall = api.moveBudget(pc(attrs, { heightCm: 190 }), 'physical');
  assert.equal(tall.value - short.value, 30, '物理该差 30 点');

  const mShort = api.moveBudget(pc(attrs, { heightCm: 160 }), 'mental');
  const mTall = api.moveBudget(pc(attrs, { heightCm: 190 }), 'mental');
  assert.equal(mTall.value, mShort.value, '心理移动跟身高无关');
  assert.ok(!mTall.parts.some((p) => p.label.includes('190')), '心理的明细里不该出现身高');
});

test('女性心理移动多 25 点', () => {
  const attrs = { 智慧: 50, 观察: 50, 魅力: 50 };
  const male = api.moveBudget(pc(attrs, { sex: '男' }), 'mental');
  const female = api.moveBudget(pc(attrs, { sex: '女' }), 'mental');
  assert.equal(female.value - male.value, 25);
  // 物理移动不受性别影响
  const mPhys = api.moveBudget(pc(attrs, { sex: '男' }), 'physical');
  const fPhys = api.moveBudget(pc(attrs, { sex: '女' }), 'physical');
  assert.equal(mPhys.value, fPhys.value);
});

test('每 75 点 1 格，75 的整数倍正好进位', () => {
  // 375 + 75 = 450 → 6 格
  const b = api.moveBudget(pc({ 敏捷: 75 / 0.4 }));
  assert.equal(b.value, 450);
  assert.equal(b.cells, 6);

  const just = api.moveBudget(pc({ 敏捷: 74 / 0.4 }));
  assert.equal(just.cells, 5);
  assert.ok(just.toNext > 0 && just.toNext <= 75);
});

test('蓄力分档：25–37 每回合 1/3，38–74 每回合 1/2', () => {
  assert.equal(api.moveBudget(pc({})).charge, null, '基准 375 超出 0，没有蓄力');
  // 超出 24 → 没有
  assert.equal(api.moveBudget(pc({ 敏捷: 60 })).charge, null);
  // 超出 25 → 1/3
  assert.deepEqual(api.moveBudget(pc({ 敏捷: 62.5 })).charge, { perRound: 1 / 3, rounds: 3 });
  // 超出 37 → 还是 1/3
  assert.deepEqual(api.moveBudget(pc({ 敏捷: 92.5 })).charge, { perRound: 1 / 3, rounds: 3 });
  // 超出 38 → 1/2
  assert.deepEqual(api.moveBudget(pc({ 敏捷: 95 })).charge, { perRound: 1 / 2, rounds: 2 });
  // 超出 74 → 还是 1/2
  assert.deepEqual(api.moveBudget(pc({ 敏捷: 185 })).charge, { perRound: 1 / 2, rounds: 2 });
  // 超出 75 → 不再额外算（作者口径：太复杂了）
  assert.equal(api.moveBudget(pc({ 敏捷: 187.5 })).charge, null);
});

test('1/3 档：三回合攒满一格', () => {
  const b = api.moveBudget(pc({ 敏捷: 65 })); // 超出 26
  let s = { progress: 0, cells: 0 };
  s = api.tickCharge(b, s);
  assert.equal(s.cells, 0);
  assert.ok(Math.abs(s.progress - 1 / 3) < 1e-9);
  s = api.tickCharge(b, s);
  assert.equal(s.cells, 0);
  assert.ok(Math.abs(s.progress - 2 / 3) < 1e-9);
  s = api.tickCharge(b, s);
  assert.equal(s.cells, 1, '第三回合给一格');
  assert.equal(s.progress, 0, '给了就从零重新蓄');
});

test('1/2 档：两回合攒满一格', () => {
  const b = api.moveBudget(pc({ 敏捷: 97.5 })); // 超出 39
  let s = { progress: 0, cells: 0 };
  s = api.tickCharge(b, s);
  assert.equal(s.cells, 0);
  assert.ok(Math.abs(s.progress - 0.5) < 1e-9);
  s = api.tickCharge(b, s);
  assert.equal(s.cells, 1);
  assert.equal(s.progress, 0);
});

test('蓄满一格就停住，不会再攒', () => {
  const b = api.moveBudget(pc({ 敏捷: 97.5 }));
  // 作者口径：上限就是 1，最多只能一格充能
  let s = { progress: 0, cells: 0 };
  for (let i = 0; i < 6; i++) s = api.tickCharge(b, s);
  assert.equal(s.cells, 1, '六回合也只攒到一格');
});

test('没有蓄力门槛的人，怎么转都不给', () => {
  const b = api.moveBudget(pc({}));
  let s = { rounds: 0, cells: 0 };
  for (let i = 0; i < 10; i++) s = api.tickCharge(b, s);
  assert.equal(s.cells, 0);
});

test('用掉一格蓄力之后，重新从 0 蓄', () => {
  const s = api.spendCharge({ progress: 0.9, cells: 1 });
  assert.equal(s.cells, 0);
  assert.equal(s.progress, 0, '用完就重新蓄');
});

test('这回合能走几格，要把蓄的算进来', () => {
  const b = api.moveBudget(pc({ 敏捷: 50, 力量: 50, 意志: 50 })); // 5 格
  assert.equal(api.cellsThisTurn(b, 0), 5);
  assert.equal(api.cellsThisTurn(b, 2), 7);
  assert.equal(api.cellsThisTurn(b, -1), 5, '负数当 0');
});

test('属性没填就当 0，不炸', () => {
  const b = api.moveBudget({ id: 'x', name: '空', color: '#fff', tags: [] });
  assert.equal(b.value, 375);
  assert.equal(b.cells, 5);
});

test('身高没填按性别默认', () => {
  assert.equal(api.heightOf({ id: 'x', name: 'a', color: '#', tags: [], sex: '男' }), 170);
  assert.equal(api.heightOf({ id: 'x', name: 'a', color: '#', tags: [], sex: '女' }), 160);
  assert.equal(api.heightOf({ id: 'x', name: 'a', color: '#', tags: [] }), 170);
  assert.equal(api.heightOf({ id: 'x', name: 'a', color: '#', tags: [], heightCm: 182 }), 182);
});

test('按层选移动类型：梦境走心理，现实走物理', () => {
  assert.equal(api.moveKindOfLayer('梦境'), 'mental');
  assert.equal(api.moveKindOfLayer('现实'), 'physical');
  assert.equal(api.moveKindOfLayer('任意'), 'physical', '不认识的就按物理，现实是默认');

  const p = pc({ 智慧: 200, 敏捷: 0, 力量: 0, 意志: 0, 观察: 0, 魅力: 0 });
  assert.equal(api.moveBudgetOn(p, '梦境').cells, 6);
  assert.equal(api.moveBudgetOn(p, '现实').cells, 5);
});

test('三档速度的数值', () => {
  assert.equal(api.RUN_MODES.jog.speed, 1.5);
  assert.equal(api.RUN_MODES.run.speed, 2);
  assert.equal(api.RUN_MODES.sprint.speed, 3);
  assert.equal(api.RUN_MODES.jog.meCost, 0, '慢跑不耗 ME');
  assert.equal(api.RUN_MODES.run.meCost, 1);
  assert.equal(api.RUN_MODES.sprint.meCost, 1);
  assert.equal(api.RUN_MODES.jog.usesAction, false, '慢跑不占行动点');
  assert.equal(api.RUN_MODES.run.usesAction, true);
  assert.equal(api.RUN_MODES.sprint.usesAction, true);
});

test('拐弯限制：慢跑不限，奔跑一次，爆跑零次', () => {
  const jog = api.RUN_MODES.jog;
  assert.equal(api.canTurn(jog, 0), true);
  assert.equal(api.canTurn(jog, 5), true, '慢跑想拐几次拐几次');

  const run = api.RUN_MODES.run;
  assert.equal(api.canTurn(run, 0), true, '还没拐过，可以拐');
  assert.equal(api.canTurn(run, 1), false, '拐过一次就不行了');
  assert.equal(api.canTurn(run, 2), false);

  const sprint = api.RUN_MODES.sprint;
  assert.equal(api.canTurn(sprint, 0), false, '爆跑一次都不准拐');
});

test('跑步额度：对移动点数做运算，再除以 75 取整', () => {
  const b = api.moveBudget(pc({ 敏捷: 50, 力量: 50, 意志: 50 })); // 425 点
  // 425 × 1.5 = 637.5 → ÷75 = 8.5 → 8 格（不是先取 5 格再乘 1.5 的 7 格）
  assert.equal(api.runAllowance(b, api.RUN_MODES.jog), 8 * 3);
  // 425 × 2 = 850 → 11.33 → 11 格
  assert.equal(api.runAllowance(b, api.RUN_MODES.run), 11 * 3);
  // 425 × 3 = 1275 → 17 格
  assert.equal(api.runAllowance(b, api.RUN_MODES.sprint), 17 * 3);
  // 蓄好的额外格不进倍数，直接加在后面
  assert.equal(api.runAllowance(b, api.RUN_MODES.run, 2), 13 * 3);
});

test('趴着爬：点数除以 3，普通人 1 格', () => {
  // 普通人 425 点 → 141.7 → ÷75 = 1.89 → 1 格
  const normal = api.moveBudget(pc({ 敏捷: 50, 力量: 50, 意志: 50 }));
  assert.equal(api.crawlAllowance(normal), 1 * 3);

  // 敏捷 80 是特种兵那一档：375+32+15+15 = 437 → ÷3 = 145.7 → ÷75 = 1.94 → 还是 1 格
  const spec = api.moveBudget(pc({ 敏捷: 80, 力量: 50, 意志: 50 }));
  assert.equal(api.crawlAllowance(spec), 1 * 3, '敏捷 80 也就 1 格');

  // 要有 6 格底子才够 2 格：6 格 ≈ 450 点，÷3 = 150 → ÷75 = 2 格
  const strong = api.moveBudget(pc({ 敏捷: 100, 力量: 100, 意志: 100 })); // 375+40+30+30=475
  assert.equal(strong.cells, 6);
  assert.equal(api.crawlAllowance(strong), 2 * 3, '475 点 → 158 → 2 格');
});

test('ME 不够时拦下来；没填 ME 就不拦', () => {
  const broke = pc({}, { me: 0 });
  assert.equal(api.runMeShort(broke, api.RUN_MODES.run), true);
  assert.equal(api.runMeShort(broke, api.RUN_MODES.jog), false, '慢跑不耗 ME，穷也能跑');

  const rich = pc({}, { me: 5 });
  assert.equal(api.runMeShort(rich, api.RUN_MODES.sprint), false);

  const unknown = pc({}); // 没填 ME
  assert.equal(api.runMeShort(unknown, api.RUN_MODES.run), false, '没填就不拦');
});

test('走一格的价钱：正常 75，跑步按系数降，趴着三倍', () => {
  assert.equal(api.stepPrice(null, false), 75, '正常一格就是一格的价');
  assert.equal(api.stepPrice('jog', false), 50, '慢跑 75÷1.5');
  assert.equal(api.stepPrice('run', false), 37.5, '奔跑 75÷2');
  assert.equal(api.stepPrice('sprint', false), 25, '爆跑 75÷3');
  assert.equal(api.stepPrice(null, true), 225, '趴着爬 75×3');
  assert.equal(api.stepPrice('run', true), 225, '趴着就不管跑法了');
});

test('起身 150 点、翻身 75 点', () => {
  assert.equal(api.STAND_UP_COST, 150);
  assert.equal(api.ROLL_OVER_COST, 75);
  // 普通人 445 点：起身之后剩 295，约等于 3.9 格
  assert.equal(Math.floor((445 - api.STAND_UP_COST) / 75), 3);
});

test('点池 = 移动值 + 蓄好的额外格换的点数', () => {
  const pc45 = pc({ 敏捷: 50, 力量: 50, 意志: 50 }); // 425
  const b = api.moveBudget(pc45);
  assert.equal(api.movePool(b), 425);
  assert.equal(api.movePool(b, 2), 425 + 150);
  assert.equal(api.movePool(null), 375, '没角色卡：老口径 5 格');
});

test('够不够走一格', () => {
  assert.equal(api.canAffordStep(75, 75), true);
  assert.equal(api.canAffordStep(74, 75), false);
  assert.equal(api.canAffordStep(37.5, 37.5), true, '浮点也要判对');
});

test('普通人在点数池里能走几格', () => {
  const b = api.moveBudget(pc({ 敏捷: 50, 力量: 50, 意志: 50 })); // 425
  let left = api.movePool(b);
  let steps = 0;
  const price = api.stepPrice(null, false);
  while (api.canAffordStep(left, price)) { left -= price; steps++; }
  assert.equal(steps, 5, '425 点走 5 格');
  assert.equal(Math.round(left), 50);

  // 慢跑能走几格
  let jogLeft = api.movePool(b), jogSteps = 0;
  const jogPrice = api.stepPrice('jog', false);
  while (api.canAffordStep(jogLeft, jogPrice)) { jogLeft -= jogPrice; jogSteps++; }
  assert.equal(jogSteps, 8, '慢跑 8 格，跟原来算的一致');

  // 趴着爬
  let crawlLeft = api.movePool(b), crawlSteps = 0;
  const crawlPrice = api.stepPrice(null, true);
  while (api.canAffordStep(crawlLeft, crawlPrice)) { crawlLeft -= crawlPrice; crawlSteps++; }
  assert.equal(crawlSteps, 1, '普通人趴着就是 1 格');
});

test('蓄力最多积一格，不会无限涨', () => {
  const b = api.moveBudgetOn(pc({ 智慧: 50, 观察: 50, 魅力: 50 }), '梦境');
  assert.ok(b.charge, '这个角色应该在蓄力区间');
  let s = { progress: 0, cells: 0 };
  for (let i = 0; i < 40; i++) s = api.tickCharge(b, s);
  assert.equal(s.cells, api.MAX_CHARGE_CELLS, '蓄满就停在一格');
  assert.equal(s.cells, 1);
});

test('蓄满之后池子只加一格，不再膨胀', () => {
  const b = api.moveBudgetOn(pc({ 智慧: 50, 观察: 50, 魅力: 50 }), '梦境');
  let s = { progress: 0, cells: 0 };
  for (let i = 0; i < 40; i++) s = api.tickCharge(b, s);
  assert.equal(api.movePool(b, s.cells), b.value + 75);
});

test('用掉一格蓄力后重新蓄满', () => {
  const b = api.moveBudgetOn(pc({ 智慧: 50, 观察: 50, 魅力: 50 }), '梦境');
  let s = api.tickCharge(b, api.tickCharge(b, { progress: 0, cells: 0 }));
  assert.equal(s.cells, 1);
  s = api.spendCharge(s);
  assert.equal(s.cells, 0);
  assert.equal(s.progress, 0);
  s = api.tickCharge(b, s);
  s = api.tickCharge(b, s);
  assert.equal(s.cells, 1, '两回合后又蓄满');
});

// ---------- 蓄力什么时候算「用掉」 ----------

test('没吃到蓄的那一格：还剩 125 点，蓄的 75 没动', () => {
  const b = api.moveBudget({ attributes: { 敏捷: 50, 力量: 50, 意志: 50 } }); // 425
  // 池子 425 + 75 = 500，走 5 格花 375，剩 125 ≥ 75
  assert.equal(api.chargeUsedThisTurn(b, 125, 1), false);
});

test('走进蓄来的那一段：剩 50 点，蓄力用掉', () => {
  const b = api.moveBudget({ attributes: { 敏捷: 50, 力量: 50, 意志: 50 } });
  // 走 6 格花 450，剩 50 < 75
  assert.equal(api.chargeUsedThisTurn(b, 50, 1), true);
});

test('没有蓄好的格子就不会「用掉」', () => {
  const b = api.moveBudget({ attributes: { 敏捷: 50, 力量: 50, 意志: 50 } });
  assert.equal(api.chargeUsedThisTurn(b, 0, 0), false);
});

test('没有角色卡也不会「用掉」', () => {
  assert.equal(api.chargeUsedThisTurn(null, 0, 1), false);
});

test('用掉之后清零，从头重新蓄', () => {
  const spent = api.spendCharge({ progress: 0.5, cells: 1 });
  assert.equal(spent.cells, 0);
  assert.equal(spent.progress, 0);
});
