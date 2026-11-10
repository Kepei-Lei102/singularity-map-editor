import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-jump-'));
const bundle = join(temp, 'jump.cjs');
await build({
  stdin: { contents: `export * from './src/rules/jump';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const api = createRequire(import.meta.url)(bundle);
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

const NO = api.NO_JUMP_SKILLS;
const CLIMB = { climb: true, longJump: false };
const BOTH = { climb: true, longJump: true };

/** 固定骰：按顺序返回给定的点数。 */
const dice = (...v) => { let i = 0; return () => v[Math.min(i++, v.length - 1)]; };

const pc = (attrs) => ({ id: 'a', name: '甲', color: '#fff', tags: [], attributes: attrs });

// ---------- 平行跳 ----------

test('平行跳：1 格不用检定', () => {
  const p = api.planJump('across', 1, NO);
  assert.equal(p.allowed, true);
  assert.equal(p.check, null);
  assert.equal(p.usesAction, false);
});

test('平行跳：2 格要敏捷检定', () => {
  const p = api.planJump('across', 2, NO);
  assert.equal(p.allowed, true);
  assert.equal(p.check.attr, '敏捷');
  assert.equal(p.check.mode, 'single');
});

test('平行跳：3 格是长跳，没技能不行', () => {
  const no = api.planJump('across', 3, NO);
  assert.equal(no.allowed, false);
  assert.match(no.reason, /跳远/);

  const yes = api.planJump('across', 3, BOTH);
  assert.equal(yes.allowed, true);
  assert.equal(yes.check.attr, '力量', '长跳一般力量检定');
});

test('平行跳：4 格以上跳不过去', () => {
  const p = api.planJump('across', 4, BOTH);
  assert.equal(p.allowed, false);
  assert.match(p.reason, /四格以上/);
});

test('平行跳失败：掉下去，按中伤摔', () => {
  // 敏捷区值 = floor(20/5) = 4 → 门槛 40。掷 90 必败。
  const plan = api.planJump('across', 2, NO);
  const out = api.resolveJump(pc({ 敏捷: 20 }), plan, dice(90, 90));
  assert.equal(out.landed, false);
  assert.ok(out.damage >= 1 && out.damage <= 8, '中伤 1D8');
  assert.match(out.text, /没跳过去/);
});

test('平行跳成功：过去了，不摔', () => {
  const plan = api.planJump('across', 2, NO);
  const out = api.resolveJump(pc({ 敏捷: 90 }), plan, dice(10, 10)); // 门槛 180，10 必过
  assert.equal(out.landed, true);
  assert.equal(out.damage, 0);
});

// ---------- 往上 ----------

test('往上：1 格是普通移动，双倍消耗', () => {
  const p = api.planJump('up', 1, NO);
  assert.equal(p.check, null);
  assert.equal(p.moveMultiplier, 2);
  assert.equal(p.usesAction, false);
});

test('往上：2–3 格要力量，占行动点', () => {
  const p = api.planJump('up', 2, NO);
  assert.equal(p.check.attr, '力量');
  assert.equal(p.usesAction, true);
});

test('往上：2–3 格有【攀爬】就不占行动点', () => {
  const p = api.planJump('up', 3, CLIMB);
  assert.equal(p.allowed, true);
  assert.equal(p.usesAction, false, '作者：2-3 有攀爬技能的人可以不消耗行动点');
});

test('往上：4–9 格没【攀爬】根本上不去', () => {
  for (const n of [4, 6, 9]) {
    const p = api.planJump('up', n, NO);
    assert.equal(p.allowed, false, `${n} 格该上不去`);
    assert.match(p.reason, /攀爬/);
  }
});

test('往上：4–9 格有【攀爬】就敏捷检定，不占行动点', () => {
  const p = api.planJump('up', 6, CLIMB);
  assert.equal(p.allowed, true);
  assert.equal(p.check.attr, '敏捷');
  assert.equal(p.usesAction, false);
});

test('往上：12 格以上有【攀爬】才能爬，但依旧占行动点', () => {
  const no = api.planJump('up', 12, NO);
  assert.equal(no.allowed, false);

  const yes = api.planJump('up', 12, CLIMB);
  assert.equal(yes.allowed, true);
  assert.equal(yes.usesAction, true, '作者：有攀爬才能爬，但依旧占行动点');
  assert.equal(yes.check.attr, '敏捷');
});

test('往上失败：没攀上去，掉回原地，不摔', () => {
  const plan = api.planJump('up', 2, NO);
  const out = api.resolveJump(pc({ 力量: 20 }), plan, dice(90, 90));
  assert.equal(out.landed, false);
  assert.equal(out.damage, 0, '往上失败不摔');
  assert.match(out.text, /掉回原地/);
});

// ---------- 往下 ----------

test('往下摔伤四档', () => {
  assert.equal(api.injuryTier(1), 'light');
  assert.equal(api.injuryTier(2), 'light');
  assert.equal(api.injuryTier(3), 'medium');
  assert.equal(api.injuryTier(5), 'medium');
  assert.equal(api.injuryTier(6), 'heavy');
  assert.equal(api.injuryTier(11), 'heavy');
  assert.equal(api.injuryTier(12), 'brutal');
  assert.equal(api.injuryTier(30), 'brutal');
});

test('摔伤骰：1D4 / 1D8 / 1D12 / 1D20', () => {
  assert.equal(api.INJURY_DICE.light, 4);
  assert.equal(api.INJURY_DICE.medium, 8);
  assert.equal(api.INJURY_DICE.heavy, 12);
  assert.equal(api.INJURY_DICE.brutal, 20);
});

test('往下没技能：≤2 格单敏捷，3–5 格劣势敏捷，6 格以上必摔', () => {
  const a = api.planJump('down', 2, NO);
  assert.equal(a.check.attr, '敏捷');
  assert.equal(a.check.mode, 'single');
  assert.equal(a.injury, 'light');

  const b = api.planJump('down', 4, NO);
  assert.equal(b.check.mode, 'disadvantage');
  assert.equal(b.injury, 'medium');

  const c = api.planJump('down', 6, NO);
  assert.equal(c.check, null, '6 格以上不用检定，必摔');
  assert.equal(c.injury, 'heavy');
});

test('往下 12 格以上：1D20，占行动点', () => {
  const p = api.planJump('down', 12, NO);
  assert.equal(p.injury, 'brutal');
  assert.equal(p.usesAction, true);
  assert.equal(p.check, null);
});

test('往下有【攀爬】：爬下去，不摔', () => {
  const p = api.planJump('down', 4, CLIMB);
  assert.equal(p.allowed, true);
  assert.equal(p.injury, null, '有攀爬就不用摔');
  assert.equal(p.check.attr, '敏捷');
  assert.equal(p.usesAction, false);
  assert.equal(p.moveMultiplier, 2, '向下攀爬也双倍消耗');
});

test('往下 12 格以上有攀爬：依旧占行动点', () => {
  const p = api.planJump('down', 14, CLIMB);
  assert.equal(p.usesAction, true);
  assert.equal(p.injury, null);
});

test('往下必摔：确实扣血', () => {
  const plan = api.planJump('down', 8, NO);
  const out = api.resolveJump(pc({}), plan, dice(7));
  assert.equal(out.landed, false);
  assert.equal(out.damage, 7);
  assert.match(out.text, /重伤/);
});

test('往下检定过了：稳稳落地不摔', () => {
  const plan = api.planJump('down', 2, NO);
  const out = api.resolveJump(pc({ 敏捷: 90 }), plan, dice(10, 10));
  assert.equal(out.landed, true);
  assert.equal(out.damage, 0);
  assert.match(out.text, /稳稳落地/);
});

// ---------- 检定算法 ----------

test('区值 = 属性 ÷ 5 向下取整，门槛 = 区值 × 10', () => {
  assert.equal(api.zoneOf({ 敏捷: 47 }, '敏捷'), 9);
  assert.equal(api.zoneOf({ 敏捷: 50 }, '敏捷'), 10);
  assert.equal(api.zoneOf({}, '敏捷'), 0);
});

test('优势取高的那个', () => {
  const p = pc({ 敏捷: 10 }); // 门槛 20
  // 优势取高：掷 95 和 30，取 95 → 95 > 20，没过
  const adv = api.rollJumpCheck(p, { attr: '敏捷', mode: 'advantage', why: '' }, dice(95, 30));
  assert.equal(adv.success, false, '优势取 95，超过了门槛');
  // 掷 30 和 95，取 30 → 30 > 20，也没过
  const adv2 = api.rollJumpCheck(p, { attr: '敏捷', mode: 'advantage', why: '' }, dice(30, 95));
  assert.equal(adv2.success, false);
  // 掷 10 和 95，取 10 → 过了
  const adv3 = api.rollJumpCheck(p, { attr: '敏捷', mode: 'advantage', why: '' }, dice(10, 95));
  assert.equal(adv3.success, true);
});

test('劣势取低的那个，掷到低分才过', () => {
  const p = pc({ 敏捷: 50 }); // 门槛 100
  const dis = api.rollJumpCheck(p, { attr: '敏捷', mode: 'disadvantage', why: '' }, dice(95, 30));
  // 取低 = 30 ≤ 100 → 过
  assert.equal(dis.success, true);
  const dis2 = api.rollJumpCheck(p, { attr: '敏捷', mode: 'disadvantage', why: '' }, dice(95, 99));
  assert.equal(dis2.success, true, '取 95，仍 ≤ 100');
  const low = pc({ 敏捷: 10 }); // 门槛 20
  const dis3 = api.rollJumpCheck(low, { attr: '敏捷', mode: 'disadvantage', why: '' }, dice(95, 90));
  assert.equal(dis3.success, false, '取 90 > 20，没过');
});

test('100 算特大成功，直接过', () => {
  const p = pc({ 敏捷: 0 }); // 门槛 0
  const r = api.rollJumpCheck(p, { attr: '敏捷', mode: 'single', why: '' }, dice(100));
  assert.equal(r.success, true);
});

// ---------- 高度恐惧 ----------

test('高度恐惧四档', () => {
  assert.equal(api.fearTier(3), 'none');
  assert.equal(api.fearTier(4), 'advantage');
  assert.equal(api.fearTier(8), 'normal');
  assert.equal(api.fearTier(12), 'disadvantage');
});

test('恐惧检定的掷法跟着档位走', () => {
  assert.equal(api.fearCheck('none'), null);
  assert.equal(api.fearCheck('advantage').mode, 'advantage');
  assert.equal(api.fearCheck('normal').mode, 'single');
  assert.equal(api.fearCheck('disadvantage').mode, 'disadvantage');
  assert.equal(api.fearCheck('normal').attr, '意志');
});

test('往上和往下都算高度恐惧', () => {
  assert.equal(api.planJump('up', 8, CLIMB).fear, 'normal');
  assert.equal(api.planJump('down', 8, NO).fear, 'normal');
  assert.equal(api.planJump('up', 12, CLIMB).fear, 'disadvantage');
});

test('一楼层高的下落正好是普通意志那档', () => {
  // 挑高 8 格 = 6 米 → 普通意志
  assert.equal(api.planJump('down', 8, NO).fear, 'normal');
});
