import type { Draft } from 'immer';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { beginBatch, canEditLines, endBatch, getWorld, setUI, update, useUI, useWorld } from '../store';
import type { Flow, FlowEdge, FlowNode, World } from '../types';
import { NODE_H, NODE_W, addChildNode, autoLayout, findObj, partyTags, reachable, setNodeStatus } from '../actions';
import { PATHWAY_SUGGESTIONS } from '../defaults';
import { uid } from '../util';
import { Area, Row, Txt } from './fields';
import { applyAIReply, buildAIContext } from '../ai';
import { canvasToBlob, renderMapForAI } from '../aiRender';
import { download } from '../util';

// 事件流程图（底特律式）：从上往下长。节点 = 事件，连线 = 谁做了什么。
// 虚线 = 预测，亮绿实线 = 走过，暗 + 🔒 = 队伍里没人满足条件。

type Sel = { type: 'node' | 'edge'; id: string } | null;
type Drag =
  | { k: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { k: 'node'; id: string; ox: number; oy: number }
  | { k: 'link'; from: string }
  | { k: 'resize'; sy: number; h: number };

const KIND_LABEL: Record<FlowNode['kind'], string> = { start: '开场', event: '事件', ending: '结局' };

function loadNum(key: string, fallback: number) {
  try { const v = Number(localStorage.getItem(key)); return Number.isFinite(v) && v > 0 ? v : fallback; } catch { return fallback; }
}

export function FlowPanel() {
  const w = useWorld();
  const ui = useUI();
  const editable = canEditLines(ui);
  const run = ui.mode === 'run';
  const flow = w.flows.find((f) => f.id === ui.flowId) ?? w.flows[0];
  const [sel, setSel] = useState<Sel>(null);
  const [view, setView] = useState({ x: 20, y: 20, k: 0.8 });
  const [link, setLink] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [height, setHeight] = useState(() => loadNum('ts-flow-h', 300));
  const [collapsed, setCollapsed] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const fit = () => {
    const el = svg.current;
    const f = getWorld().flows.find((x) => x.id === flow?.id);
    if (!el || !f || !f.nodes.length) return;
    const W = el.clientWidth, H = el.clientHeight;
    if (!W || !H) return;
    const xs = f.nodes.map((n) => n.x), ys = f.nodes.map((n) => n.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const bw = Math.max(...xs) + NODE_W - minX, bh = Math.max(...ys) + NODE_H - minY;
    const k = Math.min(1, (W - 40) / bw, (H - 40) / bh);
    setView({ k, x: (W - bw * k) / 2 - minX * k, y: 20 - minY * k });
  };

  useLayoutEffect(() => { fit(); setSel(null); }, [flow?.id, collapsed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { localStorage.setItem('ts-flow-h', String(height)); } catch { /* 无痕模式 */ } }, [height]);
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const v = viewRef.current;
      const k = Math.max(0.25, Math.min(2, v.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
      setView({ k, x: sx - ((sx - v.x) * k) / v.k, y: sy - ((sy - v.y) * k) / v.k });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [collapsed]);

  const newFlow = () => {
    const id = uid();
    update((d) => {
      d.flows.push({
        id, name: '新流程图', mapId: ui.mapId, edges: [],
        nodes: [{ id: uid(), title: '开场', x: 40, y: 40, kind: 'start', effect: null, origin: 'predicted', status: 'predicted' }],
      });
    });
    setUI({ flowId: id });
  };

  const head = (
    <div className="flow-top" onPointerDown={(e) => {
      if ((e.target as HTMLElement).closest('button,input,select')) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { k: 'resize', sy: e.clientY, h: height };
    }} onPointerMove={(e) => {
      const dr = drag.current;
      if (dr?.k === 'resize') setHeight(Math.max(140, Math.min(window.innerHeight - 200, dr.h - (e.clientY - dr.sy))));
    }} onPointerUp={() => { if (drag.current?.k === 'resize') drag.current = null; }}>
      <span className="flow-title">{run ? '流程图 · 带团' : '流程图 · 预测'}</span>
      {flow && (
        <select value={flow.id} onChange={(e) => setUI({ flowId: e.target.value })}>
          {w.flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      )}
      {editable && flow && (
        <>
          <input className="flow-name" value={flow.name} onChange={(e) => update((d) => { d.flows.find((f) => f.id === flow.id)!.name = e.target.value; }, { coalesce: 'fn' + flow.id })} />
          <select value={flow.mapId ?? ''} title="关联地图：切到这张图时自动显示这张流程图"
            onChange={(e) => update((d) => { d.flows.find((f) => f.id === flow.id)!.mapId = e.target.value || null; })}>
            <option value="">（不关联地图）</option>
            {w.maps.map((m) => <option key={m.id} value={m.id}>{m.layer}·{m.name}</option>)}
          </select>
        </>
      )}
      {editable && <button className="small" onClick={newFlow}>＋ 新流程图</button>}
      {editable && flow && <button className="small" onClick={() => { autoLayout(flow.id); setTimeout(fit, 0); }}>自动排列</button>}
      <button className="small" onClick={fit}>适配</button>
      {editable && flow && <button className="small ai" onClick={() => setAiOpen(true)}>✨ AI 扩写</button>}
      <span className="spacer" />
      <span className="legend"><i className="lg-pred" />预测 <i className="lg-taken" />走过 <i className="lg-lock" />锁住</span>
      <button className="small" onClick={() => setCollapsed(!collapsed)}>{collapsed ? '展开 ▲' : '收起 ▼'}</button>
    </div>
  );

  if (collapsed || !flow) {
    return (
      <div className="flow-panel collapsed">
        {head}
        {!flow && editable && <button onClick={newFlow}>新建流程图</button>}
      </div>
    );
  }

  const tags = partyTags(w);
  const ok = reachable(flow, tags);
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const takenEdges = new Set<string>();
  for (const n of flow.nodes) {
    if (n.status !== 'happened') continue;
    const best = flow.edges
      .filter((e) => e.to === n.id && byId.get(e.from)?.status === 'happened' && (byId.get(e.from)!.at ?? 0) <= (n.at ?? 0))
      .sort((a, b) => (byId.get(b.from)!.at ?? 0) - (byId.get(a.from)!.at ?? 0))[0];
    if (best) takenEdges.add(best.id);
  }
  const toGraph = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (e.clientX - r.left - v.x) / v.k, y: (e.clientY - r.top - v.y) / v.k };
  };
  const nodeAt = (p: { x: number; y: number }) =>
    [...flow.nodes].reverse().find((n) => p.x >= n.x && p.x <= n.x + NODE_W && p.y >= n.y && p.y <= n.y + NODE_H);
  const capture = (e: React.PointerEvent) => { try { svg.current!.setPointerCapture(e.pointerId); } catch { /* 合成事件 */ } };

  const onBgDown = (e: React.PointerEvent) => {
    capture(e);
    setSel(null);
    drag.current = { k: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
  };
  const onNodeDown = (e: React.PointerEvent, n: FlowNode) => {
    e.stopPropagation();
    capture(e);
    setSel({ type: 'node', id: n.id });
    if (!editable) return;
    const p = toGraph(e);
    beginBatch();
    drag.current = { k: 'node', id: n.id, ox: p.x - n.x, oy: p.y - n.y };
  };
  const onHandleDown = (e: React.PointerEvent, n: FlowNode) => {
    e.stopPropagation();
    capture(e);
    drag.current = { k: 'link', from: n.id };
    const p = toGraph(e);
    setLink({ x1: n.x + NODE_W / 2, y1: n.y + NODE_H, x2: p.x, y2: p.y });
  };
  const onMove = (e: React.PointerEvent) => {
    const dr = drag.current;
    if (!dr) return;
    if (dr.k === 'pan') setView({ ...view, x: dr.vx + e.clientX - dr.sx, y: dr.vy + e.clientY - dr.sy });
    else if (dr.k === 'node') {
      const p = toGraph(e);
      const nx = Math.round((p.x - dr.ox) / 10) * 10, ny = Math.round((p.y - dr.oy) / 10) * 10;
      const n = byId.get(dr.id);
      if (n && (n.x !== nx || n.y !== ny))
        update((d) => { const dn = d.flows.find((f) => f.id === flow.id)!.nodes.find((x) => x.id === dr.id)!; dn.x = nx; dn.y = ny; });
    } else if (dr.k === 'link') {
      const p = toGraph(e);
      setLink((l) => l && { ...l, x2: p.x, y2: p.y });
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const dr = drag.current;
    drag.current = null;
    if (dr?.k === 'node') endBatch();
    if (dr?.k === 'link') {
      setLink(null);
      const p = toGraph(e);
      const target = nodeAt(p);
      if (target && target.id !== dr.from) {
        if (!flow.edges.some((x) => x.from === dr.from && x.to === target.id)) {
          const id = uid();
          update((d) => { d.flows.find((f) => f.id === flow.id)!.edges.push({ id, from: dr.from, to: target.id, label: '', condition: '', chance: null }); });
          setSel({ type: 'edge', id });
        }
      } else if (!target) {
        const id = addChildNode(flow.id, dr.from, run, { x: Math.round((p.x - NODE_W / 2) / 10) * 10, y: Math.round(p.y / 10) * 10 });
        setSel({ type: 'node', id });
      }
    }
  };
  const onDouble = (e: React.MouseEvent) => {
    if (!editable || (e.target as Element).closest('.fnode')) return;
    const p = toGraph(e);
    const id = addChildNode(flow.id, null, false, { x: Math.round((p.x - NODE_W / 2) / 10) * 10, y: Math.round((p.y - NODE_H / 2) / 10) * 10 });
    setSel({ type: 'node', id });
  };

  const selNode = sel?.type === 'node' ? byId.get(sel.id) : undefined;
  const selEdge = sel?.type === 'edge' ? flow.edges.find((x) => x.id === sel.id) : undefined;

  return (
    <div className="flow-panel" style={{ height }}>
      {head}
      <div className="flow-body">
        <svg ref={svg} className="flow-svg" onPointerDown={onBgDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={onDouble}>
          <defs>
            {(['pred', 'taken', 'lock'] as const).map((c) => (
              <marker key={c} id={`arrow-${c}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className={`arrow-${c}`} />
              </marker>
            ))}
          </defs>
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {flow.edges.map((e) => {
              const a = byId.get(e.from), b = byId.get(e.to);
              if (!a || !b) return null;
              const x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H, x2 = b.x + NODE_W / 2, y2 = b.y;
              const dy = Math.max(40, Math.abs(y2 - y1) / 2);
              const d = `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
              const locked = !!e.condition && !tags.has(e.condition);
              const taken = takenEdges.has(e.id);
              const cls = taken ? 'taken' : locked || !ok.has(e.from) ? 'lock' : 'pred';
              const label = [e.label, e.condition && `${locked ? '🔒' : '✓'}${e.condition}`, e.chance != null && `${e.chance}%`].filter(Boolean).join(' · ');
              return (
                <g key={e.id} className={`fedge ${cls} ${sel?.id === e.id ? 'sel' : ''}`}
                  onPointerDown={(ev) => { ev.stopPropagation(); setSel({ type: 'edge', id: e.id }); }}>
                  <path d={d} className="hit" />
                  <path d={d} className="line" markerEnd={`url(#arrow-${cls})`} />
                  {label && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 + 4} textAnchor="middle">{label}</text>}
                </g>
              );
            })}
            {link && <path className="flink" d={`M${link.x1},${link.y1} L${link.x2},${link.y2}`} />}
            {flow.nodes.map((n) => {
              const locked = !ok.has(n.id);
              const eo = n.effect && findObj(w, n.effect.mapId, n.effect.objectId);
              return (
                <g key={n.id}>
                  <foreignObject x={n.x} y={n.y} width={NODE_W} height={NODE_H}>
                    <div className={`fnode ${n.kind} ${n.status} ${n.origin} ${locked ? 'locked' : ''} ${sel?.id === n.id ? 'sel' : ''}`}
                      onPointerDown={(e) => onNodeDown(e, n)}
                      onDoubleClick={() => run && !locked && setNodeStatus(flow.id, n.id, n.status === 'happened' ? 'predicted' : 'happened')}>
                      <div className="fnode-title">{n.source === 'ai' && '✨ '}{locked && '🔒 '}{n.kind === 'ending' && '◆ '}{n.title || '（空）'}</div>
                      <div className="fnode-meta">
                        {eo && n.effect ? `→ ${eo.name}：${eo.states[n.effect.toState] ?? '?'}` : KIND_LABEL[n.kind]}
                        {n.status === 'happened' && n.session ? ` · 第${n.session}场` : ''}
                      </div>
                    </div>
                  </foreignObject>
                  {editable && n.kind !== 'ending' && (
                    <circle className="fhandle" cx={n.x + NODE_W / 2} cy={n.y + NODE_H} r={6} onPointerDown={(e) => onHandleDown(e, n)}>
                      <title>拖到别的事件上连线；拖到空白处新建后续事件</title>
                    </circle>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        <div className="flow-side">
          {aiOpen && <AIBridge world={w} flow={flow} onClose={() => { setAiOpen(false); }} />}
          {selNode ? <NodeSide world={w} flow={flow} n={selNode} editable={editable} run={run} locked={!ok.has(selNode.id)} onSelect={setSel} />
            : selEdge ? <EdgeSide world={w} flow={flow} e={selEdge} editable={editable} tags={tags} onSelect={setSel} />
              : <Help editable={editable} run={run} tags={tags} />}
        </div>
      </div>
    </div>
  );
}

function Help({ editable, run, tags }: { editable: boolean; run: boolean; tags: Set<string> }) {
  return (
    <div className="hint">
      {editable && !run && <>双击空白处：新建事件。<br />拖事件底部的小圆点：连到另一个事件，或拖到空白处直接接一个后续。<br />点连线：写"谁做了什么"、条件、概率。<br /></>}
      {run && <>点一个事件，再点"发生了"（或者直接双击事件）：它会描成实线，绑定的物件状态也会跟着变。<br />没预测到的情况：选中事件后点"意外分支"。<br /></>}
      队伍里现在的途径：{tags.size ? [...tags].join('、') : '（没有，去「队伍」里加）'}。条件不满足的分支会锁住。
    </div>
  );
}

function NodeSide({ world, flow, n, editable, run, locked, onSelect }: {
  world: World; flow: Flow; n: FlowNode; editable: boolean; run: boolean; locked: boolean; onSelect: (s: Sel) => void;
}) {
  const up = (fn: (x: Draft<FlowNode>) => void, key?: string) =>
    update((d) => { const x = d.flows.find((f) => f.id === flow.id)?.nodes.find((y) => y.id === n.id); if (x) fn(x); }, { coalesce: key && key + n.id });
  const objects = world.maps.flatMap((m) => m.objects.filter((o) => o.kind === 'object').map((o) => ({ m, o })));
  const eo = n.effect && findObj(world, n.effect.mapId, n.effect.objectId);
  const outs = flow.edges.filter((e) => e.from === n.id);
  const byId = new Map(flow.nodes.map((x) => [x.id, x]));
  return (
    <>
      <div className="side-head">
        <b>{KIND_LABEL[n.kind]}</b>
        {n.origin === 'record' && <span className="badge rec">意外分支</span>}
        {n.status === 'happened' ? <span className="badge ok">发生了 · 第{n.session}场</span> : <span className="badge">预测</span>}
        {locked && <span className="badge warn">🔒 走不到</span>}
        {n.source === 'ai' && <span className="badge ai">✨ AI 生成{editable && <a onClick={() => up((x) => { delete x.source; })}> · 审过了</a>}</span>}
      </div>
      {editable ? (
        <>
          <Area rows={2} value={n.title} onChange={(v) => up((x) => { x.title = v; }, 'nt')} />
          <Row label="类型">
            <select value={n.kind} onChange={(e) => up((x) => { x.kind = e.target.value as FlowNode['kind']; })}>
              {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Row>
          <Row label="物件变化">
            <select value={n.effect ? `${n.effect.mapId}|${n.effect.objectId}` : ''} onChange={(e) => up((x) => {
              const [mapId, objectId] = e.target.value.split('|');
              x.effect = e.target.value ? { mapId, objectId, toState: 0 } : null;
            })}>
              <option value="">（不改变物件）</option>
              {objects.map(({ m, o }) => <option key={o.id} value={`${m.id}|${o.id}`}>{m.layer}·{m.name} / {o.name}</option>)}
            </select>
            {n.effect && eo && (
              <select value={n.effect.toState} onChange={(e) => up((x) => { x.effect!.toState = +e.target.value; })}>
                {eo.states.map((st, i) => <option key={i} value={i}>→ {st}</option>)}
              </select>
            )}
          </Row>
        </>
      ) : (
        <>
          <div className="side-title">{n.title}</div>
          {eo && n.effect && <div className="muted">→ {eo.name}：{eo.states[n.effect.toState]}</div>}
        </>
      )}
      <div className="btns">
        {run && !locked && (n.status === 'predicted'
          ? <button className="on" onClick={() => setNodeStatus(flow.id, n.id, 'happened')}>发生了</button>
          : <button onClick={() => setNodeStatus(flow.id, n.id, 'predicted')}>撤销</button>)}
        {run && <button onClick={() => onSelect({ type: 'node', id: addChildNode(flow.id, n.id, true) })}>＋ 意外分支</button>}
        {editable && !run && <button onClick={() => onSelect({ type: 'node', id: addChildNode(flow.id, n.id, false) })}>＋ 后续事件</button>}
        {editable && (
          <button className="danger" onClick={() => {
            update((d) => {
              const f = d.flows.find((x) => x.id === flow.id)!;
              f.nodes = f.nodes.filter((x) => x.id !== n.id);
              f.edges = f.edges.filter((e) => e.from !== n.id && e.to !== n.id);
            });
            onSelect(null);
          }}>删除</button>
        )}
      </div>
      {outs.length > 0 && (
        <div className="sub">
          <div className="sub-title">接下来可能</div>
          {outs.map((e) => {
            const t = byId.get(e.to);
            return (
              <div key={e.id} className="list-row clickable" onClick={() => onSelect({ type: 'edge', id: e.id })}>
                <span>{e.label || '（没写）'}{e.condition && <span className="muted"> · {e.condition}</span>}{e.chance != null && <span className="muted"> · {e.chance}%</span>} → {t?.title}</span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function EdgeSide({ world, flow, e, editable, tags, onSelect }: {
  world: World; flow: Flow; e: FlowEdge; editable: boolean; tags: Set<string>; onSelect: (s: Sel) => void;
}) {
  const up = (fn: (x: Draft<FlowEdge>) => void, key?: string) =>
    update((d) => { const x = d.flows.find((f) => f.id === flow.id)?.edges.find((y) => y.id === e.id); if (x) fn(x); }, { coalesce: key && key + e.id });
  const from = flow.nodes.find((n) => n.id === e.from), to = flow.nodes.find((n) => n.id === e.to);
  const sum = flow.edges.filter((x) => x.from === e.from && x.chance != null).reduce((s, x) => s + (x.chance ?? 0), 0);
  const locked = !!e.condition && !tags.has(e.condition);
  return (
    <>
      <div className="side-head"><b>连线</b>{locked && <span className="badge warn">🔒 队里没有{e.condition}</span>}</div>
      <div className="muted">{from?.title} → {to?.title}</div>
      {editable ? (
        <>
          <Row label="做了什么"><Txt value={e.label} placeholder="例如：观察小门" onChange={(v) => up((x) => { x.label = v; }, 'el')} /></Row>
          <Row label="条件">
            <Txt value={e.condition} list="flow-pathways" placeholder="留空 = 谁都可以" onChange={(v) => up((x) => { x.condition = v.trim(); }, 'ec')} />
            <datalist id="flow-pathways">{[...new Set([...tags, ...PATHWAY_SUGGESTIONS])].map((p) => <option key={p} value={p} />)}</datalist>
          </Row>
          <Row label="概率 %">
            <input type="number" min={0} max={100} value={e.chance ?? ''} placeholder="不填"
              onChange={(ev) => up((x) => { x.chance = ev.target.value === '' ? null : Math.max(0, Math.min(100, +ev.target.value)); }, 'ep')} />
          </Row>
          <div className={`hint ${sum > 100 ? 'warn-text' : ''}`}>从「{from?.title}」出去的连线，概率合计 {sum}%</div>
          <div className="btns">
            <button className="danger" onClick={() => { update((d) => { const f = d.flows.find((x) => x.id === flow.id)!; f.edges = f.edges.filter((x) => x.id !== e.id); }); onSelect(null); }}>删除连线</button>
          </div>
        </>
      ) : (
        <div className="side-title">{e.label || '（没写）'}{e.condition && ` · 需要${e.condition}`}{e.chance != null && ` · ${e.chance}%`}</div>
      )}
      <div className="btns">
        {from && <button className="small" onClick={() => onSelect({ type: 'node', id: from.id })}>← 起点</button>}
        {to && <button className="small" onClick={() => onSelect({ type: 'node', id: to.id })}>终点 →</button>}
      </div>
      {world.party.length === 0 && <div className="hint">队伍里还没人，带条件的连线都会锁住。</div>}
    </>
  );
}

function AIBridge({ world, flow, onClose }: { world: World; flow: Flow; onClose: () => void }) {
  const [reply, setReply] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const ui = useUI();
  const [mapId, setMapId] = useState(flow.mapId ?? ui.mapId);
  const [pov, setPov] = useState<'kp' | 'player'>('kp');
  const shot = async (how: 'copy' | 'download') => {
    const m = world.maps.find((x) => x.id === mapId);
    if (!m) return;
    const blob = await canvasToBlob(renderMapForAI(world, m, pov));
    if (how === 'download') return download(`${m.layer}-${m.name}-AI视图.png`, blob);
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setMsg('地图图片已复制，可以直接粘贴给 AI。');
    } catch { download(`${m.layer}-${m.name}-AI视图.png`, blob); setMsg('浏览器不让复制图片，已改为下载。'); }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildAIContext(world, flow));
      setMsg('已复制（地图 JSON + 预测分支 JSON + 说明）。贴给 AI，再跟它说"我这里 xxx 要加一个这样的分支"。');
    } catch { setMsg('复制失败，浏览器不让写剪贴板。'); }
  };
  const apply = () => {
    try {
      const r = applyAIReply(getWorld(), flow.id, reply);
      setMsg(`新增 ${r.added} 个事件（标着 ✨），修改 ${r.changed} 个，连线共 ${r.edges} 条。可以撤销（⌘Z）。${r.warnings.length ? '\n注意：' + r.warnings.join('；') : ''}`);
      setReply('');
    } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <div className="ai-box">
      <div className="side-head"><b>✨ AI 扩写分支</b><span className="spacer" /><button className="small" onClick={onClose}>关闭</button></div>
      <div className="hint">① 复制给 AI，然后用大白话跟它说要加什么分支</div>
      <button className="small" onClick={copy}>复制：地图 + 预测分支 + 说明</button>
      <div className="inline">
        <select value={mapId} onChange={(e) => setMapId(e.target.value)}>
          {world.maps.map((m) => <option key={m.id} value={m.id}>{m.layer}·{m.name}</option>)}
        </select>
        <select value={pov} onChange={(e) => setPov(e.target.value as 'kp' | 'player')}>
          <option value="kp">主持人视角</option>
          <option value="player">玩家视角（迷雾）</option>
        </select>
        <button className="small" onClick={() => shot('copy')}>复制地图图片</button>
        <button className="small" onClick={() => shot('download')}>下载</button>
      </div>
      <div className="hint">给有视觉的 AI 看：带坐标和编号，图例里的 id 和 JSON 对得上。</div>
      <div className="hint">② AI 改好后，把它交回的 JSON 粘到这里</div>
      <Area rows={4} value={reply} placeholder="粘贴 AI 的回复（包含 json 代码块即可）" onChange={setReply} />
      <button className="small on" disabled={!reply.trim()} onClick={apply}>校验并合并</button>
      {msg && <div className="hint ai-msg">{msg}</div>}
    </div>
  );
}
