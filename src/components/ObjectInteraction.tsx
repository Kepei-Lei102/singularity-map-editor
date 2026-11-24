import { useEffect, useMemo, useRef, useState } from 'react';
import type { ObjectInteraction, ObjectInteractionOverride, Precondition, World } from '../core/types';
import { TIER_LABEL, TIERS, type MapObject, type Tier } from '../core/types';
import { getUI, toast, update } from '../core/store';
import { MAX_SIDE } from '../core/schema.js';
import { ACTION_LIBRARY, PANEL_ACTIONS, actionById, actionCheckSpec, type RawAction } from '../rules/actionLibrary';
import { resolve, type Advantage, type Attr, type CheckResult, type CheckSpec } from '../rules/interaction';
import { physicalActionError } from '../rules/physicalAction';
import { objectOutcomePlan } from '../rules/objectInteraction';
import { interactionPreviewValid, makeInteractionPreviewSnapshot, type InteractionPreviewSnapshot } from '../rules/interactionPreview';
import { commitObjectInteraction } from '../runtime/objectInteraction';
import { Section, Row, Txt } from './fields';

interface Props {
  world: World;
  mapId: string;
  o: MapObject;
  edit: boolean;
  /** 试玩时默认选当前行动的玩家；没有就落第一个角色。 */
  defaultActorId?: string;
}

const MODE_TEXT: Record<string, string> = {
  single: '单属性', or: '并集（或）', and: '交集（与）', sum: '三项叠加',
};

interface Preview {
  result: CheckResult;
  plan: { from: number; to: number } | null;
  spec: CheckSpec;
  snapshot: InteractionPreviewSnapshot;
}

function ActionPick({ value, onChange, list }: { value: string; onChange: (id: string) => void; list: RawAction[] }) {
  const [q, setQ] = useState('');
  const visible = useMemo(() => {
    const key = q.trim().toLowerCase();
    const hit = key
      ? list.filter((a) => `${a.id} ${a.name} ${a.category}`.toLowerCase().includes(key))
      : list;
    // 当前选中的动作即使被搜索过滤掉，也保留在选项里，避免 select 显示空白。
    return hit.some((a) => a.id === value) ? hit : [...hit, ...list.filter((a) => a.id === value)];
  }, [q, list, value]);
  return (
    <>
      <input value={q} placeholder="搜动作名 / 编号" onChange={(e) => setQ(e.target.value)} />
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {visible.map((a) => <option key={a.id} value={a.id}>{a.id} {a.name} · {a.category}</option>)}
      </select>
    </>
  );
}

const splitTags = (v: string) => [...new Set(v.split(/[,，]/).map((s) => s.trim()).filter(Boolean))];

const preconditionProps = (ov: ObjectInteractionOverride) =>
  (ov.preconditions ?? []).filter((p) => p.kind === 'targetHasProp').map((p) => p.prop);
const preconditionActorTags = (ov: ObjectInteractionOverride) =>
  (ov.preconditions ?? []).filter((p) => p.kind === 'actorHas').map((p) => p.tag);
const stateConditions = (ov: ObjectInteractionOverride) =>
  (ov.preconditions ?? []).filter((p): p is Extract<Precondition, { kind: 'targetStateIn' }> => p.kind === 'targetStateIn');

function Mapping({ mapId, o }: { mapId: string; o: MapObject }) {
  const oi = o.interaction;
  const mut = (fn: (x: ObjectInteraction) => void) => update((d) => {
    const dm = d.maps.find((m) => m.id === mapId);
    const dobj = dm?.objects.find((x) => x.id === o.id);
    if (!dobj) return;
    if (!dobj.interaction) dobj.interaction = { overrides: [] };
    fn(dobj.interaction);
  });
  const setOutcome = (index: number, tier: Tier, value: string) => mut((x) => {
    const ov = x.overrides[index];
    if (!ov) return;
    if (!value) delete ov.outcomes[tier];
    else ov.outcomes[tier] = +value;
  });
  const setRange = (index: number, text: string) => {
    const trimmed = text.trim();
    const n = Number(trimmed);
    mut((x) => {
      const ov = x.overrides[index];
      if (!ov) return;
      if (!trimmed) { delete ov.range; return; }
      if (Number.isFinite(n)) ov.range = Math.max(0, Math.min(MAX_SIDE, Math.round(n)));
    });
  };
  const setConditions = (index: number, kind: 'targetHasProp' | 'actorHas' | 'targetStateIn', next: Precondition[]) => mut((x) => {
    const ov = x.overrides[index];
    if (!ov) return;
    const rest = (ov.preconditions ?? []).filter((p) => p.kind !== kind);
    const list = [...rest, ...next];
    if (list.length) ov.preconditions = list;
    else delete ov.preconditions;
  });
  const toggleState = (index: number, conditionIndex: number, state: number) => {
    const ov = o.interaction?.overrides[index];
    if (!ov) return;
    const conditions = stateConditions(ov);
    const target = conditions[conditionIndex];
    const current = target?.states ?? [];
    const next = current.includes(state) ? current.filter((x) => x !== state) : [...current, state].sort((a, b) => a - b);
    const rest = conditions.filter((_, j) => j !== conditionIndex);
    const list = [...rest];
    if (next.length) list.push({ kind: 'targetStateIn', states: next });
    const deduped = list.filter((p, i) => !list.slice(0, i).some((x) => x.states.length === p.states.length && x.states.every((v, k) => v === p.states[k])));
    setConditions(index, 'targetStateIn', deduped);
  };
  if (!oi) return <Section title="互动（模组）">
    <div className="hint">这个物件还没有互动档案。先建一份，再给「动作 × 本物件」配四档结果。</div>
    <div className="btns"><button onClick={() => mut(() => {})}>＋建互动档案</button></div>
  </Section>;
  return <Section title="互动（模组）">
    <div className="hint">效果只在模组里，不进公共动作库。四档各选一个本物件状态；留空＝这一档没有预置效果。动作条件不满足时，「看结果」会被拦住。</div>
    <Row label="材质"><Txt value={oi.material ?? ''} placeholder="作者备注，如 橡皮泥" onChange={(v) => mut((x) => { if (v.trim()) x.material = v.trim(); else delete x.material; })} /></Row>
    <Row label="标签"><Txt value={(oi.tags ?? []).join(', ')} placeholder="逗号分隔" onChange={(v) => mut((x) => { x.tags = v.split(/[,，]/).map((s) => s.trim()).filter(Boolean); })} /></Row>
    <div className="btns"><button className="small" onClick={() => mut((x) => { const used = new Set(x.overrides.map((o) => o.actionId)); const next = ACTION_LIBRARY.find((a) => !used.has(a.id)); if (next) x.overrides.push({ actionId: next.id, outcomes: {} }); })}>＋加一个动作</button></div>
    {!oi.overrides.length && <div className="hint">还没有动作。加一个后给它配四档。</div>}
    {oi.overrides.map((ov, i) => <div key={i} className="card">
      <div className="card-title"><ActionPick value={ov.actionId} list={ACTION_LIBRARY} onChange={(id) => {
        if (o.interaction?.overrides.some((x, k) => k !== i && x.actionId === id)) { toast('这个动作已经在这件物件上了'); return; }
        mut((x) => { x.overrides[i].actionId = id; });
      }} /></div>
      <div className="btns"><button className="danger small" onClick={() => mut((x) => { x.overrides.splice(i, 1); })}>删掉这个动作</button></div>
      <div className="hint">动作条件：距离留空＝贴身 1 格；目标状态/标签、发动者标签留空＝不限制。</div>
      <Row label="距离（格）"><Txt value={ov.range === undefined ? '' : String(ov.range)} placeholder="留空＝1" onChange={(v) => setRange(i, v)} /></Row>
      <Row label="目标状态">
        {(() => {
          const conditions = stateConditions(ov);
          const groups = conditions.length ? conditions : [null];
          return <>
            {groups.map((p, j) => <div key={j} className="chips">
              {conditions.length > 1 && <span className="muted">条件 {j + 1}</span>}
              {o.states.map((s, k) => <label key={k} className="check"><input type="checkbox" checked={p?.states.includes(k) ?? false} onChange={() => toggleState(i, j, k)} /> {k} {s}</label>)}
            </div>)}
            {conditions.length > 1 && <div className="hint">多条目标状态条件是「且」关系：每条都要满足才能发动。</div>}
          </>;
        })()}
      </Row>
      <Row label="目标标签"><Txt value={preconditionProps(ov).join(', ')} placeholder="物件标签，如 易燃物" onChange={(v) => setConditions(i, 'targetHasProp', splitTags(v).map((prop) => ({ kind: 'targetHasProp', prop })))} /></Row>
      <Row label="发动者标签"><Txt value={preconditionActorTags(ov).join(', ')} placeholder="角色标签（途径/职业）" onChange={(v) => setConditions(i, 'actorHas', splitTags(v).map((tag) => ({ kind: 'actorHas', tag })))} /></Row>
      {TIERS.map((tier) => <Row key={tier} label={TIER_LABEL[tier]}>
        <select value={ov.outcomes[tier] ?? ''} onChange={(e) => setOutcome(i, tier, e.target.value)}>
          <option value="">无效果</option>
          {o.states.map((s, k) => <option key={k} value={k}>{k} {s}</option>)}
        </select>
      </Row>)}
    </div>)}
  </Section>;
}

function parseRolls(text: string): number[] {
  return text.split(/[,，\s]+/).map((s) => Number(s)).filter((n) => Number.isFinite(n));
}

function RunPanel({ world, mapId, o, defaultActorId }: { world: World; mapId: string; o: MapObject; defaultActorId?: string }) {
  const mappedAction = o.interaction?.overrides.find((x) => PANEL_ACTIONS.some((a) => a.id === x.actionId))?.actionId;
  const [actorId, setActorId] = useState(() => defaultActorId ?? world.party[0]?.id ?? '');
  const [actionId, setActionId] = useState(mappedAction ?? PANEL_ACTIONS[0]?.id ?? '');
  const [rolls, setRolls] = useState<Record<string, string>>({});
  const [advantage, setAdvantage] = useState<Advantage>('normal');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [msg, setMsg] = useState('');
  const committing = useRef(false);
  const appliedDefault = useRef<string | null>(null);
  const actor = world.party.find((p) => p.id === actorId);
  const action = actionById(actionId);
  const checked = action ? actionCheckSpec(action) : { error: '找不到动作' };
  const spec = 'spec' in checked ? checked.spec : null;
  const map = world.maps.find((m) => m.id === mapId);
  const gate = map && actor ? physicalActionError({ world, map, object: o, actor, actionId, trial: getUI().trial }) : null;

  useEffect(() => {
    if (!defaultActorId) appliedDefault.current = null;
    else if (defaultActorId !== appliedDefault.current && world.party.some((p) => p.id === defaultActorId)) {
      appliedDefault.current = defaultActorId;
      setActorId(defaultActorId);
    }
    if (!world.party.some((p) => p.id === actorId)) setActorId(world.party[0]?.id ?? '');
  }, [world.party, actorId, defaultActorId]);
  useEffect(() => { setRolls({}); setPreview(null); setMsg(''); }, [actionId, advantage]);
  useEffect(() => { setPreview(null); }, [o.state]);
  useEffect(() => { setPreview(null); setMsg(''); setRolls({}); }, [actorId, o.id]);
  useEffect(() => { if (!preview) committing.current = false; }, [preview]);
  // 发起条件变了（换人、行动点被吃掉、人物走开、物件被禁用）就把旧预览清掉，
  // 不能让主持人拿一份条件已经不成立的预览去落账。
  useEffect(() => { if (preview && gate) { setPreview(null); setMsg(gate); } }, [preview, gate]);

  const rollKeyOf = (attrs: string[]) => attrs.map((attr) => (rolls[attr] ?? '').trim()).join('|');
  const snapshotOf = (): InteractionPreviewSnapshot => makeInteractionPreviewSnapshot({
    mapId, objectId: o.id, actorId, actionId, advantage,
    rollKey: rollKeyOf(spec?.attributes ?? []),
    state: o.state,
    actorAttributes: actor?.attributes ?? null,
    interaction: o.interaction ?? null,
    states: o.states,
  });
  const freshPreview = preview && interactionPreviewValid(preview.snapshot, snapshotOf()) ? preview : null;
  // 地图/六维/映射/状态名这些不在下拉和输入框的依赖里，靠派生比对发现；
  // 发现旧预览失效就清掉，避免改回原值又冒出来。
  useEffect(() => {
    if (preview && !freshPreview) { setPreview(null); setMsg('输入或物件已经变了，请重新看结果'); }
  }, [preview, freshPreview]);
  const setRoll = (attr: string, value: string) => {
    setRolls((x) => ({ ...x, [attr]: value }));
    setPreview(null);
    setMsg('');
  };
  const doPreview = () => {
    setPreview(null);
    setMsg('');
    if (!spec || !actor) { setMsg('先选动作和角色'); return; }
    if (!map) { setMsg('找不到地图'); return; }
    const gateNow = physicalActionError({ world, map, object: o, actor, actionId, trial: getUI().trial });
    if (gateNow) { setMsg(gateNow); return; }
    const attrs = actor.attributes as Record<Attr, number> | undefined;
    if (!attrs) { setMsg(`${actor.name} 还没填六维`); return; }
    const d20s: number[][] = spec.attributes.map((attr) => {
      const parsed = parseRolls(rolls[attr] ?? '');
      return parsed;
    });
    const bad = spec.attributes.find((attr, i) => {
      const need = advantage === 'normal' ? 1 : 2;
      return d20s[i].length !== need || d20s[i].some((n) => !Number.isInteger(n) || n < 1 || n > 20);
    });
    if (bad) { setMsg(`【${bad}】要填 ${advantage === 'normal' ? '一颗' : '两颗'} 1–20 的骰点`); return; }
    const result = resolve({ check: spec, actor: attrs, d20s, advantage });
    const plan = result.tier ? objectOutcomePlan(o, actionId, result.tier) : null;
    setPreview({ result, plan, spec, snapshot: snapshotOf() });
    setMsg(plan ? '' : '这一档没配效果；可以换档或先到编辑模式补映射');
  };

  if (!PANEL_ACTIONS.length) return <Section title="发起互动"><div className="hint">动作库没有可掷的动作。</div></Section>;
  if (!action) return <Section title="发起互动"><div className="hint">找不到动作。</div></Section>;
  if (!('spec' in checked)) return <Section title="发起互动">
    <div className="hint">{checked.error}</div>
    <ActionPick value={actionId} list={PANEL_ACTIONS} onChange={setActionId} />
  </Section>;

  return <Section title="发起互动">
    <div className="hint">只改本物件状态；确认后才落账。v0.1 按 D20；动作库判定依据里的情境条件（比如舞蹈有经验才是优势）由主持人用「骰势」决定。</div>
    <Row label="角色"><select value={actorId} onChange={(e) => { setActorId(e.target.value); setPreview(null); setMsg(''); }}>{world.party.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Row>
    <div className="row-label">动作</div>
    <ActionPick value={actionId} list={PANEL_ACTIONS} onChange={setActionId} />
    <div className="hint">{action.name} · {checked.label} · DC {20} · {MODE_TEXT[checked.spec.mode] ?? checked.spec.mode}</div>
    <Row label="骰势"><select value={advantage} onChange={(e) => setAdvantage(e.target.value as Advantage)}>
      <option value="normal">正常（一颗）</option><option value="advantage">优势（两颗取高）</option><option value="disadvantage">劣势（两颗取低）</option>
    </select></Row>
    {checked.spec.attributes.map((attr) => <Row key={attr} label={attr}>
      <input value={rolls[attr] ?? ''} placeholder={advantage === 'normal' ? 'D20 点数' : 'D20 两颗，逗号隔开'} onChange={(e) => setRoll(attr, e.target.value)} />
    </Row>)}
    {gate && <div className="hint">{gate}</div>}
    <div className="btns"><button onClick={doPreview} disabled={!!gate}>看结果</button></div>
    {msg && <div className="hint">{msg}</div>}
    {preview && !freshPreview && <div className="hint">输入或物件已经变了，请重新看结果。</div>}
    {freshPreview && <>
      <div className="card">
        <div className="card-title">{freshPreview.result.tier ? TIER_LABEL[freshPreview.result.tier] : '见证者裁决'} · {freshPreview.result.success ? '过' : '没过'}</div>
        {freshPreview.result.rolls.map((r) => <div key={r.attr} className="kv">{r.attr}：{r.rolls.length > 1 ? `${r.rolls.join('/')}→取${r.roll}` : r.roll}+{r.value} = {r.total} {r.pass ? '✓' : '✗'}</div>)}
        {freshPreview.plan
          ? <><div className="kv">{o.name}：{o.states[freshPreview.plan.from]} → {o.states[freshPreview.plan.to]}</div>
            {freshPreview.plan.from === freshPreview.plan.to && <div className="hint">这一档不改变状态；确认仍会落一条空 delta（战斗里占行动点）。</div>}</>
          : <div className="hint">这一档没有预置效果，不落账。</div>}
      </div>
      <div className="btns">
        <button className="small" onClick={() => { setPreview(null); setMsg(''); }}>取消预览</button>
        {freshPreview.plan && !gate && <button onClick={() => {
          if (committing.current) return;
          if (!interactionPreviewValid(freshPreview.snapshot, snapshotOf())) {
            setMsg('输入或物件已经变了，请重新看结果');
            setPreview(null);
            return;
          }
          committing.current = true;
          const merge = checked.spec.mode === 'single' ? 'single' : checked.spec.mode === 'or' ? 'any' : 'all';
          const err = commitObjectInteraction({
            mapId, objectId: o.id, actorId, actionId, actionName: action.name,
            result: freshPreview.result, merge, scale: 'd20', advantage,
          });
          setMsg(err ?? '已落账');
          if (err) committing.current = false;
          else setPreview(null);
        }}>确认，落账</button>}
      </div>
    </>}
  </Section>;
}

export function ObjectInteractionPanel({ world, mapId, o, edit, defaultActorId }: Props) {
  return edit ? <Mapping mapId={mapId} o={o} /> : <RunPanel world={world} mapId={mapId} o={o} defaultActorId={defaultActorId} />;
}
