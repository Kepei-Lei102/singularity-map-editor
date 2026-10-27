import { useEffect, useState } from 'react';
import { setUI, useUI, useWorld } from '../store';
import { MARK_LIFE, findMap, giveMapKnowledge, setVisionMode } from '../actions';
import { HEAR_RANGE } from '../perception';
import {
  MOVE_PER_TURN, addTrialPlayer, clearTrialStatus, endTrial, setTrialStatus, statusLeft, switchTrialPlayer,
  toggleCombat, toggleMarkMode,
} from '../trial';

const SYMBOLS = ['!', '?', '★', '✕', '→'];
const STATUS_PRESETS: [string, number][] = [['晕厥', 15], ['泡温泉', 30]];

/** 试玩时浮在地图上的操作栏。 */
export function TrialHud() {
  const ui = useUI();
  const w = useWorld();
  const [stLabel, setStLabel] = useState('');
  const [stMin, setStMin] = useState(15);
  const t = ui.trial;
  const m = t ? findMap(w, t.mapId) : undefined;
  const statuses = (t?.players ?? []).map((p) => ({ p, st: m?.tokens.find((k) => k.id === p.tokenId)?.status })).filter((x) => x.st);
  const ticking = statuses.some((x) => x.st?.endsAt !== undefined);
  // 有倒计时的时候每秒刷新一次
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);
  if (!t) return null;
  const cur = t.players[t.current];
  const used = cur ? t.moved[cur.tokenId] ?? 0 : 0;
  const color = (pcId: string) => w.party.find((p) => p.id === pcId)?.color ?? '#fff';
  const set = (patch: Partial<typeof t>) => setUI({ trial: { ...t, ...patch } });
  return (
    <div className="trial-hud">
      <div className="trial-row">
        <b>试玩中</b>
        {t.players.map((p, i) => (
          <button key={p.tokenId} className={`small chip ${i === t.current ? 'on' : ''}`} onClick={() => switchTrialPlayer(i)}>
            <i className="dot" style={{ background: color(p.pcId) }} /> {p.name}
          </button>
        ))}
        {t.players.length < 4 && <button className="small" onClick={addTrialPlayer}>＋ 再放一个</button>}
        <span className="spacer" />
        <button className="small" onClick={endTrial}>退出</button>
      </div>
      <div className="trial-row">
        <label className="check"><input type="checkbox" checked={t.combat} onChange={toggleCombat} /> 战斗模式</label>
        {t.combat
          ? <span>第 {t.turn} 回合 · {cur?.name} 已走 {used}/{MOVE_PER_TURN * 3} 子步（3 子步＝1 格，空格结束这一回合）</span>
          : <span className="muted">自由行动：不限步数</span>}
        <span className="spacer" />
        <span className="muted">视野</span>
        <select value={w.visionMode} onChange={(e) => setVisionMode(e.target.value as typeof w.visionMode)}>
          <option value="shared">全队共享</option>
          <option value="individual">各自独立</option>
        </select>
        <button className="small" title="所有没去过的地方变成灰色记忆，只知道地形" onClick={() => giveMapKnowledge(t.mapId)}>拿到地图</button>
      </div>
      <div className="trial-row">
        <button className={`small ${t.markMode ? 'on' : ''}`} onClick={() => toggleMarkMode()}>{t.markMode ? '点地图放下（Esc 取消）' : '放置标记（G）'}</button>
        {SYMBOLS.map((s) => (
          <button key={s} className={`small chip ${t.markSymbol === s ? 'on' : ''}`} onClick={() => set({ markSymbol: s })}>{s}</button>
        ))}
        <input className="mark-text" value={t.markText} placeholder="可写几个字" onChange={(e) => set({ markText: e.target.value })} />
        <span className="muted">{MARK_LIFE} 分钟后淡去；别人要在 {HEAR_RANGE} 格内、没隔墙（能大声说话）才看得到</span>
      </div>
      <div className="trial-row">
        <span className="muted">{cur?.name}暂时不能行动</span>
        {STATUS_PRESETS.map(([l, mn]) => (
          <button key={l} className="small" onClick={() => setTrialStatus(l, mn)}>{l} {mn} 分钟</button>
        ))}
        <input className="mark-text" value={stLabel} placeholder="自己写" onChange={(e) => setStLabel(e.target.value)} />
        <input type="number" className="num-small" value={stMin} min={1} onChange={(e) => setStMin(Math.max(1, +e.target.value || 1))} />
        <span className="muted">分钟</span>
        <button className="small" disabled={!stLabel.trim()} onClick={() => setTrialStatus(stLabel.trim(), stMin)}>开始</button>
      </div>
      {statuses.length > 0 && (
        <div className="trial-row">
          {statuses.map(({ p, st }) => (
            <span key={p.tokenId} className="badge warn">
              {p.name} · {st!.label} · {statusLeft(st!) ?? '已结束'} <a className="link" onClick={() => clearTrialStatus(p.tokenId)}>×</a>
            </span>
          ))}
        </div>
      )}
      <div className="muted small-text">WASD 移动 · 点自己队里的人切换 · Tab 换人 · G 放标记 · Esc 退出（退出后一切恢复原样）</div>
      {t.msg && <div className="trial-msg">{t.msg}</div>}
    </div>
  );
}
