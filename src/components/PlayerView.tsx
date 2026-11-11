import { useEffect, useState } from 'react';
import { listenAsPlayer, reportJudgmentRoll, send } from '../runtime/sync';
import type { CombatNotice, Focus, PendingJudgment, PublicSkill, SkillCast, Utterance, World } from '../core/types';
import { TIER_LABEL } from '../core/types';
import { MapCanvas } from './MapCanvas';
import { UTTERANCE_MAX } from '../rules/dialogue';
import { MediaView } from './MediaPanel';
import { DiceTray, type DiceTrayRecord } from './DiceTray';
import { hpOf } from '../rules/combat';
import { damageLanded, damageLost } from '../runtime/trial';

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
  /** 自己按方向键走格子的结果。没消息就是成了。 */
  const [moveNote, setMoveNote] = useState<{ ok: boolean; msg: string } | null>(null);
  /** 轮到自己掷的判定。玩家不能拒掷，所以只给「掷」。 */
  const [pending, setPending] = useState<PendingJudgment | null>(null);
  /** 掷过的骰子。优势/劣势要两颗，所以这里是个数组。 */
  const [rolled, setRolled] = useState<{ sides: number; rolls: DiceTrayRecord[]; taken: number } | null>(null);
  /** 底部抽屉：一次只开一个。 */
  const [drawer, setDrawer] = useState<'clues' | 'skills' | 'notes' | 'talk' | null>(null);
  /** 笔记只存在这个浏览器里，不发给主持人。 */
  const [notes, setNotes] = useState(() => { try { return localStorage.getItem('ts-player-notes') ?? ''; } catch { return ''; } });
  /** 对话抽屉里正在打的那句话，和说给谁。 */
  const [draft, setDraft] = useState('');
  const [sayTo, setSayTo] = useState<string>('');
  const [sayErr, setSayErr] = useState<string | null>(null);
  /** 最近一次跟我有关的攻击：从底部弹一条，几秒后自己收。 */
  const [notice, setNotice] = useState<CombatNotice | null>(null);
  /** 换了一个新的判定：上一笔掷过的骰子必须清掉，否则会把旧骰子当新结果。 */
  useEffect(() => { setRolled(null); }, [pending?.id]);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (!moveNote) return;
    const t = window.setTimeout(() => setMoveNote(null), 6000);
    return () => window.clearTimeout(t);
  }, [moveNote]);
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
        if (m.world.combatNotice) setNotice((cur) => (cur?.id === m.world.combatNotice!.id ? cur : m.world.combatNotice!));
        // 世界推送里也带一份自己的待掷判定：刷新后不丢；
        // 推送里没有判定（或不是这一笔）说明已经结束，顺手收掉骰盘——兜住所有忘了发 judge-cancel 的路径。
        const pending = m.world.pendingJudgment;
        if (pending) setPending((cur) => (cur?.id === pending.id ? cur : pending));
        else { setPending(null); setRolled(null); }
      } else if (m.type === 'judge-request') { setPending(m.judgment); setRolled(null); }
      else if (m.type === 'judge-cancel') { setPending(null); setRolled(null); }
      else if (m.type === 'clear') { setWorld(null); setMedia(null); setFocus(null); setCast(null); setPending(null); setRolled(null); }
      else if (m.type === 'move-result') setMoveNote(m.ok ? null : { ok: false, msg: m.msg });
      else if (m.type === 'play') setMedia({ mediaId: m.mediaId, label: m.label, mime: m.mime, blob: m.blob });
      else if (m.type === 'stop') setMedia(null);
    });
    document.title = '奇点之后 · 玩家视角';
    return off;
  }, []);

  // 方向键走一格，发给见证者那边执行。焦点在输入框里就不抢。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      const dir: Record<string, [number, number]> = { arrowup: [0, -1], arrowdown: [0, 1], arrowleft: [-1, 0], arrowright: [1, 0], w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] };
      const d = dir[e.key.toLowerCase()];
      if (!d) return;
      e.preventDefault();
      send({ type: 'move', dx: d[0], dy: d[1] });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const map = world?.maps.find((m) => m.id === world.playerMapId);
  const says: Utterance[] = world?.utterances ?? [];
  const me = world?.party[0];
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

      {/* 自己的处境：被暂停了、或者还没轮到自己。常驻，不用按键才知道。 */}
      {map && world?.trialFlags?.paused && (
        <div className="player-notice miss">见证者暂停了你的操作</div>
      )}
      {map && world?.trialFlags && !world.trialFlags.isCurrent && !world.trialFlags.paused && (
        <div className="player-notice">还没轮到你</div>
      )}

      {/* 走不过去的提示。几秒后自己收。 */}
      {map && moveNote && (
        <div className="player-notice miss" onClick={() => setMoveNote(null)}>{moveNote.msg}</div>
      )}

      {/* 跟我有关的攻击：状态条上方弹一条，几秒后自己收。 */}
      {map && notice && (
        <div className={`player-notice ${notice.kind === 'hit' ? 'hit' : 'miss'} ${notice.downed ? 'downed' : ''}`} onClick={() => setNotice(null)}>
          <b>{notice.role === 'attacker' ? `你打 ${notice.targetName}` : `${notice.attackerName} 打你`}</b>
          {notice.kind === 'miss'
            ? <span>没打中</span>
            : damageLanded(notice)
              ? <span>命中，掉了 {damageLost(notice)} 点血{notice.hpMax ? ` → ${notice.hpAfter} / ${notice.hpMax}` : ''}</span>
              : <span>{notice.note || `命中，但数值没有变化${notice.hpAfter !== null && notice.hpMax ? `（${notice.hpAfter} / ${notice.hpMax}）` : ''}`}</span>}
          {notice.downed === 'dying' && <span className="tag">濒死</span>}
          {notice.downed === 'down' && <span className="tag">昏厥</span>}
        </div>
      )}

      {/* 右上角两个小图标：点了才从底部升起抽屉。 */}
      {map && <div className="player-dock">
        <button className={`player-dock-btn ${drawer === 'clues' ? 'on' : ''}`} onClick={() => setDrawer(drawer === 'clues' ? null : 'clues')} title="线索">
          <span className="player-dock-icon">✦</span>{clues.length > 0 && <span className="player-dock-badge">{clues.length}</span>}
        </button>
        <button className={`player-dock-btn ${drawer === 'skills' ? 'on' : ''}`} onClick={() => setDrawer(drawer === 'skills' ? null : 'skills')} title="技能">
          <span className="player-dock-icon">◇</span>{skills.length > 0 && <span className="player-dock-badge">{skills.length}</span>}
        </button>
        <button className={`player-dock-btn ${drawer === 'talk' ? 'on' : ''}`} onClick={() => setDrawer(drawer === 'talk' ? null : 'talk')} title="说话">
          <span className="player-dock-icon">💬</span>
        </button>
        <button className={`player-dock-btn ${drawer === 'notes' ? 'on' : ''}`} onClick={() => setDrawer(drawer === 'notes' ? null : 'notes')} title="笔记">
          <span className="player-dock-icon">✎</span>
        </button>
      </div>}
      {/* 抽屉：从底部升起，一次只开一个。不点就一直不占地方。 */}
      {drawer && (
        <aside className={`player-drawer ${drawer}`}>
          <div className="player-drawer-head">
            <b>{drawer === 'clues' ? '线索' : drawer === 'skills' ? '我的技能' : drawer === 'talk' ? '说话' : '我的笔记'}</b>
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
            {drawer === 'talk' && <>
              <div className="player-talk-log">
                {says.length === 0 && <div className="muted">还没说过话。想干什么就直说——「我去跟这家伙评评理」也算。</div>}
                {says.slice(-30).map((u) => (
                  <div key={u.id} className={`player-say ${u.pcName === (me?.name ?? '') ? 'mine' : ''}`}>
                    <b>{u.pcName}</b>{u.targetName && <span className="muted"> → {u.targetName}</span>}
                    <div>{u.text}</div>
                    {u.resolution && <div className="player-say-res">见证者接成了「{u.resolution.label}」{u.resolution.outcome ? ` · ${u.resolution.outcome}` : ''}</div>}
                  </div>
                ))}
              </div>
              <div className="player-talk-in">
                <select value={sayTo} onChange={(e) => setSayTo(e.target.value)}>
                  <option value="">说给所有人</option>
                  {(map?.tokens ?? []).filter((x) => !x.corpse && x.status?.label !== '昏厥' && x.pcId !== you).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <textarea value={draft} maxLength={UTTERANCE_MAX} placeholder="想说什么就说什么。说完见证者会接住它。"
                  onChange={(e) => { setDraft(e.target.value); setSayErr(null); }} />
                <button className="small primary" disabled={!draft.trim()} onClick={() => {
                  const tok = map?.tokens.find((x) => x.pcId === you);
                  if (!you || !tok || !map) { setSayErr('还没拿到你的角色'); return; }
                  const text = draft.trim();
                  if (!text) return;
                  if (text.length > UTTERANCE_MAX) { setSayErr(`一次最多说 ${UTTERANCE_MAX} 个字`); return; }
                  // 玩家窗口不自己写 world：那份是见证者推过来的只读副本，
                  // 在这里 update 只会改本地影子，主持人根本不知道。只发消息，等它推回来。
                  send({ type: 'say', text, targetTokenId: sayTo || null });
                  setDraft(''); setSayTo(''); setSayErr(null);
                }}>说</button>
              </div>
              {sayErr && <div className="player-say-err">{sayErr}</div>}
            </>}
            {drawer === 'notes' && <textarea className="player-notes" value={notes} placeholder="记下你想记的：谁说过什么、哪里去过、要办什么事。只存在这台电脑上，不发给主持人。"
              onChange={(e) => saveNotes(e.target.value)} />}
          </div>
        </aside>
      )}
      {pending && (() => {
        // 多属性判定（撬锁的 智慧＋敏捷 / 力量＋敏捷）：每个属性各掷一颗，一起送回主持人。
        // 优劣势的骰由发起者骰两次（作者 2026-11-10 定）：优势取高、劣势取低。见证者只管「这次算不算优劣势」。
        const checkAttrs = pending.check?.attrs ?? [];
        const isCheck = checkAttrs.length > 0;
        const diceMode = isCheck ? 'single' : pending.jump?.dice ?? 'single';
        const needTwo = !isCheck && diceMode !== 'single';
        const need = isCheck ? checkAttrs.length : needTwo ? 2 : 1;
        const throwDie = (r: DiceTrayRecord) => {
          const rolls = [...(rolled?.rolls ?? []), r];
          if (rolls.length < need) { setRolled({ sides: r.sides, rolls, taken: rolls[0].value }); return; }
          const taken = isCheck ? rolls[0].value
            : needTwo
              ? (diceMode === 'advantage' ? Math.max(...rolls.map((x) => x.value)) : Math.min(...rolls.map((x) => x.value)))
              : rolls[0].value;
          const chosen = isCheck ? rolls[0] : rolls.find((x) => x.value === taken)!;
          setRolled({ sides: r.sides, rolls, taken });
          reportJudgmentRoll({
            type: 'judge-roll', id: pending.id, title: pending.title, sides: chosen.sides,
            value: taken, values: rolls.map((x) => x.value),
            tens: chosen.tens, units: chosen.units, material: chosen.material, seed: chosen.seed, rollId: chosen.id,
          });
        };
        const fmt = (v: number) => (v === 100 ? '000' : String(v));
        const waitingSecond = !!rolled && rolled.rolls.length < need;
        return <div className="player-roll">
          <h3>轮到你了 · {pending.title}</h3>
          <div className="muted">
            见证者宣告了这个判定，骰子由你掷。掷了不能取消。
            {isCheck && `要过 ${checkAttrs.map((a) => a.attr).join('＋')}，都要过（DC ${pending.check!.dc}）。`}
            {needTwo && (diceMode === 'advantage' ? '这次是优势骰：掷两颗，取高的那颗。' : '这次是劣势骰：掷两颗，取低的那颗。')}
          </div>
          {waitingSecond
            ? <div>
                <div className="player-roll-result">{rolled!.rolls.map((r, i) => `${checkAttrs[i]?.attr ?? ''} D${rolled!.sides} = ${fmt(r.value)}`).join(' / ')}</div>
                <div className="muted">再掷一颗{isCheck ? `（${checkAttrs[rolled!.rolls.length].attr}）` : `，取${diceMode === 'advantage' ? '高' : '低'}`}。</div>
                <DiceTray persona="player" sides={pending.sides} onResult={throwDie} onError={() => {}} />
              </div>
            : rolled
              ? <div className="player-roll-result">
                  {isCheck
                    ? rolled.rolls.map((r, i) => `${checkAttrs[i].attr} D${rolled.sides} = ${fmt(r.value)}`).join(' / ')
                    : needTwo
                      ? `D${rolled.sides} = ${rolled.rolls.map((r) => fmt(r.value)).join(' / ')} → 采信 ${fmt(rolled.taken)}`
                      : `D${rolled.sides} = ${fmt(rolled.taken)}`}
                </div>
              : <DiceTray persona="player" sides={pending.sides} onResult={throwDie} onError={() => {}} />}
          {rolled && !waitingSecond && <div className="muted">已经送到见证者那边，等他确认后广播全队。</div>}
        </div>;
      })()}
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
