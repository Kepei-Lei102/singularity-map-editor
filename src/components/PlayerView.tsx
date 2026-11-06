import { useEffect, useState } from 'react';
import { listenAsPlayer, send } from '../runtime/sync';
import type { Focus, PublicSkill, SkillCast, World } from '../core/types';
import { TIER_LABEL } from '../core/types';
import { MapCanvas } from './MapCanvas';
import { MediaView } from './MediaPanel';
import { DiceTray } from './DiceTray';

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
      } else if (m.type === 'clear') { setWorld(null); setMedia(null); setFocus(null); setCast(null); }
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
      {map && avatar && <img className="player-avatar" src={avatar} alt="角色头像" />}
      {map && <button className="player-nums" onClick={() => setNums(!nums)}>{nums ? '隐藏编号' : '显示编号'}</button>}
      {map && <span className="player-viewer">{world!.party[0]?.name} 的视角</span>}
      {clues.length > 0 && (
        <div className="clues">
          <div className="clues-title">线索</div>
          {clues.map((c) => (
            <div key={c.id} className="clue">
              <b>{c.object}·{c.label}</b> <span className="muted">{c.kind === 'auto' ? '看到' : `${c.check}${TIER_LABEL[c.tier]}`}</span>
              <div>{c.text}</div>
            </div>
          ))}
        </div>
      )}
      {skills.length > 0 && (
        <details className="player-skills">
          <summary>我的技能 <span className="muted">{skills.length}</span>{pathway && <span className="muted"> · 当前途径：{pathway}</span>}</summary>
          {skills.map((s) => (
            <div key={s.id} className="player-skill">
              <b>【{s.name}】</b> <span className="muted">{s.pathway} · 序列 {s.sequence} · {s.me} ME</span>
              {pathway && s.pathway !== pathway && <span className="badge">换途径 +1 ME</span>}
              <div>{s.desc}</div>
            </div>
          ))}
        </details>
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
        </div>
      )}
    </div>
  );
}
