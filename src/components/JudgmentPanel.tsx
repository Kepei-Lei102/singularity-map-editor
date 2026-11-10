import { useState } from 'react';
import { getUI, getWorld, setUI, useUI, useWorld, worldContext } from '../core/store';
import { cancelJudgment, openJudgment, publishJudgment, standInForJudgment } from '../rules/judgments';
import { pushJudgmentRequest } from '../runtime/sync';
import { settleAttack, settleJump } from '../runtime/trial';
import { tokenPosition } from '../scene/architecture';
import type { Id } from '../core/types';
import { DiceTray, type DiceSides, type DiceTrayRecord } from './DiceTray';

interface Setup {
  title: string;
  ruling: string;
  sides: DiceSides;
  subjectId: Id | null;
  place: { mapId: Id; x: number; y: number; label: string } | null;
}

/** 判定角色身上有棋子就用棋子的位置当判定发生点；没棋子就不遮蔽。 */
function subjectPlace(subjectId: string): Setup['place'] {
  if (!subjectId) return null;
  for (const m of getWorld().maps) {
    const t = m.tokens.find((x) => x.pcId === subjectId);
    if (t) { const p = tokenPosition(t); return { mapId: m.id, x: p.x, y: p.y, label: `${m.layer}·${m.name}` }; }
  }
  return null;
}

/** 默认带走当前选中的棋子，省得每次再点一次。 */
function initialSubject(): string {
  const sel = getUI().selection;
  if (sel?.type === 'token') return getWorld().maps.find((m) => m.id === sel.mapId)?.tokens.find((t) => t.id === sel.id)?.pcId ?? '';
  return '';
}

export function JudgmentPanel() {
  useWorld();
  useUI();
  const context = worldContext();
  const pending = getUI().pendingJudgment;
  if (pending) return <PendingJudgmentPanel key={`${context}-${pending.id}`} context={context} />;
  return <JudgmentForm key={context} context={context} />;
}

/** 判定已经开出去了：等玩家掷，见证者这一格只能等、取消，或者代掷。 */
function PendingJudgmentPanel({ context }: { context: string }) {
  const world = useWorld();
  const p = getUI().pendingJudgment!;
  const rawResult = getUI().judgmentResult;
  // 只认属于这一笔判定的骰子。对不上就当没掷过——不然取消一笔重开后，上一颗骰子会被当成新结果。
  const result = rawResult && rawResult.judgmentId === p.id ? rawResult : null;
  const subject = world.party.find((x) => x.id === p.subjectId);
  const [message, setMessage] = useState('');
  const broadcast = () => {
    if (!result) return;
    const err = publishJudgment({
      title: p.title, ruling: p.ruling, recipients: world.party.map((x) => x.id),
      roll: {
        id: result.rollId, sides: result.sides as never, value: result.value,
        tens: result.tens, units: result.units, material: result.material as never,
        persona: result.byStandIn ? 'witness' : 'player', seed: result.seed,
      },
      subjectId: p.subjectId, place: p.place ?? null,
    }, context);
    if (err) return setMessage(err);
    setUI({ pendingJudgment: null, judgmentResult: null });
  };
  const standIn = !!p.standIn;
  // 优劣势的骰由发起者自己掷两次（作者 2026-11-10 定）：玩家窗口会把两颗都送过来，
  // 这里只管用。见证者决定的是「这次算不算优劣势」，不是替玩家掷骰。
  const dice = p.jump?.dice ?? 'single';
  const needTwo = dice !== 'single';
  const fmt = (v: number) => (v === 100 ? '000' : String(v));
  /** 结算要两颗一起交给引擎；只给一颗，引擎会把它当单掷，优劣势就丢了。 */
  const diceValues = result ? (result.values?.length ? result.values : [result.value]) : [];
  const onStandInRoll = (roll: DiceTrayRecord) => {
    // 代掷不能只广播一句「判定成了」：跳跃要挪棋子、攻击要扣血，得先落地再广播。
    if (p.jump) { const e = settleJump(p.jump, [roll.value]); if (e) return setMessage(e); }
    if (p.attack) { const e = settleAttack(p.attack.targetTokenId, roll.value, { sharp: p.attack.sharp }); if (e) return setMessage(e); }
    const err = publishJudgment({
      title: p.title, ruling: p.ruling, recipients: world.party.map((x) => x.id),
      roll: { id: roll.id, sides: roll.sides, value: roll.value, tens: roll.tens, units: roll.units, material: roll.material, persona: 'witness', seed: roll.seed },
      subjectId: p.subjectId, place: p.place ?? null,
    }, context);
    if (err) return setMessage(err);
    setUI({ pendingJudgment: null, judgmentResult: null });
  };
  return <section className="judgment-panel">
    <h3>{standIn ? '代掷中' : `判定已经开出去了 · 等 ${subject?.name ?? '玩家'} 掷骰`}</h3>
    <div><b>{p.title}</b> · D{p.sides} · {subject?.name ?? '角色'}{needTwo ? (dice === 'advantage' ? ' · 优势骰' : ' · 劣势骰') : ''}</div>
    {p.ruling && <div className="muted">你预先写好的裁定（已锁）：{p.ruling}</div>}
    <div className="muted">骰子在他的窗口里。见证者默认不能代掷。</div>
    {standIn && <div>
      <div className="muted">玩家不在电脑前 / 用的是实体骰，你替他掷。</div>
      <DiceTray persona="witness" sides={p.sides} displayResult={result ? { id: result.rollId, sides: result.sides as never, value: result.value, seed: result.seed, material: result.material as never, tens: result.tens, units: result.units } : null}
        onResult={onStandInRoll} onError={setMessage} />
    </div>}
    {!standIn && (result
      ? <div>
          他掷出了：{diceValues.length > 1
            ? `D${result.sides} = ${diceValues.map(fmt).join(' / ')} → 采信 ${fmt(result.value)}`
            : `D${result.sides} = ${fmt(result.value)}`}
          {p.jump && (
            <button onClick={() => {
              // 跳跃走「骰出即生效、生什么效见证者确认」：你按结果执行，再广播。
              const err = settleJump(p.jump!, diceValues);
              if (err) setMessage(err);
              broadcast();
            }}>按结果执行（挪棋子 / 扣血）</button>
          )}
          {p.attack && (
            <button onClick={() => {
              // 攻击骰由发起者掷，落效由见证者确认：扣血/倒地在这里发生，再广播。
              const err = settleAttack(p.attack!.targetTokenId, result.value, { sharp: p.attack!.sharp });
              if (err) setMessage(err);
              broadcast();
            }}>按结果执行（扣血 / 倒地）</button>
          )}
          <button onClick={broadcast}>确认并广播给全队</button>
        </div>
      : <div className="muted">等结果…</div>)}
    {standIn && p.jump && result && (
      <div>
        <button onClick={() => { const err = settleJump(p.jump!, [result.value]); if (err) setMessage(err); broadcast(); }}>按结果执行（挪棋子 / 扣血）</button>
      </div>
    )}
    <div className="btns">
      {!standIn && <button onClick={() => { const e = standInForJudgment(); if (e) setMessage(e); }}>代掷（玩家不在电脑前 / 实体骰）</button>}
      <button onClick={() => setMessage(cancelJudgment() ?? '已取消这个判定')}>取消整个判定</button>
    </div>
    <div role="status">{message}</div>
  </section>;
}

function JudgmentForm({ context }: { context: string }) {
  const world = useWorld();
  const [title, setTitle] = useState('观察检定');
  const [ruling, setRuling] = useState('');
  const [subjectId, setSubjectId] = useState(initialSubject);
  const [sides, setSides] = useState<DiceSides>(20);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [message, setMessage] = useState('');
  const locked = !!setup;

  const confirmSetup = () => {
    if (!title.trim()) return setMessage('先填判定名称，再确认设置');
    if (!world.party.length) return setMessage('还没有角色，判定无法开出');
    if (!subjectId) return setMessage('要指定判定落在谁身上——骰子由他掷');
    const place = subjectPlace(subjectId);
    // 见证者只宣告，不掷；骰子交给玩家。
    const err = openJudgment({ title, ruling, sides, subjectId, place: place ? { mapId: place.mapId, x: place.x, y: place.y } : null });
    if (err) return setMessage(err);
    setSetup({ title: title.trim(), ruling, sides, subjectId, place });
    pushJudgmentRequest(subjectId);
    setMessage('判定已经开出去，等玩家在自己的窗口里掷骰');
  };


  return <section className="judgment-panel">
    <h3>正式骰子判定 · 见证者月亮版</h3>
    <label>判定名称<input value={title} disabled={locked} onChange={e => setTitle(e.target.value)} /></label>
    <label>发生角色（用它棋子的位置当判定地点）
      <select value={subjectId} disabled={locked} onChange={e => setSubjectId(e.target.value)}>
        <option value="">不指定（全队看到细节）</option>
        {world.party.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </label>
    <label>骰子<select value={sides} disabled={locked} onChange={e => setSides(Number(e.target.value) as DiceSides)}>{[4,6,8,10,12,20,100].map(n => <option key={n} value={n}>D{n}</option>)}</select></label>
    {!setup && <div className="muted">骰子在你的玩家窗口里掷。你这里只是宣告：判定名称、落在谁身上、用哪个骰子。</div>}
    <label>见证者裁定（掷之前写好；留空就是只广播骰点）
      <textarea value={ruling} disabled={locked} onChange={e => setRuling(e.target.value)} placeholder="例如：观察成功，发现钟面上的刻痕。" />
    </label>
    <div className="muted">广播对象：全队 {world.party.length} 人。骰子由玩家自己掷，不能拒掷；只有你能取消整个判定。</div>
    {!setup && <button disabled={!title.trim() || !world.party.length || !subjectId} onClick={confirmSetup}>开判定，让玩家掷</button>}
    {setup && <div className="muted">已开出去，等 {world.party.find(p => p.id === setup.subjectId)?.name ?? '玩家'} 掷骰。</div>}
    <div role="status">{message}</div>
    <p className="hint">流程：你宣告（名称 / 落在谁身上 / 骰子 / 预先写好的裁定）→ 玩家在他的窗口里自己掷 → 结果回到你这里 → 你确认后广播全队。裁定在宣告时就锁住，掷完不能改口。</p>
    {[...(world.judgments ?? [])].reverse().slice(0,10).map(j => <article key={j.id}><b>{j.title} · D{j.roll.sides}={j.roll.value===100?'000':j.roll.value}</b><div>{j.ruling}</div></article>)}
  </section>;
}
