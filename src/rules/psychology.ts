// 心理弱点与 ME 真伤：纯规则，不碰世界。
//
// 作者口径（2026-11-25）：
// - 心理真伤不单独成一个动作，只挂在已有动作（嘴炮/群嘲）命中之后。
// - 知道弱点：1D8 ME；不知道：1D4 ME。没写「限一次」的可以反复打。
// - 技能文本自己写「限一次」的，由技能层单独限制，不在这个基础函数里拦。
import type { Token } from '../core/types';
import { randomDie, type Roller } from './combat';

/** 第一包只开放原文里能直接用的两个「仅见证者裁决」动作。 */
export const PSYCH_ACTION_IDS = ['38', '149'] as const;
export type PsychActionId = (typeof PSYCH_ACTION_IDS)[number];

const ID_SET = new Set<string>(PSYCH_ACTION_IDS);
export const isPsychActionId = (id: string | null | undefined): id is PsychActionId => !!id && ID_SET.has(id);
export const psychActionName = (id: PsychActionId): string => ({ '38': '嘴炮', '149': '群嘲' })[id];

/** 观察者是不是知道目标的心理弱点。PC 用 pcId，NPC 用 tokenId。 */
export function knowsPsychologicalWeakness(
  target: Pick<Token, 'weakness' | 'weaknessKnownBy'>,
  observerId: string | null | undefined,
): boolean {
  if (!observerId || !target.weakness?.psychological) return false;
  return !!target.weaknessKnownBy?.[observerId]?.psychological;
}

/** 已知弱点打 1D8，不知道打 1D4。 */
export const psychDamageDie = (known: boolean): 8 | 4 => (known ? 8 : 4);

/** 可反复调用：没有全局「每场一次」的闸。 */
export function rollPsychDamage(known: boolean, roller: Roller = randomDie): number {
  return roller(psychDamageDie(known));
}
