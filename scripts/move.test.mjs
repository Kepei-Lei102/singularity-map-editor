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

test('蓄满之后继续转，会接着攒下一格', () => {
  const b = api.moveBudget(pc({ 敏捷: 97.5 }));
  let s = { progress: 0, cells: 0 };
  for (let i = 0; i < 6; i++) s = api.tickCharge(b, s);
  assert.equal(s.cells, 3, '六回合攒三格');
});

test('没有蓄力门槛的人，怎么转都不给', () => {
  const b = api.moveBudget(pc({}));
  let s = { rounds: 0, cells: 0 };
  for (let i = 0; i < 10; i++) s = api.tickCharge(b, s);
  assert.equal(s.cells, 0);
});

test('用掉一格蓄力之后，重新从 0 蓄', () => {
  const s = api.spendCharge({ progress: 0.9, cells: 2 });
  assert.equal(s.cells, 1);
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
