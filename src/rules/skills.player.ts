// 玩家构建用的技能投影桩：玩家端不显示技能库，也不需要完整 SKILL_LIBRARY。
// 主持端的 send(world) 会做投影；玩家端永远不走到那条分支。
import type { PC, PublicSkill } from '../core/types';

export function publicSkillsOf(_ids: readonly string[]): PublicSkill[] {
  return [];
}

export function currentPathwayOf(_pc: Pick<PC, 'skills' | 'pathway'>): string | null {
  return null;
}
