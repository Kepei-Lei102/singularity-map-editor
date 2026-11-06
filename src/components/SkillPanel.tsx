import { useEffect, useState } from 'react';
import { getWorld, update, useUI, useWorld } from '../core/store';
import { SKILL_LIBRARY, currentPathwayOf, filterSkills, groupSkills, type SkillDef } from '../rules/skills';
import { objectEnabled } from '../core/objectData.js';
import { approveSkillCast, beginSkillCast, cancelSkillCast, closeSkillCast, resolveSkillCast, timeoutSkillCast } from '../rules/skillCast';
import { findMap } from '../runtime/actions';

const d20 = () => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return 1 + (buf[0] % 20);
};

export function SkillPanel() {
  useWorld();
  const ui = useUI();
  const world = getWorld();
  const cast = ui.cast ?? null;
  const party = world.party;
  const [actorId, setActorId] = useState(party[0]?.id ?? '');
  const [initiator, setInitiator] = useState<'player' | 'gm'>('player');
  const [q, setQ] = useState('');
  const [pathway, setPathway] = useState<string | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [levelUp, setLevelUp] = useState(false);
  const [target, setTarget] = useState('');
  const [msg, setMsg] = useState('');
  const [forceSkill, setForceSkill] = useState<SkillDef | null>(null);
  const [syncopeMin, setSyncopeMin] = useState(60);
  const actor = party.find((p) => p.id === actorId);

  // 角色列表变化后（新加/删掉角色），旧选择可能已经不存在：落回第一个角色。
  useEffect(() => {
    if (!party.some((p) => p.id === actorId)) setActorId(party[0]?.id ?? '');
  }, [actorId, party]);

  const unlocked = new Set(actor?.skills ?? []);
  const nowPathway = actor ? currentPathwayOf(actor) : null;
  const switchNote = (p: string) => (nowPathway && p !== nowPathway ? ' · 换途径 +1 ME' : '');

  // 等待同意的倒计时：到点自动视为休眠
  useEffect(() => {
    if (cast?.step !== 'approval') return;
    const t = window.setInterval(() => { if (timeoutSkillCast()) setMsg('同意超时，已视为休眠'); }, 1000);
    return () => window.clearInterval(t);
  }, [cast?.step]);

  const start = (skill: SkillDef, force = false) => {
    const err = beginSkillCast(actorId, skill.id, initiator, force);
    if (err) { if (/ME 不够/.test(err)) setForceSkill(skill); setMsg(err); }
    else { setMsg(''); setForceSkill(null); }
  };

  /** 强行发动的代价：在试玩里给这个角色挂晕厥状态。 */
  const applySyncope = () => {
    const t = ui.trial;
    if (!t) { setMsg('不在试玩中：结束后请在场外手动记晕厥'); return; }
    update((d) => {
      const tok = findMap(d, t.mapId)?.tokens.find((k) => k.pcId === actorId);
      if (!tok) return;
      tok.status = t.combat ? { label: '晕厥', roundsLeft: Math.max(1, Math.ceil(syncopeMin / 5)) } : { label: '晕厥', endsAt: Date.now() + syncopeMin * 60000 };
    });
  };

  const castView = () => {
    if (!cast) return null;
    const skill = SKILL_LIBRARY.find((s) => s.id === cast.skillId);
    const actorName = world.party.find((p) => p.id === cast.actorPcId)?.name ?? '某人';
    const left = cast.expiresAt ? Math.max(0, Math.ceil((cast.expiresAt - Date.now()) / 1000)) : 0;
    if (cast.step === 'approval') return (
      <div className="cast-box">
        <div className="cast-title">等待玩家同意 · {left}s</div>
        <div className="muted">{actorName} 的【{skill?.name}】由见证者代发起，需要玩家点头。</div>
        <div className="btns">
          <button onClick={() => { const e = approveSkillCast(true); setMsg(e ?? '玩家已同意'); }}>模拟玩家同意</button>
          <button onClick={() => { approveSkillCast(false); setMsg('玩家不同意'); }}>玩家不同意</button>
        </div>
      </div>
    );
    if (cast.step === 'confirm') return (
      <div className="cast-box">
        <div className="cast-title">确认发动 · 【{skill?.name}】</div>
        <div className="muted">{actorName} · 消耗 {cast.meCost ?? skill?.me} ME{cast.pathwayFrom && cast.pathwayTo && cast.pathwayFrom !== cast.pathwayTo ? `（换途径 ${cast.pathwayFrom} → ${cast.pathwayTo}：+1）` : ''} · 判定：{skill?.check ? skill.check.attributes.join('+') : '智慧'}（D20 / DC 20）</div>
        <label>目标<select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">（无目标）</option>
          {world.maps.find((m) => m.id === ui.mapId)?.objects.filter((o) => objectEnabled(world.maps.find((m) => m.id === ui.mapId)!, o)).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select></label>
        <div className="btns">
          {cast.overdrawn && <p className="muted">强行发动：结算后晕厥 <input type="number" min={1} value={syncopeMin} onChange={(e) => setSyncopeMin(Math.max(1, +e.target.value || 60))} style={{ width: 64 }} /> 分钟（由见证者定）。</p>}
          <button onClick={() => { const e = resolveSkillCast(d20(), target || undefined); setMsg(e ?? ''); }}>掷骰并结算</button>
          <button onClick={() => { cancelSkillCast('当场取消'); setMsg(''); }}>取消</button>
        </div>
      </div>
    );
    return (
      <div className="cast-box">
        <div className="cast-title">结果：{cast.note}（D20 {cast.roll}，合计 {cast.total}）</div>
        <div className="muted">这一步只是试点链路：技能还没接动作卡，效果表还没挂。</div>
        {cast.overdrawn && <p className="muted">强行发动：晕厥 <input type="number" min={1} value={syncopeMin} onChange={(e) => setSyncopeMin(Math.max(1, +e.target.value || 60))} style={{ width: 64 }} /> 分钟（由见证者定）。</p>}
        <div className="btns"><button onClick={() => { const over = cast.overdrawn; closeSkillCast('技能发动结束'); if (over) applySyncope(); setMsg(''); }}>结束</button></div>
      </div>
    );
  };

  const groups = q ? null : groupSkills(SKILL_LIBRARY, unlocked, { levelUp });
  const hits = q ? filterSkills(SKILL_LIBRARY, q, unlocked, { levelUp }) : [];
  const skillsInGroup = groups?.find((g) => g.pathway === pathway)?.groups.find((g) => g.name === group)?.skills ?? [];

  return (
    <section className="skill-panel">
      <h3>技能</h3>
      {castView()}
      {!cast && forceSkill && (
        <div className="cast-box">
          <div className="cast-title">ME 不够：【{forceSkill.name}】</div>
          <div className="muted">可以强行发动，代价是长时间晕厥（时长由见证者定）。</div>
          <div className="btns">
            <button onClick={() => start(forceSkill, true)}>强行发动</button>
            <button onClick={() => { setForceSkill(null); setMsg(''); }}>算了</button>
          </div>
        </div>
      )}
      {!cast && (
        <>
          <div className="skill-row">
            <label>角色<select value={actorId} onChange={(e) => { setActorId(e.target.value); setPathway(null); setGroup(null); }}>{party.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label>发起<select value={initiator} onChange={(e) => setInitiator(e.target.value as 'player' | 'gm')}>
              <option value="player">玩家自己发起</option>
              <option value="gm">见证者代发起（需同意）</option>
            </select></label>
          </div>
          <input placeholder="搜索技能（名字 / 组 / 说明）" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="muted"><input type="checkbox" checked={levelUp} onChange={(e) => setLevelUp(e.target.checked)} /> 升级视图（显示未解锁的名字）</label>
          {!actor?.skills?.length && <p className="muted">这个角色还没有已解锁的技能。技能数据随编辑器走，角色身上只记 id。</p>}
          {actor && actor.me == null && <p className="muted">这个角色还没填 ME，技能暂时不能发动（去队伍面板填 ME 当前 / 上限）。</p>}
          {q && hits.length === 0 && <p className="muted">没找到。</p>}
          {q && hits.map((s) => (
            <button key={s.id} className="skill-item" onClick={() => start(s)}>
              【{s.name}】· {s.group} · {s.me} ME{switchNote(s.pathway)}
            </button>
          ))}
          {!q && (
            <>
              <div className="btns">{groups?.map((g) => <button key={g.pathway} className={pathway === g.pathway ? 'on' : ''} onClick={() => { setPathway(g.pathway); setGroup(null); }}>{g.pathway}</button>)}</div>
              {pathway && <div className="btns">{groups?.find((g) => g.pathway === pathway)?.groups.map((g) => <button key={g.name} className={group === g.name ? 'on' : ''} onClick={() => setGroup(g.name)}>{g.name}</button>)}</div>}
              {group && skillsInGroup.map((s) => (
                <button key={s.id} className="skill-item" onClick={() => start(s)}>【{s.name}】· {s.me} ME{switchNote(s.pathway)}</button>
              ))}
              {pathway && !group && <p className="muted">选一个技能组。</p>}
              {!pathway && <p className="muted">选一个途径。</p>}
            </>
          )}
          {msg && <p className="muted">{msg}</p>}
        </>
      )}
    </section>
  );
}
