// 技能：随编辑器走的数据（玩家说明是公开的，实现细节留在私有侧）。
// 一个技能可以反复调用，ME 消耗按卡走；locked 由角色自己的已解锁列表决定。

import type { CheckSpec } from './interaction';

export interface SkillDef {
  id: string; // 技能序号，例如 037-9-101
  name: string; // 【冥想】
  pathway: string; // 金手指途径
  group: string; // 技能组（借动作分类：医疗·调养）
  sequence: number; // 序列
  me: number; // ME 消耗：技能动作默认 1
  desc: string; // 玩家说明（可公开）
  check?: CheckSpec; // 判定口径；没有就按动作卡
  actionId?: string; // 指向公共动作卡；现在是空，等 actions.json
}

/** Ian 的 4 条（动作库解锁明细 037-9-*）。密档里还有 2 条，等拿到再补。 */
export const SKILL_LIBRARY: SkillDef[] = [
  { id: '037-9-101', name: '冥想', pathway: '金手指途径', group: '医疗·调养', sequence: 9, me: 1, desc: '静坐收敛心神，把杂念清出去；恢复类的入口。' },
  { id: '037-9-102', name: '以慢制快', pathway: '金手指途径', group: '战斗·兵器', sequence: 9, me: 1, desc: '后发先至：让对方先动，再把它的节奏打断。' },
  { id: '037-9-003', name: '定式回响', pathway: '金手指途径', group: '技术·骇入', sequence: 9, me: 1, desc: '把见过的局面当成定式调出来，重复推演一遍。' },
  { id: '037-9-201', name: '长考', pathway: '金手指途径', group: '知识·技艺', sequence: 9, me: 1, desc: '花时间把整盘读完，换一次更稳的判断。' },
];

export interface SkillGroup {
  pathway: string;
  groups: { name: string; skills: SkillDef[] }[];
}

/** 一级：途径 → 二级：技能组。锁定技能不进这一层。 */
export function groupSkills(skills: SkillDef[], unlocked?: Set<string>, opts: { levelUp?: boolean } = {}): SkillGroup[] {
  const visible = skills.filter((s) => !unlocked || unlocked.has(s.id) || opts.levelUp);
  const byPath = new Map<string, Map<string, SkillDef[]>>();
  for (const s of visible) {
    const groups = byPath.get(s.pathway) ?? new Map<string, SkillDef[]>();
    const list = groups.get(s.group) ?? [];
    list.push(s);
    groups.set(s.group, list);
    byPath.set(s.pathway, groups);
  }
  return [...byPath.entries()].map(([pathway, groups]) => ({
    pathway,
    groups: [...groups.entries()].map(([name, list]) => ({ name, skills: list.sort((a, b) => a.name.localeCompare(b.name, 'zh')) })),
  }));
}

/** 搜索：名字、组名、说明都能命中。锁定的只在升级视图里出现。 */
export function filterSkills(skills: SkillDef[], q: string, unlocked?: Set<string>, opts: { levelUp?: boolean } = {}): SkillDef[] {
  const needle = q.trim();
  const pool = skills.filter((s) => !unlocked || unlocked.has(s.id) || opts.levelUp);
  if (!needle) return pool;
  return pool.filter((s) => `${s.name}${s.group}${s.pathway}${s.desc}`.includes(needle));
}

/** 每个技能用不用得了：ME 不够时灰掉（ME 结算在战斗阶段接）。 */
export function canCast(skill: SkillDef, meLeft: number | null): { ok: boolean; reason?: string } {
  if (meLeft !== null && skill.me > meLeft) return { ok: false, reason: `ME 不够（要 ${skill.me}）` };
  return { ok: true };
}
