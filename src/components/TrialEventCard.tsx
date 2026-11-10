import { useEffect } from 'react';
import { useUI, useWorld } from '../core/store';
import { clearTrialEvent, damageLanded, damageLost } from '../runtime/trial';

/** 试玩里的大事（攻击、伤害、濒死）：单独一张大卡片浮在地图上方，不跟下面那排小字挤在一起。 */
export function TrialEventCard() {
  const ui = useUI();
  const w = useWorld();
  const ev = ui.trial?.event;
  // 卡片留一会儿就收：不挡下一次操作。玩家也可以点掉。
  const at = ev?.at;
  useEffect(() => {
    if (at === undefined) return;
    const id = window.setTimeout(() => clearTrialEvent(), 60000);
    return () => window.clearTimeout(id);
  }, [at]);
  if (!ev || !ui.trial) return null;
  const isHit = ev.kind === 'hit';
  // 没真扣到血就别报伤害数字：打已经倒地的人、打没血条的 NPC，账本都记「没变化」。
  const landed = isHit && damageLanded(ev);
  // −N 报实际扣掉的血，不是掷出来的伤害（打在残血上，掷 3 只扣 1）；不一样就把掷出的数写小字。
  const lost = damageLost(ev);
  // 濒死/昏厥是这一击最要紧的结果，不能跟着伤害块一起消失。
  const tags = (<>
    {ev.downed === 'dying' && <span className="dying-tag">濒死</span>}
    {ev.downed === 'down' && <span className="down-tag">昏厥</span>}
  </>);
  const color = (pcId: string | null) => (pcId ? w.party.find((p) => p.id === pcId)?.color ?? '#fff' : '#fff');
  return (
    <div className={`trial-event ${ev.kind}`} role="status">
      <div className="trial-event-head">
        <i className="dot" style={{ background: color(ev.attackerPcId) }} />
        <span className="trial-event-actor">{ev.attackerName}</span>
        <span className="trial-event-arrow">→</span>
        <i className="dot" style={{ background: color(ev.targetPcId) }} />
        <span className="trial-event-target">{ev.targetName}</span>
      </div>
      <div className="trial-event-dice">
        <span className={isHit ? 'dice-hit' : 'dice-miss'}>D100 = {ev.roll === 100 ? '00' : ev.roll}</span>
        {(ev.dice ?? 1) > 1 && <span className="dice-crit">{(ev.dice ?? 1) === 4 ? '特大成功 ×4' : '大成功 ×2'}</span>}
        {!isHit && <span className="dice-miss-tag">大失败 · 落空</span>}
      </div>
      {landed ? (
        <div className="trial-event-damage">
          <span className="damage-num">−{lost}</span>
          <span className="damage-label">伤害</span>
          {lost !== ev.damage && <span className="muted">掷出 {ev.damage}</span>}
          {ev.hpBefore !== null && ev.hpAfter !== null && (
            <span className="hp-bar">
              <b>{ev.hpBefore}</b> → <b className={ev.hpAfter === 0 ? 'dead' : ''}>{ev.hpAfter}</b>
              {ev.hpMax ? <span className="muted"> / {ev.hpMax}</span> : null}
            </span>
          )}
          {tags}
        </div>
      ) : (isHit && ev.downed ? <div className="trial-event-damage">{tags}</div> : null)}
      {ev.note && <div className="trial-event-note">{ev.note}</div>}
      {isHit && !landed && !ev.note && <div className="trial-event-note">命中，但数值没有变化</div>}
      <div className="trial-event-foot">1 行动点已用 · 按空格结束回合<a onClick={clearTrialEvent}>收起</a></div>
    </div>
  );
}
