import { useEffect, useState } from 'react';
import { listenAsPlayer, reportJudgmentRoll, send } from '../runtime/sync';
import type { Focus, PendingJudgment, PublicSkill, SkillCast, World } from '../core/types';
import { TIER_LABEL } from '../core/types';
import { MapCanvas } from './MapCanvas';
import { MediaView } from './MediaPanel';
import { DiceTray } from './DiceTray';
import { hpOf } from '../rules/combat';

/** 玩家窗口：主持人共享这个窗口的屏幕给玩家。只显示玩家该看到的东西。 */
export function PlayerView() {
  const [world, setWorld] = useState<World | null>(null);
  const [media, setMedia] = useState<{ mediaId: string; label: string; mime: string; blob?: Blob } | null>(null);
  const [armed, setArmed] = useState(false);
  const [nums, setNums] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [cast, setCast] = useState<SkillCast | null>(null);
  const [you, setYou] = useState<string | null>(null);
  const [skills, setSkills] = useState<PublicSkill[]>([]);
  const [pathway, setPathway] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);
  /** 轮到自己掷的判定。玩家不能拒掷，所以只给「掷」。 */
  const [pending, setPending] = useState<PendingJudgment | null>(null);
  const [rolled, setRolled] = useState<{ sides: number; value: number } | null>(null);
  /** 底部抽屉：一次只开一个。 */
  const [drawer, setDrawer] = useState<'clues' | 'skills' | 'notes' | null>(null);
  /** 笔记只存在这个浏览器里，不发给主持人。 */
  const [notes, setNotes] = useState(() => { try { return localStorage.getItem('ts-player-notes') ?? ''; } catch { return ''; } });
  const saveNotes = (v: string) => { setNotes(v); try { localStorage.setItem('ts-player-notes', v); } catch { /* 存不了也不影响看 */ } };

  useEffect(() => {
    const off = listenAsPlayer((m) => {
      if (m.type === 'world') {
        setWorld(m.world);
        setFocus(m.focus ?? null);
        setCast(m.cast ?? null);
        setYou(m.you ?? null);
        setSkills(m.skills ?? []);
        setPathway(m.pathway ?? null);
        setAvatar(m.avatar ?? null);
        // 世界推送里也带一份自己的待掷判定：刷新后不丢
        if (m.world.pendingJudgment) setPending((cur) => (cur?.id === m.world.pendingJudgment!.id ? cur : m.world.pendingJudgment!));
      } else if (m.type === 'judge-request') { setPending(m.judgment); setRolled(null); }
      else if (m.type === 'judge-cancel') { setPending(null); setRolled(null); }
      else if (m.type === 'clear') { setWorld(null); setMedia(null); setFocus(null); setCast(null); setPending(null); setRolled(null); }
      else if (m.type === 'play') setMedia({ mediaId: m.mediaId, label: m.label, mime: m.mime, blob: m.blob });
      else if (m.type === 'stop') setMedia(null);
    });
    document.title = '奇点之后 · 玩家视角';
    return off;
  }, []);

  const map = world?.maps.find((m) => m.id === world.playerMapId);
  const judgment = world?.judgments?.slice(-1)[0];
  const judgmentNotice = world?.judgmentNotice;
  const clues = [...(world?.clues ?? [])].sort((a, b) => b.at - a.at); // 公开过的线索单独带来，物件看不见了也还在

  const held = focus?.kind === 'skill';
  const iAmCaster = !!cast && !!you && cast.actorPcId === you;
  return (
    <div className="player">
      {map ? <MapCanvas world={world!} map={map} mode="player" playerNumbers={nums} viewer={undefined} /> : <div className="player-wait">{window.opener ? '等待主持人推送地图……' : '玩家端已就绪。请在创作者／见证者端选择「打开玩家窗口…」中的角色，建立专属视角。'}</div>}
      {map && <div className="player-title">{map.layer} · {map.name}</div>}


      {/* 底部状态条：自己的人、自己的血、自己的 ME。这一条始终在。 */}
      {map && (() => {
        const me = world!.party[0];
        const { hp, max } = hpOf(me ?? {});
        return <div className="player-status">
          {avatar ? <img className="player-status-avatar" src={avatar} alt="" /> : <i className="dot" style={{ background: me?.color ?? '#fff' }} />}
          <span className="player-status-name">{me?.name ?? '你'}</span>
          <span className="player-status-hp" title="HP">
            <span className="bar"><span className="bar-fill" style={{ width: `${max ? Math.max(0, Math.min(100, (hp / max) * 100)) : 0}%` }} /></span>
            <b>{hp} / {max}</b>
          </span>
          {me?.me !== undefined && <span className="player-status-me" title="ME">ME {me.me}{me.meMax ? ` / ${me.meMax}` : ''}</span>}
          <span className="spacer" />
          <button className="player-nums" onClick={() => setNums(!nums)}>{nums ? '隐藏编号' : '显示编号'}</button>
        </div>;
      })()}

      {/* 右上角两个小图标：点了才从底部升起抽屉。 */}
      {map && <div className="player-dock">
        <button className={`player-dock-btn ${drawer === 'clues' ? 'on' : ''}`} onClick={() => setDrawer(drawer === 'clues' ? null : 'clues')} title="线索">
          <span className="player-dock-icon">✦</span>{clues.length > 0 && <span className="player-dock-badge">{clues.length}</span>}
        </button>
        <button className={`player-dock-btn ${drawer === 'skills' ? 'on' : ''}`} onClick={() => setDrawer(drawer === 'skills' ? null : 'skills')} title="技能">
          <span className="player-dock-icon">◇</span>{skills.length > 0 && <span className="player-dock-badge">{skills.length}</span>}
        </button>
        <button className={`player-dock-btn ${drawer === 'notes' ? 'on' : ''}`} onClick={() => setDrawer(drawer === 'notes' ? null : 'notes')} title="笔记">
          <span className="player-dock-icon">✎</span>
        </button>
      </div>}
      {/* 抽屉：从底部升起，一次只开一个。不点就一直不占地方。 */}
      {drawer && (
        <aside className={`player-drawer ${drawer}`}>
          <div className="player-drawer-head">
            <b>{drawer === 'clues' ? '线索' : drawer === 'skills' ? '我的技能' : '我的笔记'}</b>
            {drawer === 'skills' && pathway && <span className="muted">当前途径：{pathway}</span>}
            <span className="spacer" />
            <button className="small" onClick={() => setDrawer(null)}>收起</button>
          </div>
          <div className="player-drawer-body">
            {drawer === 'clues' && (clues.length === 0
              ? <div className="muted">还没有线索。看到、检查到的东西会记在这里。</div>
              : clues.map((c) => (
                <div key={c.id} className="clue">
                  <b>{c.object}·{c.label}</b> <span className="muted">{c.kind === 'auto' ? '看到' : `${c.check}${TIER_LABEL[c.tier]}`}</span>
                  <div>{c.text}</div>
                </div>
              )))}
            {drawer === 'skills' && (skills.length === 0
              ? <div className="muted">还没有解锁技能。</div>
              : skills.map((sk) => (
                <div key={sk.id} className="player-skill">
                  <b>【{sk.name}】</b> <span className="muted">{sk.pathway} · 序列 {sk.sequence} · {sk.me} ME</span>
                  {pathway && sk.pathway !== pathway && <span className="badge">换途径 +1 ME</span>}
                  <div>{sk.desc}</div>
                </div>
              )))}
            {drawer === 'notes' && <textarea className="player-notes" value={notes} placeholder="记下你想记的：谁说过什么、哪里去过、要办什么事。只存在这台电脑上，不发给主持人。"
              onChange={(e) => saveNotes(e.target.value)} />}
          </div>
        </aside>
      )}
      {pending && (
        <div className="player-roll">
          <h3>轮到你了 · {pending.title}</h3>
          <div className="muted">见证者宣告了这个判定，骰子由你掷。掷了不能取消。</div>
          {rolled
            ? <div className="player-roll-result">D{rolled.sides} = {rolled.value === 100 ? '000' : rolled.value}</div>
            : <DiceTray persona="player" sides={pending.sides}
                onResult={(r) => {
                  setRolled({ sides: r.sides, value: r.value });
                  reportJudgmentRoll({ type: 'judge-roll', id: pending.id, title: pending.title, sides: r.sides, value: r.value, tens: r.tens, units: r.units, material: r.material, seed: r.seed, rollId: r.id });
                }}
                onError={() => {}} />}
          {rolled && <div className="muted">已经送到见证者那边，等他确认后广播全队。</div>}
        </div>
      )}
      {judgmentNotice && !judgment && <div className="player-judgment-notice">发生了一次判定</div>}
      {judgment && <button className="player-judgment-toggle" onClick={() => setDismissed(dismissed === judgment.id ? null : judgment.id)}>正式判定 · {judgment.title}</button>}
      {judgment && dismissed !== judgment.id && <aside className="player-judgment">
        <button onClick={() => setDismissed(judgment.id)}>收起</button><h3>{judgment.title}</h3>
        <strong>D{judgment.roll.sides} = {judgment.roll.value === 100 ? '000' : judgment.roll.value}</strong><p>{judgment.ruling || '等待见证者解释判定'}</p>
        <DiceTray persona="player" sides={judgment.roll.sides} disabled displayResult={judgment.roll} onResult={() => {}} />
      </aside>}
      {media && armed && (
        <div className={media.mime.startsWith('audio') ? 'player-audio' : 'player-media'}>
          {media.mime.startsWith('audio') && <span>♪ {media.label}</span>}
          <MediaView key={media.mediaId} mediaId={media.mediaId} blob={media.blob} mime={media.mime} autoPlay
            onEnded={() => !media.mime.startsWith('image') && setMedia(null)} />
        </div>
      )}
      {held && (
        <div className="player-hold">
          <div className="player-hold-title">{focus?.label ?? '有人正在发动技能'}</div>
          {cast?.step === 'approval' && iAmCaster ? (
            <>
              <div className="muted">见证者要替你发动技能，需要你点头（60 秒内？）。</div>
              <div className="btns">
                <button onClick={() => send({ type: 'skill-decision', castId: cast.id, ok: true })}>同意</button>
                <button onClick={() => send({ type: 'skill-decision', castId: cast.id, ok: false })}>不同意</button>
              </div>
            </>
          ) : (
            <div className="muted">现在请先看着，等这一步结算完再操作。</div>
          )}
        </div>
      )}
      {!armed && (
        <div className="arm" onClick={() => setArmed(true)}>
          <div>点一下这里开始</div>
          <div className="muted">（浏览器要先点一下才允许自动播放声音）</div>
          {!map && <div className="muted">现在还没有地图：等创作者 / 见证者在编辑器里「推送当前地图」。</div>}
        </div>
      )}
    </div>
  );
}
