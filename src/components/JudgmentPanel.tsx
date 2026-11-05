import { useState } from 'react';
import { useWorld, worldContext } from '../core/store';
import { publishJudgment } from '../rules/judgments';
import { DiceTray, type DiceSides, type DiceTrayRecord } from './DiceTray';

export function JudgmentPanel() {
  useWorld();
  const context = worldContext();
  return <JudgmentForm key={context} />;
}
function JudgmentForm() {
  const world = useWorld();
  const [title, setTitle] = useState('观察检定');
  const [ruling, setRuling] = useState('');
  const [to, setTo] = useState('');
  const [sides, setSides] = useState<DiceSides>(20);
  const [pending, setPending] = useState<{ roll: DiceTrayRecord; context: string } | null>(null);
  const [message, setMessage] = useState('');
  return <section className="judgment-panel">
    <h3>正式骰子判定 · 见证者月亮版</h3>
    <label>判定名称<input value={title} onChange={e => setTitle(e.target.value)} /></label>
    <label>接收者<select value={to} onChange={e => setTo(e.target.value)}><option value="">全队</option>{world.party.map(p => <option key={p.id} value={p.id}>{p.name}（私密）</option>)}</select></label>
    <label>骰子<select value={sides} onChange={e => {setSides(Number(e.target.value) as DiceSides);setPending(null);}}>{[4,6,8,10,12,20,100].map(n => <option key={n} value={n}>D{n}</option>)}</select></label>
    <DiceTray persona="witness" sides={sides} disabled={!!pending} onResult={roll => { if (roll.sides !== sides) return; setPending({roll,context:worldContext()});setMessage('结果已落定，请确认裁定与接收者后发布'); }} onError={setMessage} />
    <label>见证者裁定<textarea value={ruling} onChange={e => setRuling(e.target.value)} placeholder="例如：观察成功，发现钟面上的刻痕。留空只发送骰点。" /></label>
    {pending && <div>本次结果：D{pending.roll.sides} = {pending.roll.value === 100 ? '000' : pending.roll.value} <button onClick={() => { setPending(null); setMessage('已丢弃未发布结果，可重新掷骰'); }}>丢弃本次结果</button></div>}
    <button disabled={!pending || !world.party.length} onClick={() => {
      if (!pending) return;
      const error = publishJudgment({title,ruling,recipients:to ? [to] : world.party.map(p => p.id),roll:pending.roll},pending.context);
      setMessage(error ?? '正式判定已推送并写入本场记录');if (!error) setPending(null);
    }}>确认并推送判定</button>
    <div role="status">{message}</div>
    <p className="hint">只推送这一次实际掷骰；不会自动判断成功阈值或修改物件状态。</p>
    {[...(world.judgments ?? [])].reverse().slice(0,10).map(j => <article key={j.id}><b>{j.title} · D{j.roll.sides}={j.roll.value===100?'000':j.roll.value}</b><div>{j.ruling}</div></article>)}
  </section>;
}
