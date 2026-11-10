import { useEffect, useState } from 'react';
import { setUI, useUI, useWorld } from '../core/store';
import { pendingUtterances, resolveUtterance } from '../rules/dialogue';
import { TALK_ACTIONS, guessTalkAction } from '../rules/talkActions';
import { moveBudgetOn } from '../rules/move';
import { intentEnabled, requestTalkIntent, setIntentEnabled, type AdvisorSettings } from '../runtime/sessionAI';

/**
 * 猜动作用的连接设置。跟「本场 AI」面板是两套：
 * 那个是顾问，这个是轻量的分类器，模型可以不同。
 * 地址走本机网关，key 由网关那边持有，前端不碰。
 */
const AI_INTENT_SETTINGS_KEY = 'ts-ai-intent-settings';
const AI_INTENT_DEFAULT: AdvisorSettings = { protocol: 'chat-completions', baseURL: 'http://127.0.0.1:3425/v1', model: 'private-deepseek/deepseek-v4.1-flash-1017' };
function aiIntentSettings(): AdvisorSettings {
  try {
    const raw = localStorage.getItem(AI_INTENT_SETTINGS_KEY);
    if (raw) return { ...AI_INTENT_DEFAULT, ...JSON.parse(raw) };
  } catch { /* 坏的就用默认 */ }
  return AI_INTENT_DEFAULT;
}
import { MARK_LIFE, findMap, giveMapKnowledge, setVisionMode } from '../runtime/actions';
import { HEAR_RANGE } from '../scene/perception';
import {
  MOVE_PER_TURN, actionsLeft, addTrialPlayer, clearTrialStatus, endTrial, setTrialStatus, statusLeft, switchTrialPlayer, toggleTrialPause,
  tickRobots, trialRun, trialSense, trialStance,
  toggleCombat, toggleMarkMode, trialAttack, trialAttackTargets, trialRescue, trialOpportunityAttack, trialSkipOpportunity,
} from '../runtime/trial';

const SYMBOLS = ['!', '?', '★', '✕', '→'];
const STATUS_PRESETS: [string, number][] = [['晕厥', 15], ['泡温泉', 30]];

/** 试玩时浮在地图上的操作栏。 */
export function TrialHud() {
  const ui = useUI();
  const w = useWorld();
  const [stLabel, setStLabel] = useState('');
  const [stMin, setStMin] = useState(15);
  /** 正在把哪句话接成动作，以及接成什么。 */
  const [taking, setTaking] = useState<string | null>(null);
  const [actLabel, setActLabel] = useState('');
  const [actOutcome, setActOutcome] = useState('');
  /** 模型猜出来的动作（正则猜不出时才去问），以及正在问的那条。 */
  const [aiGuess, setAiGuess] = useState<Record<string, string | null>>({});
  const [asking, setAsking] = useState<string | null>(null);
  /** 模型那层的开关；关掉就只用正则。 */
  const [aiOn, setAiOn] = useState<boolean>(() => intentEnabled());
  const t = ui.trial;
  const m = t ? findMap(w, t.mapId) : undefined;
  const waiting = pendingUtterances();
  const statuses = (t?.players ?? []).map((p) => {
    const tok = m?.tokens.find((k) => k.id === p.tokenId);
    return { p, st: tok?.corpse ? { label: '尸体', endsAt: undefined } : tok?.status };
  }).filter((x) => x.st);
  const ticking = statuses.some((x) => x.st?.endsAt !== undefined);
  // 有倒计时的时候每秒刷新一次，顺手让急救机器人到点自动救人
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => { tickRobots(); setTick((n) => n + 1); }, 1000);
    return () => window.clearInterval(id);
  }, [ticking]);
  if (!t) return null;
  const cur = t.players[t.current];
  const curTok = m?.tokens.find((k) => k.id === cur.tokenId);
  const used = cur ? t.moved[cur.tokenId] ?? 0 : 0;
  const color = (pcId: string) => w.party.find((p) => p.id === pcId)?.color ?? '#fff';
  const set = (patch: Partial<typeof t>) => setUI({ trial: { ...t, ...patch } });
  return (
    <div className="trial-hud">
      <div className="trial-row">
        <b>试玩中</b>
        {t.players.map((p, i) => (
          <span key={p.tokenId} className="chip-group">
            <button className={`small chip ${i === t.current ? 'on' : ''} ${p.paused ? 'paused' : ''}`} onClick={() => switchTrialPlayer(i)}>
              <i className="dot" style={{ background: color(p.pcId) }} /> {p.name}
            </button>
            <button className={`small ghost ${p.paused ? 'on' : ''}`} title={p.paused ? '放开这个玩家的操作' : '暂停这个玩家的操作'}
              onClick={() => toggleTrialPause(i)}>{p.paused ? '▶' : '⏸'}</button>
          </span>
        ))}
        {t.players.length < 4 && <button className="small" onClick={addTrialPlayer}>＋ 再放一个</button>}
        <span className="spacer" />
        <button className="small" onClick={endTrial}>退出</button>
      </div>
      <div className="trial-row">
        <label className="check"><input type="checkbox" checked={t.combat} onChange={toggleCombat} /> 战斗模式</label>
        {t.combat
          ? <span>第 {t.turn} 回合 · 行动点 {actionsLeft(t)}/1 · {cur?.name} 已走 {used}/{MOVE_PER_TURN * 3} 子步（3 子步＝1 格，空格结束这一回合）</span>
          : <span className="muted">自由行动：不限步数</span>}
        <span className="spacer" />
        <span className="muted">视野</span>
        <select value={w.visionMode} onChange={(e) => setVisionMode(e.target.value as typeof w.visionMode)}>
          <option value="shared">全队共享</option>
            <option value="grouped">按组共享</option>
          <option value="individual">各自独立</option>
        </select>
        <button className="small" title="所有没去过的地方变成灰色记忆，只知道地形" onClick={() => giveMapKnowledge(t.mapId, cur ? [cur.pcId] : [])}>当前角色 / 组拿到地图</button>
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
      {t.combat && (
        <div className="trial-row">
          <span className="muted">攻击</span>
          {(() => {
            const sharp = !!w.party.find((p) => p.id === cur?.pcId)?.sharp;
            const bluntMode = !(t.sharpAttack ?? false);
            const targets = trialAttackTargets().filter((x) => x.canHit);
            const label = (x: typeof targets[number]) => `${x.name}${x.hp === null ? '' : ` · HP ${x.hp}`}`;
            return <>
              {!targets.length && <span className="muted">攻击距离内没有看得见的目标</span>}
              {targets.map((x) => (
                <button key={x.tokenId} className="small" disabled={!actionsLeft(t)}
                  title={`${x.distance} 格${x.hp === null ? '' : ` · HP ${x.hp}`}；${bluntMode ? '钝器：打倒成昏厥' : '锐器：打倒成濒死'}`}
                  onClick={() => { if (confirm(`用${bluntMode ? '钝器' : '锐器'}攻击 ${x.name}？（D100 攻击口径：000 特大 / 1–5 落空 / 95–99 大成功 / 其余命中，${bluntMode ? '打到 0 是昏厥' : '打到 0 是濒死'}；若这个角色开着玩家窗口，骰子会在他的窗口里掷）`)) trialAttack(x.tokenId, { sharp: !bluntMode }); }}>
                  {label(x)}
                </button>
              ))}
              {/* 钝器默认；只有身上带锐器的角色才给这个勾选 */}
              <label className={`check ${sharp ? '' : 'off'}`} title={sharp ? '勾上就是用锐器：打倒的人进入濒死' : '这个角色身上没有锐器，只能用钝器'}>
                <input type="checkbox" disabled={!sharp || !targets.length} checked={sharp && !bluntMode}
                  onChange={(e) => set({ sharpAttack: e.target.checked })} /> 锐器
              </label>
            </>;
          })()}
          <span className="muted">D100；伤害 1D8；00＝特大成功 ×4；投 1 没打中</span>
          {(() => {
            const down = m?.tokens.filter((k) => k.id !== cur?.tokenId && (k.status?.label === '濒死' || k.down)) ?? [];
            if (!down.length) return null;
            return <span className="inline">
              <span className="muted">救治</span>
              {down.map((k) => (
                <button key={k.id} className="small" disabled={!actionsLeft(t)} title="敏捷 D100，投 1 没救回来；要解锁急救类技能"
                  onClick={() => { if (confirm(`救治 ${k.name}？（敏捷 D100）`)) trialRescue(k.id); }}>
                  {k.name}
                </button>
              ))}
            </span>;
          })()}
        </div>
      )}
      {/* 姿态：只改视野高度。站着看得远，坐和蹲矮一截，躺下最低。 */}
      <div className="trial-row">
        <span className="muted">姿态</span>
        {([['站', '站起'], ['坐', '坐下'], ['蹲', '蹲下'], ['躺', '躺下'], ['趴', '趴下']] as const).map(([s, label]) => (
          <button key={s} className={`small chip ${(curTok?.stance ?? '站') === s ? 'on' : ''}`}
            title={s === '站' ? '站直，看得最远'
              : s === '坐' ? '坐下，视线矮一截'
              : s === '蹲' ? '蹲下，视线矮一截'
              : s === '躺' ? '躺下：基本丧失行动能力，要花行动点才能翻身或起来'
              : '趴下：能动，但按三倍消耗爬'}
            onClick={() => { const e = trialStance(s); if (e) set({ msg: e }); }}>{label}</button>
        ))}
        <span className="muted small-text">推动：朝家具走就是推</span>
      </div>
      {/* 跑法：慢跑不耗蓝不限拐弯；奔跑 2 倍耗 1 ME、整回合只准拐一次；爆跑 3 倍不能拐。 */}
      <div className="trial-row">
        <span className="muted">跑法</span>
        {([['jog', '慢跑'], ['run', '奔跑'], ['sprint', '爆跑']] as const).map(([m, label]) => (
          <button key={m} className={`small chip ${t.runMode === m ? 'on' : ''}`}
            title={m === 'jog' ? '1.5 倍，不耗 ME，不限拐弯，不占行动点'
              : m === 'run' ? '2 倍，耗 1 ME，整回合只能拐一次弯，占行动点'
              : '3 倍，耗 1 ME，不能拐弯，占行动点（能解锁的职业很少）'}
            onClick={() => { const e = trialRun(m); if (e) set({ msg: e }); }}>{label}</button>
        ))}
        <button className={`small chip ${t.runMode ? '' : 'on'}`} onClick={() => { const e = trialRun(null); if (e) set({ msg: e }); }}>正常走</button>
        {(() => {
          // 这一行解释「为什么是这么多格」，挡掉猜不到的疑问。
          const card = w.party.find((p) => p.id === cur?.pcId);
          if (!card) return null;
          const b = moveBudgetOn(card, m?.layer ?? '现实');
          const stored = t.charge?.[cur?.tokenId ?? '']?.cells ?? 0;
          return (
            <span className="muted small-text">
              {b.kind === 'mental' ? '心理' : '物理'} {b.cells} 格{stored ? `（+${stored} 蓄）` : ''}
              {card.me != null ? ` · ME ${card.me}` : ''}
            </span>
          );
        })()}
      </div>
      {/* 感知动作：四个都掷骰，掷完把候选摆给见证者挑。 */}
      <div className="trial-row">
        <span className="muted">感知</span>
        {([['observe', '观察'], ['search', '搜索'], ['smell', '嗅闻'], ['listen', '倾听']] as const).map(([k, label]) => (
          <button key={k} className="small chip" title={k === 'search' ? '敏捷和观察各掷一次，两个都过才算成功' : '掷观察'}
            onClick={() => trialSense(k)}>{label}</button>
        ))}
        {t.sense && (
          <span className="muted small-text">
            上次：{t.sense.roll.rolls.map((r) => `${r.attr} ${r.value === 100 ? '00' : r.value}${r.success ? '✓' : '✗'}`).join('，')}
            {t.sense.hints.length ? ` · ${t.sense.hints.length} 条候选` : ' · 没有候选，自己写'}
          </span>
        )}
      </div>
      {t.opportunity && (
        <div className="trial-row trial-opportunity">
          <span className="badge warn">借机攻击！</span>
          <span className="muted">{m?.tokens.filter((k) => t.opportunity!.enemies.includes(k.id)).map((k) => k.name).join('、')} 可以顺势打一下</span>
          <button className="small" onClick={trialOpportunityAttack}>打</button>
          <button className="small" onClick={trialSkipOpportunity}>不打</button>
        </div>
      )}
      {statuses.length > 0 && (
        <div className="trial-row">
          {statuses.map(({ p, st }) => (
            <span key={p.tokenId} className="badge warn">
              {p.name} · {st!.label} · {statusLeft(st!) ?? '已结束'} <a className="link" onClick={() => clearTrialStatus(p.tokenId)}>×</a>
            </span>
          ))}
        </div>
      )}
      {waiting.length > 0 && (
        <div className="trial-says">
          <div className="trial-says-head">
            玩家说的话 <span className="muted">（{waiting.length} 条还没接住）</span>
            <span className="spacer" />
            {/* 网关挂了或太慢时可以关掉：关掉之后只靠正则，照样能接。 */}
            <label className="check small-text" title="关掉之后只靠关键字猜，不再问本机模型">
              <input type="checkbox" checked={aiOn} onChange={(e) => { const v = e.target.checked; setAiOn(v); setIntentEnabled(v); }} /> 模型辅助
            </label>
          </div>
          {waiting.map((u) => (
            <div key={u.id} className="trial-say">
              <div><b>{u.pcName}</b>{u.targetName && <span className="muted"> → {u.targetName}</span>}：「{u.text}」</div>
              {taking === u.id ? (
                <div className="trial-say-form">
                  {/* 白卡的交流动作就这 10 个，点一下就接住，不用手打。
                      原话里带「吵」「求」这类字眼时，把最可能的那个标出来。 */}
                  {asking === u.id && <div className="muted small-text">在想…</div>}
                  <div className="trial-say-chips">
                    {TALK_ACTIONS.map((a) => {
                      // 正则优先；正则没结果就用模型猜的（猜不出来就是 null）
                      const guess = guessTalkAction(u.text)?.name ?? aiGuess[u.id] ?? null;
                      return (
                        <button key={a.name} className={`small chip ${guess === a.name ? 'on' : ''}`}
                          title={a.what} onClick={() => { resolveUtterance(u.id, { label: a.name }); setTaking(null); }}>
                          {a.name}
                        </button>
                      );
                    })}
                  </div>
                  <input value={actLabel} placeholder="或者自己写一个动作（不是这 10 个的时候）"
                    onChange={(e) => setActLabel(e.target.value)} />
                  <input value={actOutcome} placeholder="结果（可不填）"
                    onChange={(e) => setActOutcome(e.target.value)} />
                  <div className="trial-say-ops">
                    <button className="small primary" disabled={!actLabel.trim()} onClick={() => {
                      resolveUtterance(u.id, { label: actLabel, outcome: actOutcome });
                      setTaking(null); setActLabel(''); setActOutcome('');
                    }}>接住</button>
                    <button className="small" onClick={() => { setTaking(null); setActLabel(''); setActOutcome(''); }}>算了</button>
                  </div>
                </div>
              ) : (
                <button className="small" onClick={() => {
                  setTaking(u.id); setActLabel(''); setActOutcome('');
                  // 正则猜不出来才问模型。问到了就记下来，不用重复问。
                  if (!guessTalkAction(u.text) && intentEnabled() && aiGuess[u.id] === undefined) {
                    setAsking(u.id);
                    const ctl = new AbortController();
                    requestTalkIntent(u.text, aiIntentSettings(), '', ctl.signal).then((r) => {
                      setAiGuess((m) => ({ ...m, [u.id]: 'action' in r ? r.action : null }));
                      setAsking((k) => (k === u.id ? null : k));
                    });
                  }
                }}>接成动作…</button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="muted small-text">在主持人窗口用 WASD 移动 · Tab 或角色按钮换人 · G 放标记 · Esc 退出；独立玩家窗口同步视角（退出后恢复原样）</div>
      {/* 攻击/伤害已经单独在 TrialEventCard 里，这里的 msg 只放转向、推不动这类小提示 */}
      {t.msg && <div className="trial-msg">{t.msg}</div>}
    </div>
  );
}
