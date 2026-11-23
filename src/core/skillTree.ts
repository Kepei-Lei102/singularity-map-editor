// 玩家端的技能分组：只吃公开投影 PublicSkill，不碰完整技能库。
import type { PublicSkill } from './types';

export interface PublicSkillGroup {
  name: string;
  skills: PublicSkill[];
}

export interface PublicSkillTreePathway {
  pathway: string;
  groups: PublicSkillGroup[];
}

/** 按途径 → 技能组分组，保留收到的顺序；同一 id 不会重复发，这里不做额外去重。 */
export function groupPublicSkills(skills: readonly PublicSkill[]): PublicSkillTreePathway[] {
  const byPath = new Map<string, Map<string, PublicSkill[]>>();
  for (const s of skills) {
    const groups = byPath.get(s.pathway) ?? new Map<string, PublicSkill[]>();
    const list = groups.get(s.group) ?? [];
    list.push(s);
    groups.set(s.group, list);
    byPath.set(s.pathway, groups);
  }
  return [...byPath.entries()].map(([pathway, groups]) => ({
    pathway,
    groups: [...groups.entries()].map(([name, list]) => ({ name, skills: list })),
  }));
}
