import { useEffect, useRef, useState } from 'react';
import { getUI, toast, update, useUI, useWorld } from '../store';
import type { Npc } from '../types';
import { cellName, uid } from '../util';
import { findMap, jumpTo } from '../actions';
import {
  MONTH_NAMES, exportNpcs, importNpcs, inSeason, newNpc, nextStep, npcAdvised, npcBeatDone, npcMet, npcOrder, npcReset, npcReturned, npcSkipWait,
} from '../npc';
import { Area, Num, Row, Section, Txt } from './fields';

// 普通人 NPC 面板：备团时写人设和请求；带团时按现实日期提示谁该出现、谁该回访。

const mut = (id: string, fn: (n: Npc) => void, key?: string) =>
  update((d) => { const n = d.npcs.find((x) => x.id === id); if (n) fn(n); }, key ? { coalesce: key + id } : {});

export function NpcPanel() {
  const w = useWorld();
  const ui = useUI();
  const [open, setOpen] = useState<string | null>(null);
  const [, tick] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { const t = window.setInterval(() => tick((x) => x + 1), 60_000); return () => clearInterval(t); }, []);
  const editable = ui.mode !== 'run' || ui.unlock;
  const now = new Date();
  const list = npcOrder(w);
  const dueCount = list.filter((n) => nextStep(n).due && n.progress.status !== 'waiting').length;
  const seasonCount = list.filter((n) => n.progress.status === 'waiting' && inSeason(n, now)).length;

  return (
    <Section title={`NPC（${w.npcs.length}）`} extra={
      <span className="inline">
        {editable && <button className="small" title="新建" onClick={() => { const n = newNpc(); update((d) => { d.npcs.push(n); }); setOpen(n.id); }}>＋</button>}
        <button className="small" title="导入 NPC 的 JSON（同名的覆盖，进度保留）" onClick={() => fileRef.current?.click()}>导入</button>
        <button className="small" title="导出成 JSON，别的模组也能用" onClick={() => exportNpcs(w)}>导出</button>
        <input ref={fileRef} type="file" accept=".json" hidden onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = '';
          if (!f) return;
          try { const data = JSON.parse(await f.text()); importNpcs(Array.isArray(data) ? data : data.npcs ?? []); toast('NPC 已导入'); }
          catch { toast('这个文件读不出来'); }
        }} />
      </span>
    }>
      <div className="hint">
        今天 {now.getMonth() + 1} 月 {now.getDate()} 日。时间按现实算：没到日子的人，连着开团也不出现。
        {` 现在能出场：${dueCount} 位等着回来，${seasonCount} 位这个月可能出现。`}
      </div>
      {list.map((n) => <NpcCard key={n.id} n={n} open={open === n.id} onToggle={() => setOpen(open === n.id ? null : n.id)} editable={editable} />)}
    </Section>
  );
}

function NpcCard({ n, open, onToggle, editable }: { n: Npc; open: boolean; onToggle: () => void; editable: boolean }) {
  const ui = useUI();
  const w = useWorld();
  const s = nextStep(n);
  const badge = s.kind === 'done' ? '' : s.kind === 'off' ? '' : s.due ? 'ok' : 'warn';
  return (
    <div className="card npc-card" style={{ borderLeft: `3px solid ${n.color}` }}>
      <div className="card-title" style={{ cursor: 'pointer' }} onClick={onToggle}>
        <span>{n.icon}</span><span>{n.name}</span><span className="spacer" />
        <span className={`badge ${badge}`}>{s.label}</span>
      </div>
      {n.summary && <div className="hint">{n.summary}</div>}
      {open && (editable && ui.mode !== 'run' ? <NpcEdit n={n} /> : <NpcRun n={n} />)}
      {open && n.place && (() => {
        const m = findMap(w, n.place!.mapId);
        return m ? <button className="small" onClick={() => jumpTo(m.id, n.place!.x, n.place!.y)}>在地图上看（{m.name} {cellName(n.place!.x, n.place!.y)}）</button> : null;
      })()}
    </div>
  );
}

/** 带团：照着念，点按钮推进。 */
function NpcRun({ n }: { n: Npc }) {
  const [advice, setAdvice] = useState('');
  const [outcome, setOutcome] = useState(n.outcomes[0]?.id ?? '');
  const p = n.progress;
  const s = nextStep(n);
  const chosen = n.outcomes.find((o) => o.id === p.outcomeId);
  const beat = n.beats.find((b) => b.id === s.beatId);
  return (
    <div className="npc-run">
      {n.persona && <details><summary>人设</summary><p className="pre">{n.persona}</p></details>}
      {(p.status === 'waiting' || p.status === 'met') && <>
        <div className="npc-say"><b>开场：</b>{n.request || '（没写）'}</div>
        {n.topics.length > 0 && <div className="npc-topics"><b>问到才说：</b>
          {n.topics.map((t) => <details key={t.id}><summary>{t.ask}</summary><p className="pre">{t.answer}</p></details>)}
        </div>}
        {n.notes && <details><summary>主持人备注（坑、书里查得到的、好答案）</summary><p className="pre">{n.notes}</p></details>}
      </>}
      {p.status === 'waiting' && <div className="btns"><button onClick={() => npcMet(n.id)}>出现了</button></div>}
      {p.status === 'met' && <>
        <Row label="玩家的主意"><Area value={advice} onChange={setAdvice} rows={2} placeholder="玩家最后建议送什么、怎么送" /></Row>
        <Row label="会是">
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {n.outcomes.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </Row>
        <div className="btns"><button onClick={() => npcAdvised(n.id, advice, outcome, n.outcomes.find((o) => o.id === outcome)?.label ?? '')}>记下，去办了</button></div>
        <div className="hint">会真的去办，过 {n.returnAfterDays} 天（现实时间）以后才回来说结果。</div>
      </>}
      {p.status === 'advised' && <>
        <div className="hint">玩家的主意：{p.advice || '（没写）'}　·　预计：{chosen?.label ?? '？'}</div>
        {s.kind === 'beat' && <>
          <div className="npc-say"><b>近况：</b>{beat?.text}</div>
          {s.due ? <div className="btns"><button onClick={() => npcBeatDone(n.id, s.beatId!)}>说过了</button></div>
            : <div className="btns"><button className="small" onClick={() => confirm('当作已经到日子了？') && npcSkipWait(n.id, s.at!)}>主持人：跳过等待</button></div>}
        </>}
        {s.kind === 'return' && <>
          {s.due ? <>
            <div className="npc-say"><b>{chosen?.label ?? '结果'}：</b>{chosen?.text}</div>
            {n.extra && <div className="npc-say"><b>顺口说起：</b>{n.extra}</div>}
            {chosen?.reward && <div className="hint">给：{chosen.reward}</div>}
            <Row label="其实是">
              <select value={p.outcomeId} onChange={(e) => update((d) => { const x = d.npcs.find((y) => y.id === n.id); if (x) x.progress.outcomeId = e.target.value; })}>
                {n.outcomes.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </Row>
            <div className="btns"><button onClick={() => npcReturned(n.id, chosen?.label ?? '')}>回访完了</button></div>
          </> : <div className="btns"><button className="small" onClick={() => confirm('当作已经到日子了？') && npcSkipWait(n.id, s.at!)}>主持人：跳过等待</button></div>}
        </>}
      </>}
      {p.status === 'done' && <div className="hint">已结束：{chosen?.label}。{p.advice ? `玩家的主意：${p.advice}` : ''}</div>}
      {p.status !== 'waiting' && <div className="btns"><button className="small danger" onClick={() => confirm('把这位 NPC 的进度清空？') && npcReset(n.id)}>重置进度</button></div>}
    </div>
  );
}

/** 备团：编辑。 */
function NpcEdit({ n }: { n: Npc }) {
  const ui = useUI();
  return (
    <div className="npc-edit">
      <div className="inline">
        <input style={{ width: 44, flex: 'none' }} value={n.icon} onChange={(e) => mut(n.id, (x) => { x.icon = e.target.value; }, 'ni')} />
        <input type="color" style={{ flex: 'none' }} value={n.color} onChange={(e) => mut(n.id, (x) => { x.color = e.target.value; }, 'nc')} />
        <Txt value={n.name} onChange={(v) => mut(n.id, (x) => { x.name = v; }, 'nn')} />
        <button className="danger small" onClick={() => confirm(`删掉「${n.name}」？`) && update((d) => { d.npcs = d.npcs.filter((x) => x.id !== n.id); })}>×</button>
      </div>
      <Row label="一句话"><Txt value={n.summary} onChange={(v) => mut(n.id, (x) => { x.summary = v; }, 'ns')} placeholder="谁，要做什么" /></Row>
      <Row label="出现月份">
        <div className="chips">
          {MONTH_NAMES.map((m, i) => (
            <span key={m} className={`chip ${n.months.includes(i + 1) ? 'on' : ''}`} style={{ cursor: 'pointer' }}
              onClick={() => mut(n.id, (x) => { x.months = x.months.includes(i + 1) ? x.months.filter((y) => y !== i + 1) : [...x.months, i + 1].sort((a, b) => a - b); })}>{m}</span>
          ))}
        </div>
      </Row>
      <div className="hint">不选月份 = 任何时候都可能出现。</div>
      <Row label="地图位置">
        <span className="inline">
          <span className="muted">{n.place ? cellName(n.place.x, n.place.y) : '（不填）'}</span>
          {ui.pick && <button className="small" onClick={() => { const pk = getUI().pick!; mut(n.id, (x) => { x.place = { mapId: pk.mapId, x: pk.x, y: pk.y }; }); }}>设为刚点的格子</button>}
          {n.place && <button className="small" onClick={() => mut(n.id, (x) => { x.place = null; })}>清除</button>}
        </span>
      </Row>
      <Row label="人设"><Area value={n.persona} onChange={(v) => mut(n.id, (x) => { x.persona = v; }, 'np')} rows={4} /></Row>
      <Row label="开场"><Area value={n.request} onChange={(v) => mut(n.id, (x) => { x.request = v; }, 'nr')} rows={2} placeholder="带着什么事来" /></Row>
      <div className="row-label" style={{ marginTop: 6 }}>问到才说 <button className="small" onClick={() => mut(n.id, (x) => { x.topics.push({ id: uid(), ask: '', answer: '' }); })}>＋</button></div>
      {n.topics.map((t, i) => (
        <div key={t.id} className="npc-sub">
          <div className="inline">
            <Txt value={t.ask} placeholder="玩家问到……" onChange={(v) => mut(n.id, (x) => { x.topics[i].ask = v; }, 'ta' + t.id)} />
            <button className="danger small" onClick={() => mut(n.id, (x) => { x.topics.splice(i, 1); })}>×</button>
          </div>
          <Area value={t.answer} rows={2} placeholder="TA 才说……" onChange={(v) => mut(n.id, (x) => { x.topics[i].answer = v; }, 'tb' + t.id)} />
        </div>
      ))}
      <Row label="主持人备注"><Area value={n.notes} onChange={(v) => mut(n.id, (x) => { x.notes = v; }, 'nt')} rows={3} placeholder="坑、书里查得到的、好答案" /></Row>
      <div className="row-label" style={{ marginTop: 6 }}>结果之前的近况 <button className="small" onClick={() => mut(n.id, (x) => { x.beats.push({ id: uid(), afterDays: 3, text: '' }); })}>＋</button></div>
      {n.beats.map((b, i) => (
        <div key={b.id} className="npc-sub">
          <div className="inline"><span className="muted">出完主意后至少</span><Num value={b.afterDays} min={0} onChange={(v) => mut(n.id, (x) => { x.beats[i].afterDays = v; })} /><span className="muted">天</span>
            <button className="danger small" onClick={() => mut(n.id, (x) => { x.beats.splice(i, 1); })}>×</button></div>
          <Area value={b.text} rows={2} placeholder="一句近况（不给奖励）" onChange={(v) => mut(n.id, (x) => { x.beats[i].text = v; }, 'bt' + b.id)} />
        </div>
      ))}
      <Row label="几天后回访"><Num value={n.returnAfterDays} min={0} onChange={(v) => mut(n.id, (x) => { x.returnAfterDays = v; })} /></Row>
      <Row label="回访时顺口说"><Area value={n.extra} onChange={(v) => mut(n.id, (x) => { x.extra = v; }, 'ne')} rows={2} placeholder="比如认识的人的一件小事" /></Row>
      <div className="row-label" style={{ marginTop: 6 }}>结果 <button className="small" onClick={() => mut(n.id, (x) => { x.outcomes.push({ id: uid(), label: '新结果', text: '', reward: '' }); })}>＋</button></div>
      {n.outcomes.map((o, i) => (
        <div key={o.id} className="npc-sub">
          <div className="inline">
            <Txt value={o.label} onChange={(v) => mut(n.id, (x) => { x.outcomes[i].label = v; }, 'ol' + o.id)} />
            <Txt value={o.reward} placeholder="给什么" onChange={(v) => mut(n.id, (x) => { x.outcomes[i].reward = v; }, 'or' + o.id)} />
            <button className="danger small" onClick={() => mut(n.id, (x) => { x.outcomes.splice(i, 1); })}>×</button>
          </div>
          <Area value={o.text} rows={2} placeholder="回访时讲的后来" onChange={(v) => mut(n.id, (x) => { x.outcomes[i].text = v; }, 'ot' + o.id)} />
        </div>
      ))}
    </div>
  );
}
