import { deleteVisionGroup, setVisionGroup, setVisionMode } from '../actions';
import { openPlayerWindow } from '../sync';
import { useState } from 'react';
import { setUI, update, useWorld } from '../store';
import { PATHWAY_SUGGESTIONS } from '../defaults';
import { uid } from '../util';
import { Row, Section, Txt } from './fields';

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
        </div>
      ))}
    </Section>
  );
}
