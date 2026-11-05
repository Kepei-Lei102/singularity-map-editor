import { useEffect, useState } from 'react';
import { getWorld, useUI, useWorld } from '../core/store';
import { SKILL_LIBRARY, filterSkills, groupSkills, type SkillDef } from '../rules/skills';
import { objectEnabled } from '../core/objectData.js';
import { approveSkillCast, beginSkillCast, cancelSkillCast, closeSkillCast, resolveSkillCast, timeoutSkillCast } from '../rules/skillCast';

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
  const actor = party.find((p) => p.id === actorId);
  const unlocked = new Set(actor?.skills ?? []);

  // 等待同意的倒计时：到点自动视为休眠
  useEffect(() => {
    if (cast?.step !== 'approval') return;
    const t = window.setInterval(() => { if (timeoutSkillCast()) setMsg('同意超时，已视为休眠'); }, 1000);
    return () => window.clearInterval(t);
  }, [cast?.step]);

  const start = (skill: SkillDef) => {
    const err = beginSkillCast(actorId, skill.id, initiator);
    setMsg(err ?? '');
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
        <div className="muted">{actorName} · 消耗 {skill?.me} ME · 判定：{skill?.check ? skill.check.attributes.join('+') : '智慧'}（D20 / DC 20）</div>
        <label>目标<select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">（无目标）</option>
          {world.maps.find((m) => m.id === ui.mapId)?.objects.filter((o) => objectEnabled(world.maps.find((m) => m.id === ui.mapId)!, o)).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select></label>
        <div className="btns">
          <button onClick={() => { const e = resolveSkillCast(d20(), target || undefined); setMsg(e ?? ''); }}>掷骰并结算</button>
          <button onClick={() => { cancelSkillCast('当场取消'); setMsg(''); }}>取消</button>
        </div>
      </div>
    );
    return (
      <div className="cast-box">
        <div className="cast-title">结果：{cast.note}（D20 {cast.roll}，合计 {cast.total}）</div>
        <div className="muted">这一步只是试点链路：技能还没接动作卡，效果表还没挂。</div>
        <div className="btns"><button onClick={() => { closeSkillCast('技能发动结束'); setMsg(''); }}>结束</button></div>
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
          {q && hits.length === 0 && <p className="muted">没找到。</p>}
          {q && hits.map((s) => (
            <button key={s.id} className="skill-item" onClick={() => start(s)}>
              【{s.name}】· {s.group} · {s.me} ME
            </button>
          ))}
          {!q && (
            <>
              <div className="btns">{groups?.map((g) => <button key={g.pathway} className={pathway === g.pathway ? 'on' : ''} onClick={() => { setPathway(g.pathway); setGroup(null); }}>{g.pathway}</button>)}</div>
              {pathway && <div className="btns">{groups?.find((g) => g.pathway === pathway)?.groups.map((g) => <button key={g.name} className={group === g.name ? 'on' : ''} onClick={() => setGroup(g.name)}>{g.name}</button>)}</div>}
              {group && skillsInGroup.map((s) => (
                <button key={s.id} className="skill-item" onClick={() => start(s)}>【{s.name}】· {s.me} ME</button>
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
