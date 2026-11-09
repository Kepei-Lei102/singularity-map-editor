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

export function tickCharge(b: MoveBudget, s: ChargeState): ChargeState {
  if (!b.charge) return s;
  // 每回合最多蓄 1 格，多出来的丢掉，不然小数会越积越多。
  const progress = Math.min(1, s.progress + b.charge.perRound);
  if (progress >= 1 - 1e-9) return { progress: 0, cells: s.cells + 1 };
  return { progress, cells: s.cells };
}

/** 用掉一格蓄力。用完之后重新从 0 蓄。 */
export function spendCharge(s: ChargeState): ChargeState {
  return { progress: 0, cells: Math.max(0, s.cells - 1) };
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
