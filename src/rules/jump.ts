// 跳跃：平行跳、往上、往下。
//
// 作者定的口径（2026-11-09 / 11-10）：
//
// 平行跳
// - 1 格：不用检定
// - 2 格（1.5 米）：【敏捷】检定
// - 3 格（2.25 米）：长跳，要【跳远】技能，一般【力量】检定
// - 失败就掉下去——行动做了，该摔得摔。原地不动是意志坚定检定失败，不是这里的事
//
// 往上
// - 1 格：普通移动，双倍移动点
// - 2–3 格：【力量】检定，占行动点；有【攀爬】就不占
// - 4–9 格：必须有【攀爬】，没有根本上不去。【敏捷】检定，不占行动点
// - 12 格以上：有【攀爬】才能爬，但依旧占行动点（技能也不能免）
//
// 往下
// - 没【攀爬】就是跳下去，按落差算摔伤
// - 有【攀爬】可以爬下去，【敏捷】检定
// - 向下攀爬也是双倍移动点消耗
//
// 摔伤：轻伤 1D4、中伤 1D8、重伤 1D12、十二格以上 1D20（作者说：狗屎运的人是有的）
//
// 高度恐惧：往下看和跳上去都算（作者说两样都有）。四档见 height.ts。
import type { PC } from '../core/types';
import { fearTier, fearRollMode, type FearTier } from '../scene/height';

/** 一格多少米。跟 height.ts 保持一致。 */
const CELL_M = 0.75;

/** 默认骰：1..100，100 表示 00。 */
const rollD100 = (): number => { const v = Math.floor(Math.random() * 100); return v === 0 ? 100 : v; };

// ---------- 检定 ----------

export type JumpAttr = '敏捷' | '力量' | '意志';

/** 一个跳跃动作要掷什么。 */
export interface JumpCheck {
  attr: JumpAttr;
  /** 优势掷两次取高，劣势掷两次取低。 */
  mode: 'single' | 'advantage' | 'disadvantage';
  /** 给人看的理由，比如「往下 5 格，劣势敏捷」。 */
  why: string;
}

/** 区值：属性 ÷ 5 向下取整。 */
export function zoneOf(attributes: Record<string, number> | undefined, attr: string): number {
  const v = attributes?.[attr];
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.floor(v / 5);
}

export interface JumpRoll {
  attr: JumpAttr;
  /** 掷出来的点数（优势/劣势各两个）。 */
  rolls: number[];
  /** 门槛（区值 × 10）。 */
  target: number;
  success: boolean;
  mode: 'single' | 'advantage' | 'disadvantage';
}

export function rollJumpCheck(pc: PC, check: JumpCheck, roll?: () => number): JumpRoll {
  const r = roll ?? rollD100;
  const a = r(), b = r();
  const rolls = check.mode === 'single' ? [a] : [a, b];
  const target = zoneOf(pc.attributes, check.attr) * 10;
  // D100 是「掷得越小越好」（掷 ≤ 门槛算过）。
  // 所以优势取小的那个（更有利），劣势取大的那个（更不利）。
  const best = Math.min(...rolls);
  const worst = Math.max(...rolls);
  const used = check.mode === 'advantage' ? best : check.mode === 'disadvantage' ? worst : a;
  // 100（= 00）算特大成功，直接过。
  const success = used === 100 || (target > 0 && used <= target);
  return { attr: check.attr, rolls, target, success, mode: check.mode };
}

export function describeRoll(r: JumpRoll): string {
  const mode = r.mode === 'advantage' ? '优势' : r.mode === 'disadvantage' ? '劣势' : '';
  const dice = r.rolls.join('/');
  const head = `【${r.attr}】${mode}检定 ${dice}（门槛 ${r.target}）`;
  if (!r.success) return `${head}：没过`;
  return r.rolls.includes(100) ? `${head}：特大成功` : `${head}：过了`;
}

// ---------- 摔伤 ----------

export type InjuryTier = 'light' | 'medium' | 'heavy' | 'brutal';

/** 摔伤骰。作者定：轻伤 1D4、中伤 1D8、重伤 1D12、十二格以上 1D20。 */
export const INJURY_DICE: Record<InjuryTier, number> = { light: 4, medium: 8, heavy: 12, brutal: 20 };

export const INJURY_LABEL: Record<InjuryTier, string> = { light: '轻伤', medium: '中伤', heavy: '重伤', brutal: '重伤' };

/** 按落差几格定摔伤档。 */
export function injuryTier(cells: number): InjuryTier {
  const h = Math.abs(cells);
  if (h >= 12) return 'brutal';
  if (h >= 6) return 'heavy';
  if (h >= 3) return 'medium';
  return 'light';
}

/** 掷摔伤伤害。 */
export function rollInjury(tier: InjuryTier, roll?: () => number): number {
  const faces = INJURY_DICE[tier];
  const r = roll ?? (() => Math.floor(Math.random() * faces) + 1);
  return Math.max(1, Math.min(faces, Math.floor(r())));
}

/** 给人看的一句话。 */
export function describeInjury(cells: number, dmg: number): string {
  const tier = injuryTier(cells);
  const m = Math.abs(cells);
  return `从 ${m} 格（${(m * CELL_M).toFixed(2)} 米）摔下来：${INJURY_LABEL[tier]} 1D${INJURY_DICE[tier]}，扣 ${dmg} HP`;
}

// ---------- 动作判定 ----------

/** 会什么。目前只认这三种，技能表补上之前先这样。 */
export interface JumpSkills {
  /** 有没有【攀爬】。 */
  climb: boolean;
  /** 有没有【跳远】。3 格长跳要它。 */
  longJump: boolean;
}

export const NO_JUMP_SKILLS: JumpSkills = { climb: false, longJump: false };

export type JumpKind = 'across' | 'up' | 'down';

export interface JumpPlan {
  kind: JumpKind;
  /** 横向跳几格（across 用）。 */
  distance: number;
  /** 上下落差几格（up/down 用）。 */
  height: number;
  /** 要掷的检定。null = 不用掷。 */
  check: JumpCheck | null;
  /** 要不要占行动点。 */
  usesAction: boolean;
  /** 移动点消耗的倍数（正常 1，往上 1 格和往下爬都是 2）。 */
  moveMultiplier: number;
  /** 有没有【攀爬】/【跳远】。 */
  skills: JumpSkills;
  /** 能不能做；不能的话给个理由。 */
  allowed: boolean;
  reason: string;
  /** 摔伤档。null = 不摔。 */
  injury: InjuryTier | null;
  /** 高度恐惧这一档。 */
  fear: FearTier;
}

/**
 * 算一次跳跃要什么都摆在明面上，先不掷骰。
 * 掷骰和结算在 trial 层做。
 */
export function planJump(kind: JumpKind, cells: number, skills: JumpSkills = NO_JUMP_SKILLS): JumpPlan {
  const n = Math.abs(cells);
  const fear = fearTier(n);
  const base = { kind, distance: kind === 'across' ? n : 0, height: kind === 'across' ? 0 : n, skills, fear,
    injury: null as InjuryTier | null, moveMultiplier: 1, usesAction: false };

  if (kind === 'across') {
    if (n <= 1) return { ...base, check: null, allowed: true, reason: '一格，不用检定' };
    if (n === 2) return { ...base, check: { attr: '敏捷', mode: 'single', why: '两格（1.5 米）' }, allowed: true, reason: '要敏捷检定' };
    if (n === 3) {
      if (!skills.longJump) return { ...base, check: null, allowed: false, reason: '三格是长跳，要有【跳远】技能' };
      return { ...base, check: { attr: '力量', mode: 'single', why: '三格长跳（2.25 米）' }, allowed: true, reason: '长跳，力量检定' };
    }
    return { ...base, check: null, allowed: false, reason: `四格以上跳不过去（${(n * CELL_M).toFixed(2)} 米）` };
  }

  if (kind === 'up') {
    if (n <= 1) return { ...base, check: null, allowed: true, reason: '一格：普通移动，双倍消耗', moveMultiplier: 2 };
    if (n <= 3) {
      // 2–3 格：攀跳。有【攀爬】就不占行动点。
      return { ...base, check: { attr: '力量', mode: 'single', why: `往上 ${n} 格` },
        allowed: true, usesAction: !skills.climb, moveMultiplier: 2,
        reason: skills.climb ? '攀跳，有【攀爬】不占行动点' : '攀跳，要【力量】，占行动点' };
    }
    if (!skills.climb) {
      return { ...base, check: null, allowed: false, reason: `往上 ${n} 格要【攀爬】技能，没有就上不去` };
    }
    if (n >= 12) {
      // 12 格以上：有【攀爬】才能爬，但依旧占行动点。
      return { ...base, check: { attr: '敏捷', mode: 'single', why: `攀爬 ${n} 格` },
        allowed: true, usesAction: true, moveMultiplier: 2,
        reason: `爬到 ${n} 格这么高，就算有【攀爬】也占行动点` };
    }
    return { ...base, check: { attr: '敏捷', mode: 'single', why: `攀爬 ${n} 格` },
      allowed: true, usesAction: false, moveMultiplier: 2, reason: '攀爬，有【攀爬】不占行动点' };
  }

  // 往下
  if (skills.climb) {
    // 有【攀爬】就爬下去，不用摔。12 格以上依旧占行动点。
    return { ...base, check: { attr: '敏捷', mode: 'single', why: `往下爬 ${n} 格` },
      allowed: true, usesAction: n >= 12, moveMultiplier: 2,
      reason: n >= 12 ? `往下爬 ${n} 格，太高了，占行动点` : '往下爬，有【攀爬】不占行动点' };
  }
  // 没技能就是跳下去：≤5 格掷敏捷，6 格以上必摔。
  const tier = injuryTier(n);
  const check: JumpCheck | null = n <= 2 ? { attr: '敏捷', mode: 'single', why: `往下 ${n} 格` }
    : n <= 5 ? { attr: '敏捷', mode: 'disadvantage', why: `往下 ${n} 格` }
    : null;
  return { ...base, check, allowed: true, usesAction: n >= 12, moveMultiplier: 1,
    injury: tier, reason: check ? `跳下去，${n} 格` : `往下 ${n} 格：必摔` };
}

/** 跳完的结果，给见证者看。 */
export interface JumpOutcome {
  plan: JumpPlan;
  /** 检定结果。不用掷就是 null。 */
  roll: JumpRoll | null;
  /** 成功落地了吗。 */
  landed: boolean;
  /** 扣多少 HP。没摔就是 0。 */
  damage: number;
  fear: FearTier;
  text: string;
}

/**
 * 真的跳一次。
 * - 检定没过 = 没跳过去，掉下去，按落差摔
 * - 没有检定、但落差够大（6 格以上）= 必摔
 */
/**
 * @param roll 检定骰，返回 1–100（D100）
 * @param injuryRoll 摔伤骰，返回 1–面数。**不能拿 D100 当摔伤骰**：
 *   1D4 用 D100 掷会有 97% 掷出 4。不传就用各面数的默认骰。
 */
export function resolveJump(pc: PC, plan: JumpPlan, roll?: () => number, injuryRoll?: () => number): JumpOutcome {
  const r = roll ?? rollD100;
  const check = plan.check ? rollJumpCheck(pc, plan.check, r) : null;

  let landed: boolean;
  let damage = 0;
  let text: string;

  if (plan.kind === 'across') {
    landed = check === null || check.success;
    if (!landed) {
      // 平行跳失败：掉进空隙。按落差算——空隙按掉落算，至少中伤。
      const tier: InjuryTier = 'medium';
      damage = rollInjury(tier, injuryRoll);
      text = `${describeRoll(check!)}。没跳过去，掉下去了：${INJURY_LABEL[tier]} 1D${INJURY_DICE[tier]}，扣 ${damage} HP`;
    } else {
      text = check ? `${describeRoll(check)}。跳过去了` : '一格，直接过去了';
    }
    return { plan, roll: check, landed, damage, fear: plan.fear, text };
  }

  if (plan.kind === 'up') {
    landed = check === null || check.success;
    if (!landed) {
      // 攀跳没过就是没上去，停在原地不摔（往上失败掉回原处）。
      text = `${describeRoll(check!)}。没攀上去，掉回原地`;
      landed = false;
    } else {
      text = check ? `${describeRoll(check)}。上去了` : '一格，直接上去';
    }
    return { plan, roll: check, landed, damage, fear: plan.fear, text };
  }

  // 往下
  if (plan.injury === null) {
    // 有【攀爬】：爬下去，没过就是摔。
    landed = check === null || check.success;
    if (!landed) {
      const tier = injuryTier(plan.height);
      damage = rollInjury(tier, injuryRoll);
      text = `${describeRoll(check!)}。手滑了：${INJURY_LABEL[tier]} 1D${INJURY_DICE[tier]}，扣 ${damage} HP`;
    } else {
      text = `${describeRoll(check!)}。爬下来了`;
    }
    return { plan, roll: check, landed, damage, fear: plan.fear, text };
  }

  // 没技能跳下去
  const tier = plan.injury;
  if (check === null || !check.success) {
    damage = rollInjury(tier, injuryRoll);
    landed = false;
    text = check
      ? `${describeRoll(check)}。没稳住，${describeInjury(plan.height, damage)}`
      : `${describeInjury(plan.height, damage)}`;
  } else {
    // 检定过了：安全落地，不摔。
    landed = true;
    text = `${describeRoll(check)}。稳稳落地，没摔`;
  }
  return { plan, roll: check, landed, damage, fear: plan.fear, text };
}

/** 高度恐惧要不要单独过。跟跳跃成败无关，是心理层面的事。 */
export function fearCheck(fear: FearTier): JumpCheck | null {
  if (fear === 'none') return null;
  return { attr: '意志', mode: fearRollMode(fear) === 'advantage' ? 'advantage'
    : fearRollMode(fear) === 'disadvantage' ? 'disadvantage' : 'single', why: '高度恐惧' };
}

export { fearTier };

// ---------- 走路时的落差检查 ----------

/** 走一格时，落差是什么情况。 */
export type StepDrop =
  | { kind: 'flat' }
  /** 上一格台阶：能走，双倍移动点。 */
  | { kind: 'stepUp'; height: number }
  /** 往下走。一格的台阶是正常下台阶（safe），再高就是跳下去，会摔。 */
  | { kind: 'stepDown'; height: number; injury: InjuryTier; safe: boolean }
  /** 高差太大，走不过去：得用【攀跳】或【攀爬】，或者跳下去。 */
  | { kind: 'blocked'; reason: string };

/**
 * 判断走向目标格时的高度情况。
 *
 * 作者口径：
 * - 往上 1 格：普通移动，双倍移动点
 * - 往上 2 格以上：要【攀跳】（2–3 格）或【攀爬】（4 格以上），一步走不上去
 * - 往下：一步台阶直接下，再高就要跳，会摔
 */
export function stepDrop(fromHeight: number, toHeight: number): StepDrop {
  const diff = toHeight - fromHeight;
  if (diff === 0) return { kind: 'flat' };
  if (diff === 1) return { kind: 'stepUp', height: 1 };
  if (diff > 1) {
    const need = diff <= 3 ? '【攀跳】' : '【攀爬】';
    return { kind: 'blocked', reason: `这里比脚下高 ${diff} 格（${(diff * CELL_M).toFixed(2)} 米），得用${need}上去` };
  }
  // 往下
  const drop = -diff;
  // 下 1 格就是走下台阶，不该摔；再往下才是跳下去。
  if (drop === 1) return { kind: 'stepDown', height: 1, injury: 'light', safe: true };
  if (drop <= 2) return { kind: 'stepDown', height: drop, injury: 'light', safe: false };
  return { kind: 'stepDown', height: drop, injury: injuryTier(drop), safe: false };
}

/** 走这一格要花的移动点数倍数：上台阶双倍。 */
export function stepDropMultiplier(d: StepDrop): number {
  return d.kind === 'stepUp' ? 2 : 1;
}

/** 给人看的说明。 */
export function describeStepDrop(d: StepDrop): string {
  if (d.kind === 'flat') return '';
  if (d.kind === 'stepUp') return '上一步台阶，双倍移动点';
  if (d.kind === 'stepDown') return d.safe
    ? '下一步台阶，正常走'
    : `往下 ${d.height} 格（${(d.height * CELL_M).toFixed(2)} 米），得跳下去——会摔：${INJURY_LABEL[d.injury]} 1D${INJURY_DICE[d.injury]}`;
  return d.reason;
}

// ---------- 掉进坑里 ----------

/**
 * 坑的深度：脚下的高度减去坑底的高度。
 *
 * 作者口径：
 * - 同层的坑：深度就是高度差
 * - 坑底是空的（楼间空隙）：掉一层，按挑高 8 格算
 */
export const FALL_TO_NEXT_FLOOR = 8;

export type PitFall = {
  /** 掉多少格。 */
  cells: number;
  /** 是不是掉到了下一层。 */
  nextFloor: boolean;
  /** 摔伤档。 */
  injury: InjuryTier;
};

/**
 * 算掉进坑里摔多少。
 * @param fromHeight 脚下那一格的高度
 * @param bottomHeight 坑底的高度；null 表示坑底是空的，掉到下一层
 */
export function pitFall(fromHeight: number, bottomHeight: number | null): PitFall {
  if (bottomHeight === null) {
    return { cells: FALL_TO_NEXT_FLOOR, nextFloor: true, injury: injuryTier(FALL_TO_NEXT_FLOOR) };
  }
  const cells = Math.max(0, fromHeight - bottomHeight);
  return { cells, nextFloor: false, injury: injuryTier(cells) };
}

/** 掉进坑里，掷一次伤害。roll 是摔伤骰（1–面数），不是 D100。 */
export function rollPitFall(fall: PitFall, roll?: () => number): number {
  return rollInjury(fall.injury, roll);
}

/** 给人看的一句话。 */
export function describePitFall(fall: PitFall, dmg: number): string {
  const m = (fall.cells * CELL_M).toFixed(2);
  const where = fall.nextFloor ? `掉到下一层（挑高 ${fall.cells} 格，${m} 米）` : `掉进 ${fall.cells} 格的坑（${m} 米）`;
  return `${where}：${INJURY_LABEL[fall.injury]} 1D${INJURY_DICE[fall.injury]}，扣 ${dmg} HP`;
}

// ---------- 走路撞到坑 ----------

export type GapAhead =
  /** 前面能站，正常走。 */
  | { kind: 'clear' }
  /** 前面是堵，跳不过去。 */
  | { kind: 'blocked'; by: 'wall' }
  /** 前面是坑。 */
  | {
      kind: 'gap';
      /** 坑有多宽：连着几格。作者口径的「跳几格」说的是这个宽度。 */
      width: number;
      /** 落点在往前第几格（= 宽度 + 1）。 */
      landingStep: number;
      /** 要掷的检定；null = 不用掷。 */
      check: JumpCheck | null;
      /** 落点能不能站；不能就是跳不过去。 */
      landing: boolean;
      skills: JumpSkills;
      reason: string;
    };

/**
 * 往 (dx, dy) 方向走一格时，前面到底是什么。
 *
 * @param floor 问「这一格能不能站」：'open' 能站 / 'wall' 跳不过去 / 'gap' 是坑
 * @param heightOf 问某格的高度，用来算落点落差
 */
export function gapAhead(
  floor: (x: number, y: number) => 'open' | 'wall' | 'gap',
  from: { x: number; y: number }, dx: number, dy: number,
  skills: JumpSkills = NO_JUMP_SKILLS,
): GapAhead {
  const first = floor(from.x + dx, from.y + dy);
  if (first === 'open') return { kind: 'clear' };
  if (first === 'wall') return { kind: 'blocked', by: 'wall' };

  // 一格是坑：往后数它有多宽，再往后找落点。
  // 作者口径：平行跳说的「几格」是坑的宽，不是起跳到落点的距离。
  let width = 0;
  for (let n = 1; n <= 5; n++) {
    const f = floor(from.x + dx * n, from.y + dy * n);
    if (f === 'gap') { width++; continue; }
    const landingStep = n;
    if (f === 'wall') {
      return { kind: 'gap', width, landingStep, check: null, landing: false, skills,
        reason: `前面 ${width} 格坑，再往后是墙，跳不过去` };
    }
    const plan = planJump('across', width, skills);
    return { kind: 'gap', width, landingStep, check: plan.check, landing: plan.allowed, skills, reason: plan.reason };
  }
  return { kind: 'gap', width, landingStep: 0, check: null, landing: false, skills, reason: '前面坑太多，跳不过去' };
}
