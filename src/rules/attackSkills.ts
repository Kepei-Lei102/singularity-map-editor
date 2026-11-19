// 攻击技能：007-9-004 全力攻击 / 007-9-203 灵巧攻击 的随机效果表，
// 以及 009-9-003 眩晕打击（被动）的触发口径。这里只做纯函数，改棋子/事件在 runtime/trial.ts。
import type { TokenStatus } from '../core/types';
import { randomDie, type Roller } from './combat';

export type AttackSkillId = '007-9-004' | '007-9-203';
export type AttackRider = '暴击' | '流血' | '去除武器' | '眩晕' | '降智' | '恐惧';
export type WeaknessKind = 'physical' | 'psychological';

export interface AttackSkillDef {
  id: AttackSkillId;
  name: string;
  me: number;
  /** 这类效果吃哪种已知弱点：007 吃物理，灵巧吃心理。 */
  weakness: WeaknessKind;
  effects: readonly AttackRider[];
}

export const ATTACK_SKILLS: readonly AttackSkillDef[] = [
  { id: '007-9-004', name: '全力攻击', me: 1, weakness: 'physical', effects: ['暴击', '流血', '去除武器'] },
  { id: '007-9-203', name: '灵巧攻击', me: 1, weakness: 'psychological', effects: ['眩晕', '降智', '恐惧'] },
];

export const STUN_PASSIVE_ID = '009-9-003';
/** 近战伤害骰最大面：现在伤害骰统一是 D8。 */
export const STUN_MAX_DIE = 8;
/** 打已经眩晕的人：伤害骰颗数 ×5。 */
export const STUN_PUNISH_MULTIPLIER = 5;

export const attackSkillById = (id: string | null | undefined): AttackSkillDef | undefined =>
  ATTACK_SKILLS.find((s) => s.id === id);

export const isAttackSkillId = (id: string | null | undefined): id is AttackSkillId =>
  !!attackSkillById(id);

/** 这轮随机到几种：不知道弱点 1 种，知道 2 种；不能重复。 */
export function riderEffectCount(skillId: AttackSkillId, weaknessKnown: boolean): number {
  const def = attackSkillById(skillId)!;
  return weaknessKnown && def.effects.length > 1 ? 2 : 1;
}

/** 从技能表里随机抽不重复的效果；roller 返回 1..sides，测试可以直接喂固定值。 */
export function pickRiderEffects(
  skillId: AttackSkillId, weaknessKnown: boolean, roller: Roller = randomDie,
): AttackRider[] {
  const pool = [...attackSkillById(skillId)!.effects];
  const out: AttackRider[] = [];
  const want = riderEffectCount(skillId, weaknessKnown);
  while (out.length < want && pool.length) {
    const i = Math.max(0, Math.min(pool.length - 1, roller(pool.length) - 1));
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

/** 009-9-003：伤害骰出 8，或已知物理弱点且命中，就带一回合眩晕。 */
export function passiveStunTriggers(opts: {
  hit: boolean;
  damageRolls: readonly number[];
  physicalWeaknessKnown?: boolean;
}): boolean {
  if (!opts.hit) return false;
  return opts.damageRolls.includes(STUN_MAX_DIE) || !!opts.physicalWeaknessKnown;
}

/** 目标已经被眩晕时，这一击的伤害骰颗数倍率。 */
export const stunnedDamageDiceMultiplier = (targetStatusLabel: string | undefined): number =>
  targetStatusLabel === '眩晕' ? STUN_PUNISH_MULTIPLIER : 1;

/** 把“状态类”效果翻成 TokenStatus；暴击/降智不是状态，返回 null。 */
export function riderStatus(effect: AttackRider): TokenStatus | null {
  switch (effect) {
    case '流血': return { label: '流血', roundsLeft: 1, damageDie: 6, damageTarget: 'hp', blocksAction: false };
    case '眩晕': return { label: '眩晕', skipTurns: 1, blocksAction: true };
    case '恐惧': return { label: '恐惧', roundsLeft: 1, blocksAction: true };
    case '去除武器': return { label: '去除武器', roundsLeft: 1, blocksAction: false };
    default: return null;
  }
}

/** 技能名给事件卡片用。 */
export const attackSkillName = (id: string | null | undefined): string | null =>
  attackSkillById(id)?.name ?? null;
