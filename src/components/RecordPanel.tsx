import { useState } from 'react';
import { update, useWorld } from '../store';
import { exportSessionMarkdown, log } from '../actions';
import { fmtTime } from '../util';
import { Check, Section } from './fields';

/** 带团记录：所有操作自动写进时间线，也可以随手记一笔。 */
export function RecordPanel() {
  const w = useWorld();
  const [allSessions, setAllSessions] = useState(false);
  const [note, setNote] = useState('');
  const entries = w.log.filter((e) => allSessions || e.session === w.session).slice().reverse();
  return (
    <Section title={`记录 · 第 ${w.session} 场`} extra={
      <span className="inline">
        <button className="small" onClick={exportSessionMarkdown}>导出 .md</button>
        <button className="small" onClick={() => confirm(`结束第 ${w.session} 场，开始第 ${w.session + 1} 场？`) && update((d) => { d.session += 1; })}>新场次</button>
      </span>
    }>
      <form className="inline" onSubmit={(e) => {
        e.preventDefault();
        if (!note.trim()) return;
        update((d) => log(d, 'note', note.trim()));
        setNote('');
      }}>
        <input value={note} placeholder="随手记一笔，回车保存" onChange={(e) => setNote(e.target.value)} />
      </form>
      <Check label="显示所有场次" value={allSessions} onChange={setAllSessions} />
      <div className="log">
        {entries.length === 0 && <div className="hint">还没有记录。改物件状态、揭示线索、播放媒体、在流程图上点"发生了"，都会自动记在这里。</div>}
        {entries.map((e) => (
          <div key={e.id} className={`log-row ${e.kind}`}>
            <span className="muted">{allSessions && `#${e.session} `}{fmtTime(e.at)}</span> {e.text}
          </div>
        ))}
      </div>
    </Section>
  );
}
