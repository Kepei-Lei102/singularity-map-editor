// 移动力：心理移动和物理移动两套。
//
// 作者的口径：
// - 心理移动 = 375 + 0.4×智慧 + 0.3×观察 + 0.3×魅力，每 75 点 1 格
// - 物理移动 = 375 + 0.4×敏捷 + 0.3×力量 + 0.3×意志
// - 身高：1.5 米起步，超出的厘米数直接折进移动值。180cm 就是 +30
// - 性别：女性心理移动 +25
// - 阈值：移动力超 25，3 回合蓄 1 格；超 38，2 回合蓄 1 格。用完才能重新蓄
//
// 基准 375 正好 5 格，跟老的 MOVE_PER_TURN 对得上。
//
// 关于属性取值范围（0–100，官方属性测试口径）：
// - 普通人大概在 45–55 那一档，算下来移动值 425 上下，正常走 5 格
// - 80 以上是特种兵、职业运动员那一档，不是随便堆堆就能到的
// - 所以按三倍消耗趴着爬，普通人就是 1 格，只有身体素质极好的人能摸到 2 格
import type { PC, Sex } from '../core/types';

/** 每多少点移动值换 1 格。 */
export const POINTS_PER_CELL = 75;
/** 心理移动的基准值：正好 5 格。 */
export const BASE_MOVE = 375;
/** 身高的起步高度，超过的部分才加。 */
export const BASE_HEIGHT_CM = 150;
/** 女性在心理移动上的加成。 */
export const FEMALE_MENTAL_BONUS = 25;

export type MoveKind = 'mental' | 'physical';

export interface MoveBudget {
  kind: MoveKind;
  /** 算出来的移动值，没取整。 */
  value: number;
  /** 能走几格（向下取整）。 */
  cells: number;
  /** 差多少点够下一格，方便调参时看。 */
  toNext: number;
  /** 各个加成的明细，方便在界面上解释为什么是这个数。 */
  parts: { label: string; points: number }[];
  /** 蓄力门槛：达到才有额外移动格。没有就是 null。
   *  按每回合蓄多少来算，而不是数回合数——超出越多蓄得越快。 */
  charge: { perRound: number; rounds: number } | null;
}

const num = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const attr = (pc: PC, name: string) => num(pc.attributes?.[name]);

/** 身高的移动值加成：1.5 米以后每 1 厘米 1 点。 */
export function heightBonus(heightCm: number | undefined): number {
  if (typeof heightCm !== 'number' || !Number.isFinite(heightCm)) return 0;
  return Math.max(0, Math.round(heightCm - BASE_HEIGHT_CM));
}

/**
 * 算一次移动力。
 * kind 没说就按物理算——现实里走路靠的是身体。
 */
export function moveBudget(pc: PC, kind: MoveKind = 'physical'): MoveBudget {
  const parts: { label: string; points: number }[] = [{ label: '基准', points: BASE_MOVE }];
  let value = BASE_MOVE;

  if (kind === 'mental') {
    const zhi = attr(pc, '智慧') * 0.4;
    const guan = attr(pc, '观察') * 0.3;
    const mei = attr(pc, '魅力') * 0.3;
    parts.push({ label: '智慧 ×0.4', points: zhi }, { label: '观察 ×0.3', points: guan }, { label: '魅力 ×0.3', points: mei });
    value += zhi + guan + mei;
    if (pc.sex === '女') {
      parts.push({ label: '女性心理移动', points: FEMALE_MENTAL_BONUS });
      value += FEMALE_MENTAL_BONUS;
    }
  } else {
    const min = attr(pc, '敏捷') * 0.4;
    const li = attr(pc, '力量') * 0.3;
    const zhi = attr(pc, '意志') * 0.3;
    parts.push({ label: '敏捷 ×0.4', points: min }, { label: '力量 ×0.3', points: li }, { label: '意志 ×0.3', points: zhi });
    value += min + li + zhi;
  }

  // 身高只补物理移动：个子高迈得远，跟脑子转得快不快没关系。
  if (kind === 'physical') {
    const hb = heightBonus(pc.heightCm);
    if (hb) {
      parts.push({ label: `身高 ${pc.heightCm}cm`, points: hb });
      value += hb;
    }
  }

  // 蓄力按「超出基准多少点」分档：
  //   25–37 每回合蓄 1/3 格（3 回合满 1 格）
  //   38–74 每回合蓄 1/2 格（2 回合满 1 格）
  //   其他不额外算，太多了反而复杂
  const over = value - BASE_MOVE;
  const charge = over >= 38 && over < 75 ? { perRound: 1 / 2, rounds: 2 }
    : over >= 25 && over < 38 ? { perRound: 1 / 3, rounds: 3 }
    : null;

  const cells = Math.floor(value / POINTS_PER_CELL);
  return { kind, value, cells, toNext: (cells + 1) * POINTS_PER_CELL - value, parts, charge };
}

/** 这一回合能走多少格。没有额外蓄力就是预算本身。 */
export function cellsThisTurn(b: MoveBudget, stored = 0): number {
  return b.cells + Math.max(0, stored);
}

/**
 * 蓄力进度。progress 是「已经蓄了多少格」，用小数记：
 * 超出 25–37 的人每回合 +1/3，超出 38–74 的人每回合 +1/2。
 * 攒到 1 就多一格，花掉之后重新蓄。
 */
export interface ChargeState { progress: number; cells: number }

/** 蓄力最多攒一格。作者口径：「上限就是 1，最多只能一格充能」。 */
export const MAX_CHARGE_CELLS = 1;

export function tickCharge(b: MoveBudget, s: ChargeState): ChargeState {
  if (!b.charge) return s;
  // 已经满格就不再蓄了，免得越积越多。
  if (s.cells >= MAX_CHARGE_CELLS) return { progress: 0, cells: MAX_CHARGE_CELLS };
  // 每回合最多蓄 1 格，多出来的丢掉，不然小数会越积越多。
  const progress = Math.min(1, s.progress + b.charge.perRound);
  if (progress >= 1 - 1e-9) return { progress: 0, cells: Math.min(MAX_CHARGE_CELLS, s.cells + 1) };
  return { progress, cells: s.cells };
}

/** 用掉一格蓄力。用完之后重新从 0 蓄。 */
export function spendCharge(s: ChargeState): ChargeState {
  return { progress: 0, cells: Math.max(0, Math.min(MAX_CHARGE_CELLS, s.cells) - 1) };
}

/** 性别没填时按默认身高算。 */
export const DEFAULT_HEIGHT: Record<Sex, number> = { 男: 170, 女: 160, 其他: 170 };

/** 一个角色实际用的身高。 */
export function heightOf(pc: PC): number {
  return typeof pc.heightCm === 'number' ? pc.heightCm : DEFAULT_HEIGHT[pc.sex ?? '其他'];
}

/** 梦境层用心理移动，其它层用物理移动。 */
export function moveKindOfLayer(layer: string): MoveKind {
  return layer === '梦境' ? 'mental' : 'physical';
}

/** 这张图上的角色这一回合的移动预算。 */
export function moveBudgetOn(pc: PC, layer: string): MoveBudget {
  return moveBudget(pc, moveKindOfLayer(layer));
}

// ---------- 跑步三档 ----------

/**
 * 三档速度。作者口径：
 * - 慢跑：1.5 倍，不耗 ME，不限拐弯，不占行动点
 * - 奔跑：2 倍，耗 1 ME，整回合只能拐一次弯，占行动点
 * - 爆跑：3 倍，耗 1 ME，不能拐弯，占行动点（能解锁的职业很少）
 */
export type RunMode = 'jog' | 'run' | 'sprint';

export interface RunSpec {
  mode: RunMode;
  label: string;
  /** 移动力倍数。 */
  speed: number;
  /** 耗多少 ME。 */
  meCost: number;
  /** 整个回合最多拐几次弯。null = 不限。 */
  turns: number | null;
  /** 占不占行动点。 */
  usesAction: boolean;
}

export const RUN_MODES: Record<RunMode, RunSpec> = {
  jog: { mode: 'jog', label: '慢跑', speed: 1.5, meCost: 0, turns: null, usesAction: false },
  run: { mode: 'run', label: '奔跑', speed: 2, meCost: 1, turns: 1, usesAction: true },
  sprint: { mode: 'sprint', label: '爆跑', speed: 3, meCost: 1, turns: 0, usesAction: true },
};

/**
 * 这一刻的移动额度，单位是细分格（1 主格 = 3）。
 *
 * 算法是「对移动点数做运算，再除以 75 取整」——不是先取格数再乘倍数。
 * 425 点的人慢跑 1.5 倍：425×1.5 = 637.5 → ÷75 = 8.5 → 8 格。
 * 旧算法先取 5 格再乘 1.5 得 7.5 格，少给了一点。作者定的是这个算法。
 */
export function runAllowance(b: MoveBudget, spec: RunSpec, stored = 0): number {
  // 蓄好的额外格是「已经拿到手的格子」，不参与倍数缩放，直接加在后面。
  const points = (b.value * spec.speed) / POINTS_PER_CELL + stored;
  return Math.floor(points) * 3;
}

/**
 * 趴着爬的额度：移动点数除以 3，再除以 75 取整。
 * 普通人 425 点 → 141.7 → 1.89 格 → 1 格。
 * 敏捷堆到特种兵级别（80+）的人才能摸到 2 格。
 */
export const CRAWL_DIVISOR = 3;

export function crawlAllowance(b: MoveBudget, stored = 0): number {
  const points = b.value / CRAWL_DIVISOR / POINTS_PER_CELL + stored;
  return Math.floor(points) * 3;
}

/** 跑起来还能不能拐这个弯。 */
export function canTurn(spec: RunSpec, turnedSoFar: number): boolean {
  if (spec.turns === null) return true;
  return turnedSoFar < spec.turns;
}

/** 这一档跑起来，ME 够不够。null 表示角色没填 ME，不拦。 */
export function runMeShort(pc: PC, spec: RunSpec): boolean {
  if (spec.meCost <= 0) return false;
  if (pc.me == null) return false;
  return pc.me < spec.meCost;
}

// ---------- 走一格要花多少移动点数 ----------

/** 起身要花的移动点数（作者定：普通人 445 点的话接近一半）。 */
export const STAND_UP_COST = 150;
/** 从躺翻身到趴要花的移动点数。 */
export const ROLL_OVER_COST = 75;

/**
 * 走一格（主格）要扣多少移动点数。
 *
 * 正常走一格 75 点（就是一格的价钱）；跑步换成「消耗更慢的系数」：
 * 慢跑 75÷1.5 = 50，奔跑 75÷2 = 37.5，爆跑 75÷3 = 25。
 * 趴着爬反过来，三倍消耗：75×3 = 225。
 *
 * 作者的口径是「能用点数算就用点数算」，所以跑步也走这条路，
 * 不再单算一个额度再比步数。
 */
export function stepPrice(mode: RunMode | null, prone: boolean): number {
  if (prone) return POINTS_PER_CELL * CRAWL_DIVISOR;
  if (!mode) return POINTS_PER_CELL;
  return POINTS_PER_CELL / RUN_MODES[mode].speed;
}

/** 这点移动点数还够不够走一格。 */
export function canAffordStep(pointsLeft: number, price: number): boolean {
  return pointsLeft >= price - 1e-9;
}

/**
 * 回合开始时的移动点数池。
 * 就是角色的移动值，加上已经蓄好的额外格换成点数。
 */
export function movePool(b: MoveBudget | null, storedCells = 0): number {
  if (!b) return POINTS_PER_CELL * 5; // 没角色卡：老口径 5 格
  return b.value + storedCells * POINTS_PER_CELL;
}
