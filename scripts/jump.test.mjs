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
  assert.equal(p.check.dice, 'single');
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

test('平行跳失败：摔伤按坑深算', () => {
  // 敏捷 20 → 区值 4，DC 20 → 骰点要 > 16。掷 5 必败。
  // 作者口径：平行跳失败按落差算，不是一律中伤。
  const plan = api.planJump('across', 2, NO, 3); // 坑深 3 格
  const out = api.resolveJump(pc({ 敏捷: 20 }), plan, dice(5, 5));
  assert.equal(out.landed, false);
  assert.equal(plan.injury, 'medium', '3 格落差是中伤');
  assert.ok(out.damage >= 1 && out.damage <= 8, '中伤 1D8');
  assert.match(out.text, /没跳过去/);
});

test('平行跳失败：浅坑轻伤，掉一层重伤', () => {
  assert.equal(api.planJump('across', 2, NO, 1).injury, 'light', '1 格轻伤');
  assert.equal(api.planJump('across', 2, NO, 6).injury, 'heavy', '6 格重伤');
  assert.equal(api.planJump('across', 2, NO, 8).injury, 'heavy', '掉一层 8 格重伤');
  assert.equal(api.planJump('across', 2, NO, 12).injury, 'brutal', '12 格以上 1D20');
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

test('往上失败：没攀住，按已攀的高度摔', () => {
  // 作者口径：往上失败不是掉回原地不摔，是按已攀的高度摔。
  const plan = api.planJump('up', 2, NO);
  assert.equal(plan.injury, 'light', '2 格落差轻伤');
  const out = api.resolveJump(pc({ 力量: 20 }), plan, dice(5, 5), () => 3);
  assert.equal(out.landed, false);
  assert.equal(out.damage, 3);
  assert.match(out.text, /摔下来/);
});

test('往上失败：攀得越高摔得越重', () => {
  assert.equal(api.planJump('up', 2, BOTH).injury, 'light');
  assert.equal(api.planJump('up', 3, BOTH).injury, 'medium');
  assert.equal(api.planJump('up', 6, BOTH).injury, 'heavy');
  assert.equal(api.planJump('up', 12, BOTH).injury, 'brutal');
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
  assert.equal(a.check.dice, 'single');
  assert.equal(a.injury, 'light');

  const b = api.planJump('down', 4, NO);
  assert.equal(b.check.dice, 'disadvantage');
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
  // 第 4 个参数是摔伤骰（1D12），不能拿 D100 顶
  const out = api.resolveJump(pc({}), plan, dice(7), () => 7);
  assert.equal(out.landed, false);
  assert.equal(out.damage, 7);
  assert.match(out.text, /重伤/);
});

test('摔伤骰不能拿 D100 顶：1D12 要均匀分布', () => {
  // 这条防的是「resolveJump 把自己的 D100 塞给 rollInjury」——
  // 那样 1D12 会有 89% 掷出 12。
  const plan = api.planJump('down', 8, NO);
  const counts = {};
  for (let i = 0; i < 4000; i++) {
    const d = api.resolveJump(pc({}), plan).damage;
    counts[d] = (counts[d] || 0) + 1;
  }
  const keys = Object.keys(counts).map(Number);
  assert.equal(keys.length, 12, '1D12 应该 12 个面都出得来，实际只出了 ' + keys.length + ' 个');
  const twelve = counts[12] ?? 0;
  assert.ok(twelve < 4000 * 0.15, `12 出现了 ${twelve} 次，分布不对（均匀应约 333）`);
});

test('往下检定过了：稳稳落地不摔', () => {
  const plan = api.planJump('down', 2, NO);
  const out = api.resolveJump(pc({ 敏捷: 90 }), plan, dice(10, 10));
  assert.equal(out.landed, true);
  assert.equal(out.damage, 0);
  assert.match(out.text, /稳稳落地/);
});

// ---------- 检定算法 ----------

test('区值 = 属性 ÷ 5 向下取整，DC 是 20', () => {
  assert.equal(api.zoneOf({ 敏捷: 47 }, '敏捷'), 9);
  assert.equal(api.zoneOf({ 敏捷: 50 }, '敏捷'), 10);
  assert.equal(api.zoneOf({}, '敏捷'), 0);
});

test('优势取高的那个', () => {
  const p = pc({ 敏捷: 10 }); // 区值 2，DC 20 → 骰点要 ≥ 18
  // 取 17 → 19，差一格
  assert.equal(api.rollJumpCheck(p, { attr: '敏捷', dice: 'advantage', why: '' }, dice(5, 17)).success, false);
  assert.equal(api.rollJumpCheck(p, { attr: '敏捷', dice: 'advantage', why: '' }, dice(17, 5)).success, false);
  // 取 18 → 20，正好到 DC，算过
  assert.equal(api.rollJumpCheck(p, { attr: '敏捷', dice: 'advantage', why: '' }, dice(18, 5)).success, true);
  assert.equal(api.rollJumpCheck(p, { attr: '敏捷', dice: 'advantage', why: '' }, dice(5, 18)).success, true);
});

test('劣势取低的那个', () => {
  const p = pc({ 敏捷: 50 }); // 区值 10，DC 20 → 骰点要 > 10
  assert.equal(api.rollJumpCheck(p, { attr: '敏捷', dice: 'disadvantage', why: '' }, dice(20, 15)).success, true);
  assert.equal(api.rollJumpCheck(p, { attr: '敏捷', dice: 'disadvantage', why: '' }, dice(15, 20)).success, true);
  // 取低 = 2 → 12 ≤ 20，没过
  assert.equal(api.rollJumpCheck(p, { attr: '敏捷', dice: 'disadvantage', why: '' }, dice(20, 2)).success, false);
});

test('极值覆盖总数：掷 20 必过，掷 1 必不过', () => {
  // 区值 0 的人掷 20 也过——大成功不看总数。
  const r = api.rollJumpCheck(pc({ 敏捷: 0 }), { attr: '敏捷', dice: 'single', why: '' }, dice(20));
  assert.equal(r.success, true);
  assert.equal(r.tier, 'crit');
  // 属性再高，掷 1 也是大失败。
  const f = api.rollJumpCheck(pc({ 敏捷: 100 }), { attr: '敏捷', dice: 'single', why: '' }, dice(1));
  assert.equal(f.success, false);
  assert.equal(f.tier, 'fumble');
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
  assert.equal(api.fearCheck('advantage').dice, 'advantage');
  assert.equal(api.fearCheck('normal').dice, 'single');
  assert.equal(api.fearCheck('disadvantage').dice, 'disadvantage');
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

// ---------- 走路时的落差 ----------

test('平地：正常走', () => {
  const d = api.stepDrop(0, 0);
  assert.equal(d.kind, 'flat');
  assert.equal(api.stepDropMultiplier(d), 1);
  assert.equal(api.describeStepDrop(d), '');
});

test('上一格台阶：能走，双倍移动点', () => {
  const d = api.stepDrop(0, 1);
  assert.equal(d.kind, 'stepUp');
  assert.equal(api.stepDropMultiplier(d), 2, '上台阶双倍');
  assert.match(api.describeStepDrop(d), /双倍/);
});

test('往上 2 格：走不上去，要攀跳', () => {
  const d = api.stepDrop(0, 2);
  assert.equal(d.kind, 'climb');
  assert.equal(d.height, 2);
  assert.match(d.reason, /攀跳/);
});

test('往上 5 格：要攀爬', () => {
  const d = api.stepDrop(0, 5);
  assert.equal(d.kind, 'climb');
  assert.equal(d.height, 5);
  assert.match(d.reason, /攀爬/);
});

test('往下 1 格：下台阶，不摔', () => {
  const d = api.stepDrop(1, 0);
  assert.equal(d.kind, 'stepDown');
  assert.equal(d.safe, true, '一格台阶是正常走');
  assert.match(api.describeStepDrop(d), /正常走/);
});

test('往下 2 格：要跳，轻伤', () => {
  const d = api.stepDrop(2, 0);
  assert.equal(d.safe, false);
  assert.equal(d.injury, 'light');
  assert.match(api.describeStepDrop(d), /1D4/);
});

test('往下 8 格：重伤 1D12', () => {
  const d = api.stepDrop(8, 0);
  assert.equal(d.injury, 'heavy');
  assert.match(api.describeStepDrop(d), /1D12/);
});

test('往下 12 格：1D20', () => {
  const d = api.stepDrop(12, 0);
  assert.equal(d.injury, 'brutal');
  assert.match(api.describeStepDrop(d), /1D20/);
});

test('落差从高往低算，负数看不懂就按绝对值', () => {
  assert.equal(api.stepDrop(5, 5).kind, 'flat');
  assert.equal(api.stepDrop(3, 4).kind, 'stepUp');
  assert.equal(api.stepDrop(4, 3).kind, 'stepDown');
});

// ---------- 掉进坑里 ----------

test('同层的坑：深度就是高度差', () => {
  const f = api.pitFall(3, 0);
  assert.equal(f.cells, 3);
  assert.equal(f.nextFloor, false);
  assert.equal(f.injury, 'medium', '3 格是中伤档');
});

test('坑底是空的：掉一层，按挑高 8 格算', () => {
  const f = api.pitFall(5, null);
  assert.equal(f.cells, 8, '一层挑高 8 格');
  assert.equal(f.nextFloor, true);
  assert.equal(f.injury, 'heavy', '8 格落在重伤档');
  assert.match(api.describePitFall(f, 7), /1D12/);
});

test('坑底比脚下高：算 0 格', () => {
  const f = api.pitFall(0, 3);
  assert.equal(f.cells, 0);
  assert.equal(f.injury, 'light');
});

test('掉进坑里的伤害在骰子范围内', () => {
  const f = api.pitFall(8, null); // 1D12
  for (let i = 0; i < 50; i++) {
    const d = api.rollPitFall(f);
    assert.ok(d >= 1 && d <= 12, `掷出 ${d} 越界`);
  }
});

// ---------- 走路撞到坑 ----------

const floorOf = (gapAt) => (x, y) => gapAt.includes(`${x},${y}`) ? 'gap' : 'open';

test('前面能站：正常走', () => {
  const a = api.gapAhead(floorOf([]), { x: 0, y: 0 }, 1, 0);
  assert.equal(a.kind, 'clear');
});

test('坑宽 1 格：直接跳过去，不用掷骰', () => {
  const a = api.gapAhead(floorOf(['1,0']), { x: 0, y: 0 }, 1, 0);
  assert.equal(a.kind, 'gap');
  assert.equal(a.width, 1, '作者口径的「几格」是坑的宽');
  assert.equal(a.landingStep, 2, '落点在往前第 2 格');
  assert.equal(a.landing, true);
  assert.equal(a.check, null, '一格宽不掷骰');
});

test('坑宽 2 格（1.5 米）：要敏捷', () => {
  const a = api.gapAhead(floorOf(['1,0', '2,0']), { x: 0, y: 0 }, 1, 0);
  assert.equal(a.kind, 'gap');
  assert.equal(a.width, 2);
  assert.equal(a.landingStep, 3);
  assert.equal(a.landing, true);
  assert.equal(a.check.attr, '敏捷');
});

test('坑宽 3 格：没【跳远】跳不了', () => {
  const a = api.gapAhead(floorOf(['1,0', '2,0', '3,0']), { x: 0, y: 0 }, 1, 0);
  assert.equal(a.width, 3);
  assert.equal(a.landing, false);
  assert.match(a.reason, /跳远/);
});

test('坑宽 3 格 + 有【跳远】就能跳，掷力量', () => {
  const a = api.gapAhead(floorOf(['1,0', '2,0', '3,0']), { x: 0, y: 0 }, 1, 0, BOTH);
  assert.equal(a.landing, true);
  assert.equal(a.check.attr, '力量');
});

test('后面是墙：跳不过去', () => {
  const a = api.gapAhead((x, y) => y === 0 && x === 1 ? 'gap' : y === 0 && x === 2 ? 'wall' : 'open',
    { x: 0, y: 0 }, 1, 0);
  assert.equal(a.kind, 'gap');
  assert.equal(a.landing, false);
  assert.match(a.reason, /墙/);
});

test('前面直接是墙：不是坑', () => {
  const a = api.gapAhead((x, y) => x === 1 && y === 0 ? 'wall' : 'open', { x: 0, y: 0 }, 1, 0);
  assert.equal(a.kind, 'blocked');
});

test('坑宽超过 3 格就跳不过去', () => {
  const many = ['1,0', '2,0', '3,0', '4,0'];
  const a = api.gapAhead(floorOf(many), { x: 0, y: 0 }, 1, 0);
  assert.equal(a.kind, 'gap');
  assert.equal(a.landing, false);
});

// ---------- 判定流程掷完拿到的点数 ----------

test('judgeValue：单掷只用一颗，优势取高，劣势取低', () => {
  const chk = { attr: '敏捷', dice: 'single', why: '' };
  const pc50 = pc({ 敏捷: 50 }); // 区值 10 → DC 20
  assert.equal(api.judgeValue(chk, pc50, [20]).used, 20);
  assert.equal(api.judgeValue({ ...chk, dice: 'advantage' }, pc50, [8, 20]).used, 20, '优势取高');
  assert.equal(api.judgeValue({ ...chk, dice: 'disadvantage' }, pc50, [20, 8]).used, 8, '劣势取低');
});

test('judgeValue：区值 2 掷 18 正好到 DC，算过', () => {
  const pc10 = pc({ 敏捷: 10 }); // 区值 2
  const r = api.judgeValue({ attr: '敏捷', dice: 'single', why: '' }, pc10, [18]);
  assert.equal(r.dc, 20);
  assert.equal(r.total, 20);
  assert.equal(r.success, true, '到 DC 就算过（≥）');
  assert.equal(api.judgeValue({ attr: '敏捷', dice: 'single', why: '' }, pc10, [17]).success, false);
});

test('judgeValue：D20 区的骰点不会超过 20', () => {
  const r = api.judgeValue({ attr: '敏捷', dice: 'single', why: '' }, pc({ 敏捷: 10 }), [100]);
  assert.equal(r.used, 20, '超过面数的点数要夹到 20');
  assert.equal(r.success, true);
});

test('优势采信的是高的那颗，不是被丢掉的那颗', () => {
  const r = api.judgeValue({ attr: '敏捷', dice: 'advantage', why: '' }, pc({ 敏捷: 50 }), [5, 20]);
  assert.equal(r.used, 20);
  assert.match(api.describeRoll(r), /骰点 5\/20/);
});

// ---------- 技能 ----------

test('运动模块给【攀爬】，别的技能不给', () => {
  assert.equal(api.jumpSkillsOf(['003-9-104']).climb, true);
  assert.equal(api.jumpSkillsOf([]).climb, false);
  assert.equal(api.jumpSkillsOf(['011-9-102']).climb, false);
  assert.equal(api.jumpSkillsOf(['003-9-104']).longJump, false, '运动模块不给跳远');
});

test('有【攀爬】之后，3 格坑还是过不去（那是跳远的事）', () => {
  const withClimb = api.jumpSkillsOf(['003-9-104']);
  const plan = api.planJump('across', 3, withClimb);
  assert.equal(plan.allowed, false, '攀爬管上下，不管横跨');
});

// ---------- 挖坑：负高度 ----------

test('挖坑：地面 0、坑底 -3 → 往下 3 格，会摔', () => {
  const d = api.stepDrop(0, -3);
  assert.equal(d.kind, 'stepDown');
  assert.equal(d.height, 3);
  assert.equal(d.safe, false);
  assert.equal(d.injury, 'medium');
});

test('挖坑：从坑底爬回地面是往上 3 格，要攀', () => {
  const d = api.stepDrop(-3, 0);
  assert.equal(d.kind, 'climb');
  assert.equal(d.height, 3);
});

test('台阶：下一格还是正常走', () => {
  const d = api.stepDrop(1, 0);
  assert.equal(d.kind, 'stepDown');
  assert.equal(d.safe, true);
});

// ---------- 往上攀：分档 ----------

test('往上 2–3 格：掷力量，没【攀爬】就占行动点', () => {
  const two = api.planJump('up', 2, NO);
  assert.equal(two.check.attr, '力量');
  assert.equal(two.usesAction, true, '没攀爬要占行动点');
  assert.equal(two.moveMultiplier, 2);
  const withClimb = api.planJump('up', 2, api.jumpSkillsOf(['003-9-104']));
  assert.equal(withClimb.usesAction, false, '有攀爬就不占行动点');
});

test('往上 4 格：没【攀爬】根本上不去', () => {
  const plan = api.planJump('up', 4, NO);
  assert.equal(plan.allowed, false);
  assert.match(plan.reason, /攀爬/);
});

test('往上 4 格有【攀爬】：掷敏捷，不占行动点', () => {
  const plan = api.planJump('up', 4, api.jumpSkillsOf(['003-9-104']));
  assert.equal(plan.allowed, true);
  assert.equal(plan.check.attr, '敏捷');
  assert.equal(plan.usesAction, false);
});

test('往上 12 格：有【攀爬】也要占行动点', () => {
  const plan = api.planJump('up', 12, api.jumpSkillsOf(['003-9-104']));
  assert.equal(plan.allowed, true);
  assert.equal(plan.usesAction, true, '技能也不能免');
});
