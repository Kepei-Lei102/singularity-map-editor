import { useState } from 'react';
import { getUI, getWorld, useWorld, worldContext } from '../core/store';
import { publishJudgment } from '../rules/judgments';
import { tokenPosition } from '../scene/architecture';
import type { Id } from '../core/types';
import { DiceTray, type DiceSides, type DiceTrayRecord } from './DiceTray';

interface Setup {
  title: string;
  ruling: string;
  sides: DiceSides;
  subjectId: Id | null;
  place: { mapId: Id; x: number; y: number; label: string } | null;
}

/** 判定角色身上有棋子就用棋子的位置当判定发生点；没棋子就不遮蔽。 */
function subjectPlace(subjectId: string): Setup['place'] {
  if (!subjectId) return null;
  for (const m of getWorld().maps) {
    const t = m.tokens.find((x) => x.pcId === subjectId);
    if (t) { const p = tokenPosition(t); return { mapId: m.id, x: p.x, y: p.y, label: `${m.layer}·${m.name}` }; }
  }
  return null;
}

/** 默认带走当前选中的棋子，省得每次再点一次。 */
function initialSubject(): string {
  const sel = getUI().selection;
  if (sel?.type === 'token') return getWorld().maps.find((m) => m.id === sel.mapId)?.tokens.find((t) => t.id === sel.id)?.pcId ?? '';
  return '';
}

export function JudgmentPanel() {
  useWorld();
  const context = worldContext();
  return <JudgmentForm key={context} context={context} />;
}

function JudgmentForm({ context }: { context: string }) {
  const world = useWorld();
  const [title, setTitle] = useState('观察检定');
  const [ruling, setRuling] = useState('');
  const [subjectId, setSubjectId] = useState(initialSubject);
  const [sides, setSides] = useState<DiceSides>(20);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [result, setResult] = useState<DiceTrayRecord | null>(null);
  const [published, setPublished] = useState(false);
  const [message, setMessage] = useState('');
  const locked = !!setup;

  const confirmSetup = () => {
    if (!title.trim()) return setMessage('先填判定名称，再确认设置');
    if (!world.party.length) return setMessage('还没有角色，判定无法广播');
    const place = subjectPlace(subjectId);
    setSetup({ title: title.trim(), ruling, sides, subjectId: subjectId || null, place });
    setMessage(place ? `设置已锁定：发生在 ${place.label}（${place.x.toFixed(2)}, ${place.y.toFixed(2)}）` : '设置已锁定：不指定位置，全队都能看到细节');
  };

  const broadcast = (roll: DiceTrayRecord, s: Setup) => {
    const error = publishJudgment({
      title: s.title, ruling: s.ruling, recipients: getWorld().party.map((p) => p.id), roll,
      subjectId: s.subjectId, place: s.place ? { mapId: s.place.mapId, x: s.place.x, y: s.place.y } : null,
    }, context);
    setMessage(error ?? '结果已落定，已广播给全队（没有私骰）');
    if (!error) setPublished(true);
    return !error;
  };

  const onRoll = (roll: DiceTrayRecord) => {
    if (!setup || result || roll.sides !== setup.sides) return;
    setResult(roll);
    broadcast(roll, setup);
  };

  const retry = () => { if (result && setup) broadcast(result, setup); };
  const reset = () => { setSetup(null); setResult(null); setPublished(false); setMessage(''); setRuling(''); };

  return <section className="judgment-panel">
    <h3>正式骰子判定 · 见证者月亮版</h3>
    <label>判定名称<input value={title} disabled={locked} onChange={e => setTitle(e.target.value)} /></label>
    <label>发生角色（用它棋子的位置当判定地点）
      <select value={subjectId} disabled={locked} onChange={e => setSubjectId(e.target.value)}>
        <option value="">不指定（全队看到细节）</option>
        {world.party.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </label>
    <label>骰子<select value={sides} disabled={locked} onChange={e => setSides(Number(e.target.value) as DiceSides)}>{[4,6,8,10,12,20,100].map(n => <option key={n} value={n}>D{n}</option>)}</select></label>
    <DiceTray persona="witness" sides={sides} disabled={!setup || !!result || published}
      displayResult={result}
      onResult={onRoll} onError={setMessage} />
    <label>见证者裁定（掷之前写好；留空就是只广播骰点）
      <textarea value={ruling} disabled={locked} onChange={e => setRuling(e.target.value)} placeholder="例如：观察成功，发现钟面上的刻痕。" />
    </label>
    <div className="muted">广播对象：全队 {world.party.length} 人。没有私骰，也不允许丢弃结果。</div>
    {!setup && <button disabled={!title.trim() || !world.party.length} onClick={confirmSetup}>确认设置，开始掷骰</button>}
    {setup && !result && <div>
      <div>设置已锁定：{setup.title} · D{setup.sides} · {setup.subjectId ? world.party.find(p => p.id === setup.subjectId)?.name ?? '角色' : '不指定位置'}</div>
      <div className="muted">选项已锁定；掷出的结果必须广播，不能取消或丢弃。</div>
    </div>}
    {result && <div>
      本次结果：D{result.sides} = {result.value === 100 ? '000' : result.value}
      {!published && <button onClick={retry}>重试广播</button>}
      {published && <button onClick={reset}>开始下一次判定</button>}
    </div>}
    <div role="status">{message}</div>
    <p className="hint">流程：先确认判定名称/角色/骰子，再掷；骰子落定即广播，不能取消或丢弃。视野外的玩家只会看到「发生了一次判定」。</p>
    {[...(world.judgments ?? [])].reverse().slice(0,10).map(j => <article key={j.id}><b>{j.title} · D{j.roll.sides}={j.roll.value===100?'000':j.roll.value}</b><div>{j.ruling}</div></article>)}
  </section>;
}
