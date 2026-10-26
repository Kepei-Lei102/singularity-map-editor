import type { Draft } from 'immer';
import { useState } from 'react';
import { canEditMap, setUI, update, useUI, useWorld, type UIState } from '../store';
import type { Connection, GameMap, MapObject, Secret, Token, World } from '../types';
import { CONN_LABEL, TIERS, TIER_LABEL } from '../types';
import {
  deleteMap, duplicateMap, fillEmptyCells, findMap, giveMapKnowledge, reshapeMaps, setVisionMode, findObj, fireAttach, hideSecret, itemsAt, jumpTo, resizeMap, revealSecret,
  sameSel, setObjectState, setObjectStates,
} from '../actions';
import { CELL_METERS, nearestPc, type Nearest } from '../perception';
import { cellName, parseCell, rangeName, uid } from '../util';
import { MAX_SIDE } from '../schema.js';
import { Area, Check, Num, Row, Section, Txt } from './fields';

export function Inspector() {
  const w = useWorld();
  const ui = useUI();
  const sel = ui.selection;
  const map = findMap(w, ui.mapId);
  if (!map) return null;
  let body: JSX.Element | null = null;
  if (sel?.type === 'object') {
    const o = findObj(w, sel.mapId, sel.id);
    if (o) body = <ObjectInspector key={o.id} world={w} mapId={sel.mapId} o={o} ui={ui} />;
  } else if (sel?.type === 'token') {
    const t = findMap(w, sel.mapId)?.tokens.find((x) => x.id === sel.id);
    if (t) body = <TokenInspector world={w} mapId={sel.mapId} t={t} />;
  } else if (sel?.type === 'conn') {
    const c = w.connections.find((x) => x.id === sel.id);
    if (c) body = <ConnInspector world={w} c={c} editable={canEditMap(ui)} />;
  }
  return (
    <>
      <StackList world={w} map={map} ui={ui} />
      {body ?? (
        <>
          {sel?.type === 'cell' && sel.mapId === map.id && <CellInfo world={w} map={map} x={sel.x} y={sel.y} />}
          <MapInspector world={w} map={map} editable={canEditMap(ui)} />
        </>
      )}
    </>
  );
}

/** 一格多物：列出这一格上的所有东西。 */
function StackList({ world, map, ui }: { world: World; map: GameMap; ui: UIState }) {
  const p = ui.pick;
  if (!p || p.mapId !== map.id) return null;
  const items = itemsAt(world, map, p.x, p.y);
  if (items.length < 2) return null;
  return (
    <Section title={`${cellName(p.x, p.y)} 这一格有 ${items.length} 样东西`}>
      {items.map((it, i) => (
        <div key={i} className={`stack-row ${sameSel(it.sel, ui.selection) ? 'on' : ''}`}
          onClick={() => setUI({ selection: it.sel })}>
          <span>{it.label}</span><span className="muted">{it.kind}</span>
        </div>
      ))}
      <div className="hint">在地图上同一格再点一下，也会依次切换。</div>
    </Section>
  );
}

function CellInfo({ world, map, x, y }: { world: World; map: GameMap; x: number; y: number }) {
  const i = y * map.width + x;
  const t = world.terrains.find((t) => t.id === map.cells[i]);
  const fog = ['没去过', '看得见', '记忆（灰）'][map.fog[i]] ?? '?';
  const room = map.rooms.find((r) => r.id === map.roomCells[i]);
  return (
    <Section title={`格子 ${cellName(x, y)}`}>
      <div className="kv">地形：{t ? `${t.name}（视野衰减 ${t.visionCoef}${t.blocksMove ? '，不可通行' : ''}）` : '空'}</div>
      <div className="kv">检定区域：{map.d100[i] ? 'D100' : 'D20'}　迷雾：{fog}</div>
      {room && (
        <div className="card">
          <div className="card-title"><i className="dot" style={{ background: room.color }} />{room.name}{room.tags.map((t) => <span key={t} className="badge">{t}</span>)}</div>
          {room.note && <div className="note-text">{room.note}</div>}
          <button className="small" onClick={() => setUI({ tool: 'room', roomId: room.id })}>编辑这个房间</button>
        </div>
      )}
      <div className="btns">
        <button className="small" onClick={() => update((d) => { const m = findMap(d, map.id); if (m) m.spawn = { x, y }; })}>
          {map.spawn?.x === x && map.spawn?.y === y ? '⚑ 已是试玩出生点' : '设为试玩出生点'}
        </button>
      </div>
    </Section>
  );
}

function MapInspector({ world, map, editable }: { world: World; map: GameMap; editable: boolean }) {
  const [size, setSize] = useState({ w: map.width, h: map.height, id: map.id });
  if (size.id !== map.id) setSize({ w: map.width, h: map.height, id: map.id });
  const up = (fn: (m: Draft<GameMap>) => void, key?: string) =>
    update((d) => { const m = findMap(d, map.id); if (m) fn(m); }, { coalesce: key });
  const layers = [...new Set(world.maps.map((m) => m.layer))];
  const conns = world.connections.filter((c) => c.a.mapId === map.id || c.b.mapId === map.id);
  const mapName = (id: string) => { const m = findMap(world, id); return m ? `${m.layer}·${m.name}` : '?'; };
  return (
    <Section title="地图">
      {editable ? (
        <>
          <Row label="名字"><Txt value={map.name} onChange={(v) => up((m) => { m.name = v; }, 'mapname' + map.id)} /></Row>
          <Row label="层">
            <Txt value={map.layer} list="layers" onChange={(v) => up((m) => { m.layer = v; }, 'maplayer' + map.id)} />
            <datalist id="layers">{layers.map((l) => <option key={l} value={l} />)}</datalist>
          </Row>
          <Row label="楼层"><Num value={map.floor} onChange={(v) => up((m) => { m.floor = clampInt(v, -1000, 1000); })} /></Row>
          <Row label="尺寸">
            <span className="inline">
              <Num value={size.w} min={2} onChange={(v) => setSize({ ...size, w: v })} />×
              <Num value={size.h} min={2} onChange={(v) => setSize({ ...size, h: v })} />
              {(size.w !== map.width || size.h !== map.height) && <button onClick={() => resizeMap(map.id, size.w, size.h)}>应用</button>}
            </span>
          </Row>
          <ReshapeRow world={world} map={map} />
          <Row label="备注"><Area value={map.notes} onChange={(v) => up((m) => { m.notes = v; }, 'mapnotes' + map.id)} /></Row>
        </>
      ) : (
        <>
          <div className="card-title">{map.layer} · F{map.floor} · {map.name} <span className="muted">{map.width}×{map.height}</span></div>
          {map.notes && <div className="hint">{map.notes}</div>}
        </>
      )}
      {map.variantOf && <div className="hint">复制自：{mapName(map.variantOf)}</div>}
      <div className="sub">
        <div className="sub-title">视野与试玩</div>
        <Row label="视野">
          <select value={world.visionMode} onChange={(e) => setVisionMode(e.target.value as World['visionMode'])}>
            <option value="shared">全队共享</option>
            <option value="individual">各自独立（A 看到的 B 看不到）</option>
          </select>
        </Row>
        <div className="kv">试玩出生点：{map.spawn ? <>{cellName(map.spawn.x, map.spawn.y)} <a className="link" onClick={() => update((d) => { const m = findMap(d, map.id); if (m) m.spawn = null; })}>改回自动</a></> : '自动（最北、最居中的门外）'}</div>
        <div className="btns">
          <button className="small" title="所有没去过的地方变成灰色记忆，只知道地形，不知道里面有什么" onClick={() => giveMapKnowledge(map.id)}>玩家拿到了这张图的地图</button>
        </div>
      </div>
      <div className="btns">
        <button className={world.playerMapId === map.id ? 'on' : ''} onClick={() => update((d) => { d.playerMapId = map.id; })}>
          {world.playerMapId === map.id ? '👁 玩家正在看这张' : '推送给玩家'}
        </button>
        {editable && <>
          <button onClick={() => duplicateMap(map.id)}>复制</button>
          <button onClick={() => duplicateMap(map.id, '梦境')}>复制为梦境版</button>
          <button className="danger" onClick={() => confirm(`删除地图「${map.name}」？`) && deleteMap(map.id)}>删除</button>
        </>}
      </div>
      {conns.length > 0 && (
        <div className="sub">
          <div className="sub-title">连接点</div>
          {conns.map((c) => {
            const here = c.a.mapId === map.id ? c.a : c.b;
            const there = c.a.mapId === map.id ? c.b : c.a;
            return (
              <div key={c.id} className="list-row">
                <span>{CONN_LABEL[c.kind]}{c.label && `「${c.label}」`} {cellName(here.x, here.y)} → {mapName(there.mapId)}</span>
                <button onClick={() => jumpTo(there.mapId, there.x, there.y)}>跳过去</button>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

const rangeBadge = (s: Secret) => `${s.kind === 'auto' ? '自动浮现' : `${s.check || '检定'}骰`} · ≤${s.range}格`;

function distanceNote(s: Secret, near: Nearest | null) {
  if (!near) return <span className="badge">场上没有玩家角色</span>;
  const ok = near.los && near.d <= s.range;
  return (
    <span className={`badge ${ok ? 'ok' : 'warn'}`}>
      {near.name} {near.d} 格{near.los ? '' : '·隔着墙'}{ok ? ' · 在范围内' : ' · 太远'}
    </span>
  );
}

/** 取整并夹在范围里（输入框里打了小数、负数、特别大的数都兜住）。 */
const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : lo)));

function ObjectInspector({ world, mapId, o, ui }: { world: World; mapId: string; o: MapObject; ui: UIState }) {
  const run = ui.mode === 'run';
  const edit = canEditMap(ui);
  const up = (fn: (x: Draft<MapObject>) => void, key?: string) =>
    update((d) => { const x = findObj(d, mapId, o.id); if (x) fn(x); }, { coalesce: key && key + o.id });
  const [privTo, setPrivTo] = useState('');
  const isZone = o.kind === 'zone';
  const map = findMap(world, mapId)!;
  const mapW = map.width, mapH = map.height;
  const near = run ? nearestPc(world, map, o) : null;
  const upSecret = (id: string, fn: (s: Draft<Secret>) => void, key?: string) =>
    up((x) => { fn(x.secrets.find((y) => y.id === id)!); }, key && key + id);

  return (
    <>
      <Section title={isZone ? '触发区' : '物件'} extra={edit && (
        <button className="danger small" onClick={() => {
          update((d) => { const m = findMap(d, mapId)!; m.objects = m.objects.filter((x) => x.id !== o.id); });
          setUI({ selection: null });
        }}>删除</button>
      )}>
        {edit ? (
          <>
            <Row label="名字"><Txt value={o.name} onChange={(v) => up((x) => { x.name = v; }, 'name')} /></Row>
            {!isZone && <Row label="图标"><Txt value={o.icon} placeholder="可填 emoji" onChange={(v) => up((x) => { x.icon = v; }, 'icon')} /></Row>}
            <Row label="颜色"><input type="color" value={o.color} onChange={(e) => up((x) => { x.color = e.target.value; }, 'color')} /></Row>
            <Row label="位置"><CellInput x={o.x} y={o.y} onChange={(p) => up((x) => { x.x = clampInt(p.x, 0, mapW - 1); x.y = clampInt(p.y, 0, mapH - 1); })} /></Row>
            <Row label="大小">
              <span className="inline">
                <Num value={o.w} min={1} max={MAX_SIDE} onChange={(v) => up((x) => { x.w = clampInt(v, 1, MAX_SIDE); })} />×
                <Num value={o.h} min={1} max={MAX_SIDE} onChange={(v) => up((x) => { x.h = clampInt(v, 1, MAX_SIDE); })} />
              </span>
            </Row>
            {!isZone && <Row label="高度 (m)"><Num value={o.height} step={0.1} min={0} onChange={(v) => up((x) => { x.height = Number.isFinite(v) ? Math.min(1000, Math.max(0, v)) : 0; })} /></Row>}
            {!isZone && <Check label="对玩家隐藏" value={o.hidden} onChange={(v) => up((x) => { x.hidden = v; })} />}
            {!isZone && <Check label="可推动（推书架／推车）" value={!!o.pushable} onChange={(v) => up((x) => { if (v) x.pushable = true; else delete x.pushable; })} />}
            {!isZone && o.pushable && <div className="hint">试玩时朝着它走过去，整件东西会向同方向挪一格；后面有墙、家具或人时推不动。带团时仍可以直接拖动。</div>}
            <Row label="主持人备注"><Area value={o.notes} onChange={(v) => up((x) => { x.notes = v; }, 'notes')} /></Row>
          </>
        ) : (
          <>
            <div className="card-title">{o.icon} {o.name} <span className="muted">{rangeName(o)}</span> {!isZone && <span className="muted">{o.height}m</span>}{o.hidden && <span className="badge">对玩家隐藏</span>}</div>
            {o.notes && <div className="hint">备注：{o.notes}</div>}
          </>
        )}
      </Section>

      {!isZone && (
        <Section title="状态">
          <div className="chips">
            {o.states.map((s, i) => (
              <button key={i} className={i === o.state ? 'chip on' : 'chip'} disabled={!run && !edit}
                onClick={() => run ? setObjectState(mapId, o.id, i) : up((x) => { x.state = i; })}>{s || '（空）'}</button>
            ))}
          </div>
          {edit && o.states.length > 1 && (
            <>
              <Check label="按状态挡路（不勾＝按高度算）" value={o.blocksWhen !== undefined}
                onChange={(v) => up((x) => { if (v) x.blocksWhen = [x.state]; else delete x.blocksWhen; })} />
              {o.blocksWhen && (
                <div className="chips">
                  {o.states.map((s, i) => (
                    <label key={i} className="check">
                      <input type="checkbox" checked={o.blocksWhen!.includes(i)}
                        onChange={(e) => up((x) => {
                          const set = new Set(x.blocksWhen ?? []);
                          if (e.target.checked) set.add(i); else set.delete(i);
                          x.blocksWhen = [...set].sort((a, b) => a - b);
                        })} /> {s || '（空）'}
                    </label>
                  ))}
                </div>
              )}
              {o.blocksWhen && <div className="hint">勾上的状态挡路、挡视线；没勾的状态可以从这里穿过。隔断、门这类可开合的物件用这个。</div>}
            </>
          )}
          {edit && <Area rows={2} placeholder="一行一个状态" value={o.states.join('\n')}
            onChange={(v) => setObjectStates(mapId, o.id, v.split('\n'))} />}
          {run && <div className="hint">带团时切换状态会写进记录。</div>}
        </Section>
      )}

      <Section title="看清（隐藏信息）" extra={edit && (
        <button className="small" onClick={() => up((x) => {
          x.secrets.push({ id: uid(), label: '新线索', check: '观察', kind: 'roll', range: 1, tiers: { crit: '', success: '', fail: '', fumble: '' } });
        })}>＋</button>
      )}>
        {o.secrets.length === 0 && <div className="hint">没有。{edit && '点 ＋ 添加。'}</div>}
        {run && o.secrets.some((s) => s.kind === 'roll') && (
          <Row label="私密给">
            <select value={privTo} onChange={(e) => setPrivTo(e.target.value)}>
              <option value="">（选择角色）</option>
              {world.party.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
            </select>
          </Row>
        )}
        {o.secrets.map((s) => (
          <div key={s.id} className="card">
            {edit ? (
              <>
                <div className="inline">
                  <Txt value={s.label} onChange={(v) => upSecret(s.id, (y) => { y.label = v; }, 'sl')} />
                  <button className="danger small" onClick={() => up((x) => { x.secrets = x.secrets.filter((y) => y.id !== s.id); })}>×</button>
                </div>
                <div className="secret-meta">
                  <select value={s.kind} onChange={(e) => upSecret(s.id, (y) => { y.kind = e.target.value as Secret['kind']; })}>
                    <option value="auto">自动浮现</option>
                    <option value="roll">要过骰</option>
                  </select>
                  {s.kind === 'roll' ? <Txt value={s.check} placeholder="检定" onChange={(v) => upSecret(s.id, (y) => { y.check = v; }, 'sc')} /> : <span />}
                  <span className="muted">≤</span>
                  <Num value={s.range} min={0} onChange={(v) => upSecret(s.id, (y) => { y.range = clampInt(v, 0, MAX_SIDE * 2); })} />
                  <span className="muted">格</span>
                </div>
                {s.kind === 'auto' ? (
                  <Row label="看到什么"><Area rows={2} value={s.tiers.success} onChange={(v) => upSecret(s.id, (y) => { y.tiers.success = v; }, 'st')} /></Row>
                ) : TIERS.map((t) => (
                  <Row key={t} label={TIER_LABEL[t]}>
                    <Area rows={2} value={s.tiers[t]} onChange={(v) => upSecret(s.id, (y) => { y.tiers[t] = v; }, 'st' + t)} />
                  </Row>
                ))}
              </>
            ) : (
              <>
                <div className="card-title">{s.label} <span className="badge">{rangeBadge(s)}</span></div>
                {(s.kind === 'auto' ? (['success'] as const) : TIERS).map((t) => (
                  <div key={t} className="tier">
                    <div className="tier-text">{s.kind === 'roll' && <b>{TIER_LABEL[t]} </b>}{s.tiers[t] || <span className="muted">（没写）</span>}</div>
                    {run && !edit && <RevealButtons mapId={mapId} o={o} s={s} t={t} privTo={privTo} />}
                  </div>
                ))}
              </>
            )}
            {run && (
              <div className="reveal-bar">
                {distanceNote(s, near)}
                {s.revealed && <span className="badge ok">已揭示：{s.kind === 'auto' ? '浮现' : TIER_LABEL[s.revealed.tier]}·{s.revealed.scope === 'party' ? '全队' : `私密 ${s.revealed.to ?? ''}`}</span>}
                {edit && (s.kind === 'auto' ? <RevealButtons mapId={mapId} o={o} s={s} t="success" privTo={privTo} />
                  : TIERS.map((t) => <button key={t} className="small" onClick={() => revealSecret(mapId, o.id, s.id, t, 'party')}>{TIER_LABEL[t]}</button>))}
                {s.revealed && <button className="small" onClick={() => hideSecret(mapId, o.id, s.id)}>撤回</button>}
              </div>
            )}
          </div>
        ))}
        {run && o.secrets.some((s) => s.kind === 'auto') && <div className="hint">自动浮现：玩家角色走到范围内、中间没墙，就自动揭示给全队。</div>}
      </Section>

      <Section title="多媒体" extra={edit && world.media.length > 0 && (
        <button className="small" onClick={() => up((x) => {
          x.media.push({ id: uid(), mediaId: world.media[0].id, label: '', trigger: isZone ? 'enter' : 'manual', broadcast: true, once: false });
        })}>＋</button>
      )}>
        {o.media.length === 0 && <div className="hint">没有。{edit && world.media.length === 0 && '先去「媒体库」上传，再回来挂上。'}</div>}
        {o.media.map((a) => {
          const set = (fn: (y: Draft<MapObject['media'][number]>) => void, key?: string) =>
            up((x) => { fn(x.media.find((y) => y.id === a.id)!); }, key);
          const meta = world.media.find((m) => m.id === a.mediaId);
          return (
            <div key={a.id} className="card">
              {edit ? (
                <>
                  <div className="inline">
                    <select value={a.mediaId} onChange={(e) => set((y) => { y.mediaId = e.target.value; })}>
                      {world.media.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                    <button className="danger small" onClick={() => up((x) => { x.media = x.media.filter((y) => y.id !== a.id); })}>×</button>
                  </div>
                  <Row label="标签"><Txt value={a.label} placeholder={meta?.name} onChange={(v) => set((y) => { y.label = v; }, 'ml' + a.id)} /></Row>
                  <Row label="触发">
                    <select value={a.trigger} onChange={(e) => set((y) => { y.trigger = e.target.value as 'manual' | 'enter'; })}>
                      <option value="manual">主持人手动</option>
                      <option value="enter">棋子走进来自动播</option>
                    </select>
                  </Row>
                  <div className="inline">
                    <Check label="同步给玩家" value={a.broadcast} onChange={(v) => set((y) => { y.broadcast = v; })} />
                    <Check label="只触发一次" value={a.once} onChange={(v) => set((y) => { y.once = v; y.fired = false; })} />
                  </div>
                </>
              ) : (
                <div className="list-row">
                  <span>{a.label || meta?.name || '（丢失的文件）'}{a.trigger === 'enter' && ' · 自动'}{a.fired && ' · 已触发'}</span>
                </div>
              )}
              {run && <button className="small" onClick={() => fireAttach(mapId, o.id, a)}>▶ 播放</button>}
            </div>
          );
        })}
      </Section>
    </>
  );
}

function RevealButtons({ mapId, o, s, t, privTo }: { mapId: string; o: MapObject; s: Secret; t: (typeof TIERS)[number]; privTo: string }) {
  return (
    <div className="tier-btns">
      <button className="small" onClick={() => revealSecret(mapId, o.id, s.id, t, 'party')}>全队</button>
      <button className="small" onClick={() => revealSecret(mapId, o.id, s.id, t, 'private', privTo)}>私密</button>
    </div>
  );
}

function TokenInspector({ world, mapId, t }: { world: World; mapId: string; t: Token }) {
  const up = (fn: (x: Draft<Token>) => void, key?: string) =>
    update((d) => { const x = findMap(d, mapId)?.tokens.find((y) => y.id === t.id); if (x) fn(x); }, { coalesce: key && key + t.id });
  return (
    <Section title="棋子" extra={
      <button className="danger small" onClick={() => {
        update((d) => { const m = findMap(d, mapId)!; m.tokens = m.tokens.filter((x) => x.id !== t.id); });
        setUI({ selection: null });
      }}>删除</button>
    }>
      <Row label="名字"><Txt value={t.name} onChange={(v) => up((x) => { x.name = v; }, 'tn')} /></Row>
      <Row label="颜色"><input type="color" value={t.color} onChange={(e) => up((x) => { x.color = e.target.value; }, 'tc')} /></Row>
      <Row label="角色">
        <select value={t.pcId ?? ''} onChange={(e) => up((x) => { x.pcId = e.target.value || null; })}>
          <option value="">（非玩家）</option>
          {world.party.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Row>
      <div className="kv">位置 {cellName(t.x, t.y)}</div>
      {t.pcId && <div className="hint">地图上的三圈是"看清"范围：1 格触手可及 / 5 格一步之遥 / 15 格屋子那头（1 格 = {CELL_METERS} 米，只画看得见的格子）。</div>}
    </Section>
  );
}

function ConnInspector({ world, c, editable }: { world: World; c: Connection; editable: boolean }) {
  const up = (fn: (x: Draft<Connection>) => void, key?: string) =>
    update((d) => { const x = d.connections.find((y) => y.id === c.id); if (x) fn(x); }, { coalesce: key });
  const end = (label: string, p: Connection['a']) => {
    const m = findMap(world, p.mapId);
    return (
      <div className="list-row">
        <span>{label}：{m ? `${m.layer}·${m.name}` : '?'} {cellName(p.x, p.y)}</span>
        <button className="small" onClick={() => jumpTo(p.mapId, p.x, p.y)}>跳过去</button>
      </div>
    );
  };
  return (
    <Section title="连接点" extra={editable && (
      <button className="danger small" onClick={() => {
        update((d) => { d.connections = d.connections.filter((x) => x.id !== c.id); });
        setUI({ selection: null });
      }}>删除</button>
    )}>
      {editable ? (
        <>
          <Row label="类型">
            <select value={c.kind} onChange={(e) => up((x) => { x.kind = e.target.value as Connection['kind']; })}>
              {Object.entries(CONN_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Row>
          <Row label="名字"><Txt value={c.label} onChange={(v) => up((x) => { x.label = v; }, 'cl' + c.id)} /></Row>
          <Check label="对玩家隐藏" value={c.hidden} onChange={(v) => up((x) => { x.hidden = v; })} />
        </>
      ) : (
        <div className="card-title">{CONN_LABEL[c.kind]}{c.label && `「${c.label}」`}{c.hidden && <span className="badge">对玩家隐藏</span>}</div>
      )}
      {end('一端', c.a)}
      {end('另一端', c.b)}
      <div className="hint">双击地图上的连接点也能跳过去。</div>
    </Section>
  );
}

/** 左上角格子，用 Excel 式坐标输入（例如 B8）。 */
function CellInput({ x, y, onChange }: { x: number; y: number; onChange: (p: { x: number; y: number }) => void }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const p = parseCell(text);
    if (p) onChange(p);
    setText(null);
  };
  return (
    <input value={text ?? cellName(x, y)} placeholder="例如 B8" onChange={(e) => setText(e.target.value)}
      onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setText(null); }} />
  );
}

/** 四周扩展（所有楼层一起，保持对齐），以及把空白格铺成某种地形。 */
function ReshapeRow({ world, map }: { world: World; map: GameMap }) {
  const [n, setN] = useState(1);
  const [all, setAll] = useState(true);
  const [terrain, setTerrain] = useState(world.terrains.find((t) => !t.blocksMove)?.id ?? 'floor');
  const empty = map.cells.filter((c) => !c).length;
  return (
    <>
      <Row label="四周扩展">
        <span className="inline">
          <Num value={n} onChange={setN} />
          <span className="muted">格</span>
          <button onClick={() => reshapeMaps(all ? world.maps.map((m) => m.id) : [map.id], n, n, n, n)}>{n >= 0 ? '扩展' : '收缩'}</button>
        </span>
      </Row>
      <Check label="所有楼层一起（保持上下对齐）" value={all} onChange={setAll} />
      {empty > 0 && (
        <Row label="空白格">
          <span className="inline">
            <select value={terrain} onChange={(e) => setTerrain(e.target.value)}>
              {world.terrains.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button onClick={() => fillEmptyCells(map.id, terrain)}>铺满 {empty} 格</button>
          </span>
        </Row>
      )}
    </>
  );
}
