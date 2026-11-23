import { useState } from 'react';
import type { PC } from '../core/types';
import { update } from '../core/store';
import { buildSkillTree } from '../rules/skills';

/** 主持人端的技能树：按途径 → 技能组展开，勾选写入 PC.skills；树本身不入档。 */
export function SkillTreeEditor({ pc }: { pc: PC }) {
  const [q, setQ] = useState('');
  const tree = buildSkillTree(pc, { levelUp: true });
  const unlocked = new Set(pc.skills ?? []);
  const all = tree.flatMap((path) => path.groups.flatMap((group) => group.skills.map((skill) => ({ path, group, skill }))));
  const hits = q.trim()
    ? all.filter(({ skill }) => `${skill.name}${skill.group}${skill.pathway}${skill.desc}`.includes(q.trim()))
    : null;
  const unlockedTotal = all.filter(({ skill }) => unlocked.has(skill.id)).length;

  const toggle = (skillId: string, checked: boolean) => update((d) => {
    const x = d.party.find((p) => p.id === pc.id);
    if (!x) return;
    const set = new Set(x.skills ?? []);
    if (checked) set.add(skillId); else set.delete(skillId);
    x.skills = [...set];
  });

  const row = (skill: { id: string; name: string; group: string; sequence: number; me: number }, extra?: string) => (
    <label key={skill.id} className="pc-skill">
      <input type="checkbox" checked={unlocked.has(skill.id)} onChange={(e) => toggle(skill.id, e.target.checked)} />
      【{skill.name}】 <span className="muted">{extra ?? `${skill.group} · 序列 ${skill.sequence} · ${skill.me} ME`}</span>
    </label>
  );

  return <details className="pc-skills skill-tree-editor">
    <summary>技能树 <span className="muted">{unlockedTotal}/{all.length}</span></summary>
    <input className="skill-tree-search" value={q} placeholder="搜技能（名字 / 组 / 说明）"
      onChange={(e) => setQ(e.target.value)} />
    {hits
      ? hits.length === 0
        ? <p className="muted">没找到。</p>
        : hits.map(({ path, group, skill }) => row(skill, `${path.pathway} · ${group.name} · ${skill.me} ME`))
      : tree.map((path) => (
        <details key={path.pathway} className="skill-tree-pathway">
          <summary>
            {path.pathway}
            {path.current && <span className="tag">当前</span>}
            <span className="muted"> {path.unlockedCount}/{path.totalCount}</span>
          </summary>
          {path.groups.map((group) => (
            <div key={group.name} className="skill-tree-group">
              <div className="skill-tree-group-name">{group.name}</div>
              {group.skills.map((skill) => row(skill))}
            </div>
          ))}
        </details>
      ))}
    <div className="hint">勾上的技能会出现在这个角色的玩家窗口「我的技能」里，只发公开说明。技能树只是解锁视图，不存储额外等级/前置。</div>
  </details>;
}
