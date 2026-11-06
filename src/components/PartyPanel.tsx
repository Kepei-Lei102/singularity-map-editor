import { deleteVisionGroup, setVisionGroup, setVisionMode } from '../runtime/actions';
import { openPlayerWindow } from '../runtime/sync';
import { useState } from 'react';
import { setUI, update, useWorld } from '../core/store';
import { PATHWAY_SUGGESTIONS } from '../core/defaults';
import { SKILL_LIBRARY, currentPathwayOf } from '../rules/skills';
import { uid } from '../core/util';
import { Num, Row, Section, Txt } from './fields';

const COLORS = ['#e07a5f', '#81b29a', '#f2cc8f', '#3d85c6', '#b07cc6', '#e0a458'];

function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setDraft('');
  };
  return (
    <div>
      <div className="chips">
        {tags.map((t) => (
          <span key={t} className="chip on">{t} <a onClick={() => onChange(tags.filter((x) => x !== t))}>×</a></span>
        ))}
      </div>
      <input value={draft} list="pathway-sugg" placeholder="加途径标签，回车" onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} onBlur={add} />
      <datalist id="pathway-sugg">{PATHWAY_SUGGESTIONS.map((p) => <option key={p} value={p} />)}</datalist>
    </div>
  );
}

export function PartyPanel() {
  const w = useWorld();
  return (
    <Section title="队伍" extra={
      <button className="small" onClick={() => update((d) => {
        d.party.push({ id: uid(), name: '新角色', tags: [], color: COLORS[d.party.length % COLORS.length] });
      })}>＋</button>
    }>
      <Row label="视野模式"><select value={w.visionMode} onChange={e => setVisionMode(e.target.value as typeof w.visionMode)}>
        <option value="shared">全队共享</option><option value="individual">各自独立</option><option value="grouped">按组共享</option>
      </select></Row>
      <div className="hint">同组共享实时视野与已知地图；拆组保留已知内容。新角色默认公共组。各自独立时保留分组设置。</div>
      {(w.visionGroups ?? []).map(g => <div key={g.id} className="inline">
        <Txt value={g.name} onChange={name => update(d => { d.visionGroups!.find(x => x.id === g.id)!.name = name; }, { coalesce: 'vg' + g.id })} />
        <button className="small danger" title="删除后成员转为独立" onClick={() => deleteVisionGroup(g.id)}>×</button>
      </div>)}
      <button className="small" onClick={() => update(d => { (d.visionGroups ??= []).push({ id: uid(), name: '新视野组' }); })}>＋视野组</button>
      {w.party.map((p) => (
        <div key={p.id} className="card">
          <div className="inline">
            <input type="color" value={p.color} onChange={(e) => update((d) => { d.party.find((x) => x.id === p.id)!.color = e.target.value; }, { coalesce: 'pc' + p.id })} />
            <Txt value={p.name} onChange={(v) => update((d) => { d.party.find((x) => x.id === p.id)!.name = v; }, { coalesce: 'pn' + p.id })} />
            <button className="danger small" onClick={() => update((d) => { d.party = d.party.filter((x) => x.id !== p.id); })}>×</button>
          </div>
          <Row label="视野归属"><select value={p.visionGroupId === null ? 'individual' : p.visionGroupId ?? ''} onChange={e => setVisionGroup(p.id, e.target.value === 'individual' ? null : e.target.value || undefined)}>
            <option value="">公共队伍组</option><option value="individual">独立</option>
            {(w.visionGroups ?? []).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select></Row>
          <button className="small" onClick={() => openPlayerWindow(p.id)}>打开 {p.name} 的玩家窗口</button>
          <Row label="途径"><TagInput tags={p.tags} onChange={(t) => update((d) => { d.party.find((x) => x.id === p.id)!.tags = t; })} /></Row>
          <button className="small" onClick={() => setUI({ tool: 'token', tokenPcId: p.id })}>在地图上放棋子</button>
          <Row label="当前途径"><select value={p.pathway ?? ''} onChange={(e) => update((d) => {
            const pc = d.party.find((x) => x.id === p.id)!;
            if (e.target.value) pc.pathway = e.target.value; else delete pc.pathway;
          })}>
            <option value="">按已解锁技能自动（{currentPathwayOf(p) ?? '未设定'}）</option>
            {[...new Set(SKILL_LIBRARY.map((s) => s.pathway))].map((x) => <option key={x} value={x}>{x}</option>)}
          </select></Row>
          <Row label="头像"><span className="inline">
            {p.avatar && <img className="pc-avatar" src={p.avatar} alt="" />}
            <label className="upload small">上传<input type="file" accept="image/*" onChange={(e) => {
              const f = e.target.files?.[0]; e.target.value = '';
              if (!f) return;
              const img = new Image();
              img.onload = () => {
                const c = document.createElement('canvas'); c.width = c.height = 96;
                const ctx = c.getContext('2d')!; const s = Math.min(img.width, img.height);
                ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 96, 96);
                update((d) => { d.party.find((x) => x.id === p.id)!.avatar = c.toDataURL('image/png'); });
              };
              img.src = URL.createObjectURL(f);
            }} /></label>
            {p.avatar && <button className="small" onClick={() => update((d) => { delete d.party.find((x) => x.id === p.id)!.avatar; })}>清除</button>}
          </span></Row>
          <Row label="ME"><span className="inline">
            <Num value={p.me ?? 0} min={0} onChange={(v) => update((d) => { d.party.find((x) => x.id === p.id)!.me = Math.max(0, Number.isFinite(v) ? v : 0); })} /> /
            <Num value={p.meMax ?? 10} min={0} onChange={(v) => update((d) => { d.party.find((x) => x.id === p.id)!.meMax = Math.max(0, Number.isFinite(v) ? v : 0); })} />
          </span></Row>
          {p.me == null && <div className="hint">还没填 ME：这个角色暂时不能发动技能。</div>}
          <div className="hint">只能发动「当前途径」下的技能；换途径多付 1 ME。</div>
          <details className="pc-skills">
            <summary>已解锁技能 <span className="muted">{p.skills?.length ?? 0}</span></summary>
            {SKILL_LIBRARY.map((s) => (
              <label key={s.id} className="pc-skill">
                <input type="checkbox" checked={p.skills?.includes(s.id) ?? false} onChange={(e) => update((d) => {
                  const pc = d.party.find((x) => x.id === p.id)!; const set = new Set(pc.skills ?? []);
                  if (e.target.checked) set.add(s.id); else set.delete(s.id);
                  pc.skills = [...set];
                })} />
                【{s.name}】 <span className="muted">{s.pathway} · 序列 {s.sequence}</span>
              </label>
            ))}
            <div className="hint">勾上的技能会出现在这个角色的玩家窗口「我的技能」里，只发公开说明。</div>
          </details>
        </div>
      ))}
    </Section>
  );
}
