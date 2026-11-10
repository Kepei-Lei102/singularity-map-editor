import { useState } from 'react';
import { ALL_TOOLS, GROUP_LABEL, GROUP_ORDER, toolsFor } from './toolGroups';
import { canEditMap, setUI, toast, update, useUI, useWorld, type Tool } from '../core/store';
import { CONN_LABEL, type ConnKind, type Room } from '../core/types';
import { numbering, playerNumbering } from '../scene/render';
import { effectiveLayer } from '../scene/vision';
import { newMap } from '../core/defaults';
import { cellName, uid } from '../core/util';
import { Area, Check, Num, Row, Section, Txt } from './fields';
import { captureRoomReset, resetRoom, saveRoomLayout, deleteRoomLayout, paintFog, setVisionAlgo, nudgeHeight, setHeightArea } from '../runtime/actions';

/** 框选矩形里的所有格子，按行排好。 */
const allCellsIn = (r: { x0: number; y0: number; x1: number; y1: number }): [number, number][] => {
  const out: [number, number][] = [];
  for (let y = Math.min(r.y0, r.y1); y <= Math.max(r.y0, r.y1); y++)
    for (let x = Math.min(r.x0, r.x1); x <= Math.max(r.x0, r.x1); x++) out.push([x, y]);
  return out;
};

export function Sidebar() {
  const w = useWorld();
  const ui = useUI();
  const edit = canEditMap(ui);
  const layers = [...new Set(w.maps.map((m) => m.layer))];
  const tools = ALL_TOOLS.filter(([t]) => toolsFor(ui).includes(t));
  const terrain = w.terrains.find((t) => t.id === ui.terrainId);
  const material = (w.materials ?? []).find((m) => m.id === ui.materialId);
  const cur = w.maps.find((m) => m.id === ui.mapId);

  return (
    <aside className="sidebar">
      <Section title="地图" extra={edit && (
        <button className="small" onClick={() => {
          const m = newMap('新地图', cur?.layer ?? '现实', 1, 24, 16);
          update((d) => { d.maps.push(m); });
          setUI({ mapId: m.id, selection: null });
        }}>＋</button>
      )}>
        {layers.map((layer) => (
          <div key={layer} className="layer">
            <div className="layer-name">{layer}</div>
            {w.maps.filter((m) => m.layer === layer).sort((a, b) => a.floor - b.floor).map((m) => (
              <div key={m.id} className={`map-item ${m.id === ui.mapId ? 'on' : ''}`}
                onClick={() => setUI({ mapId: m.id, selection: null })}>
                <span className="floor">F{m.floor}</span> {m.name}
                {w.playerMapId === m.id && <span title="玩家正在看">👁</span>}
              </div>
            ))}
          </div>
        ))}
      </Section>

      <Section title="工具">
        <div className="tools">
          {GROUP_ORDER.map((g) => {
            const inGroup = tools.filter(([, , , gg]) => gg === g);
            if (!inGroup.length) return null;
            return (
              <div key={g} className="tool-group">
                <div className="tool-group-name">{GROUP_LABEL[g]}</div>
                <div className="tools">
                  {inGroup.map(([t, label, key]) => (
                    <button key={t} className={ui.tool === t ? 'tool on' : 'tool'} aria-label={label}
                      title={key ? `${label} · 快捷键 ${key}` : label}
                      onClick={() => setUI({ tool: t, pendingConn: null })}>{label}</button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {ui.tool === 'pan' && <div className="hint">直接拖动地图平移；从家具、触发区或棋子上拖动也只移动视图，不改变选择。P 切到平移，V 回到选择/移动。</div>}
        {ui.tool.startsWith('fog') && <Row label="迷雾目标"><select value={ui.knowledgeTarget} onChange={e => setUI({ knowledgeTarget: e.target.value })}>
          <option value="">全队</option>{w.party.map(p => <option key={p.id} value={p.id}>{p.name}{w.visionMode === 'grouped' ? ' 所在组' : ''}</option>)}
        </select></Row>}
        {['paint', 'erase', 'd100', 'room', 'fogReveal', 'fogHide', 'fogBlack'].includes(ui.tool) && (
          <Row label="笔刷">
            <span className="inline">
              {[1, 2, 3, 5].map((n) => (
                <button key={n} className={ui.brush === n ? 'chip on' : 'chip'} onClick={() => setUI({ brush: n })}>{n}</button>
              ))}
            </span>
          </Row>
        )}
        {['subdivide', 'unsubdivide'].includes(ui.tool) && <div className="hint">拖出主格矩形，松手整次应用；只有手动细分区启用0.25米吸附。取消不会删除墙、门或棋子。</div>}
        {['wall', 'glass'].includes(ui.tool) && <>
          <Row label="墙厚 mm"><Num value={ui.wallThickness} min={1} max={750} onChange={v => setUI({ wallThickness: Math.max(1, Math.min(750, v)) })} /></Row>
          <div className="hint">在细分区拖出水平或竖直中心线。墙厚向两侧平分；实体墙挡视线，玻璃透视，两者挡路。</div>
        </>}
        {ui.tool === 'archDoor' && <><Row label="门净宽 m"><select value={ui.doorWidth} onChange={e => setUI({ doorWidth: +e.target.value })}>{[2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n * .25}</option>)}</select></Row><div className="hint">点墙放置关闭的门洞；点已有门开关。也可在检查器操作。</div></>}
        {ui.tool === 'conn' && (
          <Row label="类型">
            <select value={ui.connKind} onChange={(e) => setUI({ connKind: e.target.value as ConnKind })}>
              {Object.entries(CONN_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Row>
        )}
        {ui.tool === 'token' && (
          <Row label="放谁">
            <select value={ui.tokenPcId ?? ''} onChange={(e) => setUI({ tokenPcId: e.target.value || null })}>
              <option value="">敌人 / NPC</option>
              {w.party.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Row>
        )}
        {ui.tool === 'd100' && <div className="hint">D100 区域：恐怖副本等，用百分值检定。再刷一次可以擦掉。</div>}
        {ui.tool === 'heightBrush' && (
          <>
            <div className="hint">左键抬高 1 格，按住拖动连续抬；Shift + 左键压低。最低到地面（0）。1 格 = 0.75 米，一层楼挑高 8 格。</div>
            <button className="tool" onClick={() => setUI({ heightValue: 0 })}>全部压平（用框选工具）</button>
          </>
        )}
        {ui.tool === 'heightRect' && (
          <>
            <div className="hint">拖出一片，再在下面填高度应用。压平就是填 0。</div>
            <Row label="高度（格）">
              <Num value={ui.heightValue ?? 1} min={0} step={1} onChange={(v) => setUI({ heightValue: v })} />
            </Row>
            {ui.heightRect && ui.heightRect.mapId === ui.mapId ? (
              <div className="hint">
                选中 {(Math.abs(ui.heightRect.x1 - ui.heightRect.x0) + 1)}×{(Math.abs(ui.heightRect.y1 - ui.heightRect.y0) + 1)} 格
                <div className="tools">
                  <button className="tool" onClick={() => {
                    const n = setHeightArea(ui.mapId, ui.heightRect!, ui.heightValue ?? 1);
                    toast(`整片设成 ${ui.heightValue ?? 1} 格，改了 ${n} 格`);
                    setUI({ heightRect: null });
                  }}>应用</button>
                  <button className="tool" onClick={() => {
                    const n = nudgeHeight(ui.mapId, allCellsIn(ui.heightRect!), 1);
                    toast(`抬高 1 格，改了 ${n} 格`);
                  }}>全部 +1</button>
                  <button className="tool" onClick={() => {
                    const n = nudgeHeight(ui.mapId, allCellsIn(ui.heightRect!), -1);
                    toast(`压低 1 格，改了 ${n} 格`);
                  }}>全部 −1</button>
                  <button className="tool" onClick={() => {
                    const n = setHeightArea(ui.mapId, ui.heightRect!, 0);
                    toast(`压平了 ${n} 格`);
                    setUI({ heightRect: null });
                  }}>压平</button>
                  <button className="tool" onClick={() => setUI({ heightRect: null })}>取消</button>
                </div>
              </div>
            ) : (
              <div className="hint">还没框选。</div>
            )}
          </>
        )}
        {ui.mode === 'edit' && <Check label="显示迷雾" value={ui.showFogInEdit} onChange={(v) => setUI({ showFogInEdit: v })} />}
        {ui.mode === 'edit' && <Check label="规则书视野" value={ui.visionAlgo === 'rulebook'} onChange={(v) => setVisionAlgo(v ? 'rulebook' : 'legacy')} />}
        {ui.mode === 'edit' && (
          <>
            <Row label="画笔精度"><span className="inline">
              <button className={ui.fine ? '' : 'on'} onClick={() => setUI({ fine: false })}>大格</button>
              <button className={ui.fine ? 'on' : ''} onClick={() => setUI({ fine: true, showSubgrid: true })}>小格 1/3</button>
            </span></Row>
            <div className="hint">流程：用「细分为3×3」框选格子（会自动切到小格）。小格里放物件/触发区按 1/3 格吸附，画笔/矩形填充/橡皮改的是子格地形，落到的格子会自动细分；大格画笔会把这一格下的子格覆盖清掉。放完点「大格」回到整格。</div>
          </>
        )}
        <Check label="显示子格线" value={ui.showSubgrid} onChange={(v) => setUI({ showSubgrid: v })} />
        <Check label="显示坐标" value={ui.showRulers} onChange={(v) => setUI({ showRulers: v })} />
        <Check label="显示编号（和给 AI 的图一致）" value={ui.showNumbers} onChange={(v) => setUI({ showNumbers: v })} />
        {ui.tool.startsWith('fog') && cur && (
          <>
            <div className="hint">
              看得见＝实时画面；变灰＝玩家只记得上次看到的样子（之后的变化看不到）；抹黑＝从没来过，记忆也清掉。
              主持人这边会用橙色虚线标出"玩家记得的已经过时"的物件。
            </div>
            <Check label="自动视野（按玩家角色的视线）" value={cur.autoFog} onChange={(v) => update((d) => { d.maps.find((m) => m.id === cur.id)!.autoFog = v; })} />
            <div className="btns">
              <div className="hint">以下整图操作始终作用于全队。</div>
              {([['fogHide', '全队可见的全部变灰'], ['fogReveal', '全队全部看得见'], ['fogBlack', '全队全部抹黑']] as const).map(([kind, label]) =>
                <button key={kind} className="small" onClick={() => paintFog(cur.id, cur.cells.map((_, i) => [i % cur.width, Math.floor(i / cur.width)]), kind)}>{label}</button>)}
            </div>
          </>
        )}
      </Section>

      {ui.showNumbers && cur && (
        <Section title="图例">
          {(ui.trial ? playerNumbering(w, { ...cur, ...effectiveLayer(w, cur, ui.trial.players[ui.trial.current]?.pcId ?? '') }, ui.trial.players[ui.trial.current]?.pcId) : numbering(w, cur)).map((n) => (
            <div key={n.label + n.id} className={`stack-row ${ui.selection && 'id' in ui.selection && ui.selection.id === n.id ? 'on' : ''}`}
              onClick={() => setUI({
                tab: 'inspect',
                selection: n.kind === 'conn' ? { type: 'conn', id: n.id } : n.kind === 'token' ? { type: 'token', mapId: cur.id, id: n.id } : { type: 'object', mapId: cur.id, id: n.id },
              })}>
              <span><b className={`num num-${n.kind}`}>{n.label}</b> {n.name}</span><span className="muted">{cellName(n.x, n.y)}</span>
            </div>
          ))}
        </Section>
      )}

      {edit && cur && <RoomSection mapId={cur.id} rooms={cur.rooms} roomId={ui.roomId} tool={ui.tool} />}

      {edit && (
        <Section title="地形" extra={
          <button className="small" onClick={() => {
            const id = uid();
            update((d) => { d.terrains.push({ id, name: '新地形', color: '#888888', blocksMove: false, visionCoef: 0.1 }); });
            setUI({ terrainId: id, tool: 'paint' });
          }}>＋</button>
        }>
          <div className="swatches">
            {w.terrains.map((t) => (
              <button key={t.id} className={`swatch ${ui.terrainId === t.id ? 'on' : ''}`}
                onClick={() => setUI({ terrainId: t.id, paintLayer: 'terrain', tool: ui.tool === 'fill' ? 'fill' : 'paint' })}>
                <i style={{ background: t.color }} />{t.name}
              </button>
            ))}
          </div>
          {terrain && (
            <div className="card">
              <Row label="名字"><Txt value={terrain.name} onChange={(v) => update((d) => { d.terrains.find((t) => t.id === terrain.id)!.name = v; }, { coalesce: 'tn' + terrain.id })} /></Row>
              <Row label="颜色"><input type="color" value={terrain.color} onChange={(e) => update((d) => { d.terrains.find((t) => t.id === terrain.id)!.color = e.target.value; }, { coalesce: 'tc' + terrain.id })} /></Row>
              <Row label="视野衰减"><Num value={terrain.visionCoef} step={0.1} min={0} onChange={(v) => update((d) => { d.terrains.find((t) => t.id === terrain.id)!.visionCoef = Math.min(1000, Math.max(0, v)); })} /></Row>
              <Check label="不可通行" value={terrain.blocksMove} onChange={(v) => update((d) => { d.terrains.find((t) => t.id === terrain.id)!.blocksMove = v; })} />
              <div className="hint">视野衰减：空地 0.1（≈15 格视野），草丛 2。现在只记录，以后算视野用。</div>
              <button className="danger small" onClick={() => {
                if (!confirm(`删除地形「${terrain.name}」？用了它的格子会变空。`)) return;
                update((d) => {
                  d.terrains = d.terrains.filter((t) => t.id !== terrain.id);
                  d.maps.forEach((m) => { m.cells = m.cells.map((c) => (c === terrain.id ? '' : c)); });
                });
              }}>删除这个地形</button>
            </div>
          )}
        </Section>
      )}

      {edit && (
        <Section title="材质层" extra={
          <button className="small" onClick={() => {
            const id = uid();
            update((d) => { (d.materials ??= []).push({ id, name: '新材质', color: '#888888', friction: 0.5 }); });
            setUI({ materialId: id, paintLayer: 'material', tool: 'paint' });
          }}>＋</button>
        }>
          <div className="hint">地形决定通行和视线；材质只改表面。画笔/矩形/橡皮可以切到这一层，不影响地形。</div>
          <div className="tools">
            <button className={ui.paintLayer === 'terrain' ? 'tool on' : 'tool'} onClick={() => setUI({ paintLayer: 'terrain' })}>地形层</button>
            <button className={ui.paintLayer === 'material' ? 'tool on' : 'tool'} onClick={() => setUI({ paintLayer: 'material' })}>材质层</button>
          </div>
          <div className="swatches">
            {(w.materials ?? []).map((m) => (
              <button key={m.id} className={`swatch ${ui.materialId === m.id && ui.paintLayer === 'material' ? 'on' : ''}`}
                onClick={() => setUI({ materialId: m.id, paintLayer: 'material', tool: ui.tool === 'fill' ? 'fill' : 'paint' })}>
                <i style={{ background: m.color }} />{m.name}
              </button>
            ))}
          </div>
          {material && (
            <div className="card">
              <Row label="名字"><Txt value={material.name} onChange={(v) => update((d) => { d.materials!.find((m) => m.id === material.id)!.name = v; }, { coalesce: 'mn' + material.id })} /></Row>
              <Row label="颜色"><input type="color" value={material.color} onChange={(e) => update((d) => { d.materials!.find((m) => m.id === material.id)!.color = e.target.value; }, { coalesce: 'mc' + material.id })} /></Row>
              <Row label="摩擦（预留）"><Num value={material.friction ?? 0.5} step={0.1} min={0} onChange={(v) => update((d) => { d.materials!.find((m) => m.id === material.id)!.friction = Math.min(10, Math.max(0, v)); })} /></Row>
              <div className="hint">贴图、脚步声先留字段，还没接规则；材质层也不影响视野和通行。</div>
              <button className="danger small" onClick={() => {
                if (!confirm(`删除材质「${material.name}」？铺了它的格子和记忆会一起清掉。`)) return;
                update((d) => {
                  d.materials = (d.materials ?? []).filter((m) => m.id !== material.id);
                  for (const m of d.maps) {
                    for (const [k, v] of Object.entries(m.materialCells ?? {})) if (v === material.id) delete m.materialCells![+k];
                    for (const [k, v] of Object.entries(m.materialSubCells ?? {})) if (v === material.id) delete m.materialSubCells![+k];
                    const memories = [m.seen, ...Object.values(m.views).map((L) => L.seen)];
                    for (const mem of memories) {
                      for (const [k, v] of Object.entries(mem.materialCells ?? {})) if (v === material.id) delete mem.materialCells![+k];
                      for (const [k, v] of Object.entries(mem.materialSubCells ?? {})) if (v === material.id) delete mem.materialSubCells![+k];
                    }
                  }
                });
                const next = (w.materials ?? []).find((m) => m.id !== material.id);
                setUI({ materialId: next?.id ?? '', paintLayer: 'terrain' });
              }}>删除这个材质</button>
            </div>
          )}
        </Section>
      )}
    </aside>
  );
}

const ROOM_COLORS = ['#e8a87c', '#85cdca', '#c38d9e', '#e8d67c', '#9ab87a', '#8fa6d9', '#d98fb5', '#b0a4e3'];

/** 房间：先选一个房间，再用笔刷刷格子。选"擦掉"刷掉格子的房间归属。 */
function RoomSection({ mapId, rooms, roomId, tool }: { mapId: string; rooms: Room[]; roomId: string; tool: Tool }) {
  const room = rooms.find((r) => r.id === roomId);
  const ui = useUI();
  const [layoutDraft, setLayoutDraft] = useState({ roomId: '', name: '', description: '' });
  const draft = layoutDraft.roomId === roomId ? layoutDraft : { roomId, name: '', description: '' };
  const up = (fn: (r: Room) => void, key?: string) =>
    update((d) => { const r = d.maps.find((m) => m.id === mapId)?.rooms.find((x) => x.id === roomId); if (r) fn(r); }, { coalesce: key && key + roomId });
  return (
    <Section title="房间" extra={
      <button className="small" onClick={() => {
        const id = uid();
        update((d) => { d.maps.find((m) => m.id === mapId)!.rooms.push({ id, name: `房间 ${rooms.length + 1}`, color: ROOM_COLORS[rooms.length % ROOM_COLORS.length], note: '', tags: [] }); });
        setUI({ roomId: id, tool: 'room' });
      }}>＋</button>
    }>
      <div className="swatches">
        {rooms.map((r) => (
          <button key={r.id} className={`swatch ${tool === 'room' && roomId === r.id ? 'on' : ''}`} onClick={() => setUI({ roomId: r.id, tool: 'room' })}>
            <i style={{ background: r.color }} />{r.name}
          </button>
        ))}
        <button className={`swatch ${tool === 'room' && !roomId ? 'on' : ''}`} onClick={() => setUI({ roomId: '', tool: 'room' })}>
          <i style={{ background: 'transparent', border: '1px dashed #888' }} />擦掉
        </button>
      </div>
      {rooms.length === 0 && <div className="hint">点 ＋ 新建房间，再用笔刷把格子刷进去。房间有名字和笔记，以后可以挂宫位、八门之类的标签。</div>}
      {room && (
        <div className="card">
          <Row label="名字"><Txt value={room.name} onChange={(v) => up((r) => { r.name = v; }, 'rn')} /></Row>
          <Row label="颜色"><input type="color" value={room.color} onChange={(e) => up((r) => { r.color = e.target.value; }, 'rc')} /></Row>
          <Row label="标签"><Txt value={room.tags.join('，')} placeholder="例如 命宫，死门" onChange={(v) => up((r) => { r.tags = v.split(/[,，、]/).map((t) => t.trim()).filter(Boolean); }, 'rt')} /></Row>
          <Row label="笔记"><Area rows={5} value={room.note} onChange={(v) => up((r) => { r.note = v; }, 'rno')} /></Row>
          <div className="btns">
            <button className="small" onClick={() => captureRoomReset(mapId, room.id)}>记下当前摆位</button>
            <button className="small" disabled={!room.reset} onClick={() => resetRoom(mapId, room.id)}>复位</button>
          </div>
          {room.reset
            ? <div className="hint">复位点：{room.reset.objects.length} 个物件（{new Date(room.reset.at).toLocaleString()}）。带团或试玩中点「复位」，家具和状态都回到这里。</div>
            : <div className="hint">先把房间摆好，再点「记下当前摆位」；之后推乱的推车、打开的隔断都能一键回去。</div>}
          {ui.mode === 'edit' && !ui.trial && <>
            <Row label="排布名称"><Txt value={draft.name} placeholder="例如 通道宽敞 / 书架拥挤"
              onChange={(name) => setLayoutDraft({ ...draft, name })} /></Row>
            <Row label="排布说明"><Area rows={2} value={draft.description}
              onChange={(description) => setLayoutDraft({ ...draft, description })} /></Row>
            <button className="small" onClick={() => {
              const error = saveRoomLayout(mapId, room.id, draft.name, draft.description);
              if (error) toast(error); else setLayoutDraft({ roomId, name: '', description: '' });
            }}>命名保存当前排布</button>
            {room.layouts?.map((l) => <div key={l.id} className="card">
              <div className="card-title"><span>{l.name}{l.id === room.activeLayoutId ? '（本场已选）' : ''}</span><span className="spacer" />
                <button className="danger small" onClick={() => {
                  if (!confirm(`删除排布「${l.name}」？`)) return;
                  const error = deleteRoomLayout(mapId, room.id, l.id); if (error) toast(error);
                }}>删除排布</button>
              </div>
              {l.description && <div className="hint">{l.description}</div>}
              <div className="hint">{l.objects.length} 个物件；在备团的右侧检查器选择本场排布。</div>
            </div>)}
          </>}
          <button className="danger small" onClick={() => {
            if (!confirm(`删除房间「${room.name}」？格子本身不变，只是不再属于这个房间。`)) return;
            update((d) => {
              const m = d.maps.find((x) => x.id === mapId)!;
              m.rooms = m.rooms.filter((r) => r.id !== room.id);
              m.roomCells = m.roomCells.map((c) => (c === room.id ? '' : c));
            });
            setUI({ roomId: '' });
          }}>删除这个房间</button>
        </div>
      )}
    </Section>
  );
}
