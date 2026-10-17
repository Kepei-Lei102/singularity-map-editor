import { canEditMap, setUI, update, useUI, useWorld, type Mode, type Tool, type UIState } from '../store';
import { CONN_LABEL, type ConnKind, type Room } from '../types';
import { numbering } from '../render';
import { newMap } from '../defaults';
import { cellName, uid } from '../util';
import { Area, Check, Num, Row, Section, Txt } from './fields';

const ALL_TOOLS: [Tool, string, string][] = [
  ['select', '选择/移动', 'V'],
  ['paint', '画笔', 'B'],
  ['fill', '矩形填充', 'R'],
  ['erase', '橡皮', 'E'],
  ['object', '物件', 'O'],
  ['zone', '触发区', 'Z'],
  ['conn', '连接点', 'C'],
  ['token', '棋子', 'T'],
  ['d100', 'D100 区域', 'D'],
  ['room', '房间', 'M'],
  ['fogReveal', '迷雾：看得见', 'F'],
  ['fogHide', '迷雾：变灰', 'G'],
  ['fogBlack', '迷雾：抹黑', 'H'],
];
// 编辑地图 = 形状；备团 = 内容（棋子初始位置、初始迷雾）；带团 = 跑
export const MODE_TOOLS: Record<Mode, Tool[]> = {
  edit: ['select', 'paint', 'fill', 'erase', 'object', 'zone', 'conn', 'room', 'd100'],
  prep: ['select', 'token', 'fogReveal', 'fogHide', 'fogBlack'],
  run: ['select', 'token', 'fogReveal', 'fogHide', 'fogBlack'],
};
/** 当前能用的工具：解锁时把"编辑地图"的工具也加进来。 */
export const toolsFor = (s: UIState): Tool[] =>
  s.unlock && s.mode !== 'edit' ? [...new Set([...MODE_TOOLS[s.mode], ...MODE_TOOLS.edit])] : MODE_TOOLS[s.mode];
export const TOOL_KEYS = Object.fromEntries(ALL_TOOLS.map(([t, , k]) => [k.toLowerCase(), t])) as Record<string, Tool>;

export function Sidebar() {
  const w = useWorld();
  const ui = useUI();
  const edit = canEditMap(ui);
  const layers = [...new Set(w.maps.map((m) => m.layer))];
  const tools = ALL_TOOLS.filter(([t]) => toolsFor(ui).includes(t));
  const terrain = w.terrains.find((t) => t.id === ui.terrainId);
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
          {tools.map(([t, label, key]) => (
            <button key={t} className={ui.tool === t ? 'tool on' : 'tool'} title={`快捷键 ${key}`}
              onClick={() => setUI({ tool: t, pendingConn: null })}>{label}</button>
          ))}
        </div>
        {['paint', 'erase', 'd100', 'room', 'fogReveal', 'fogHide', 'fogBlack'].includes(ui.tool) && (
          <Row label="笔刷">
            <span className="inline">
              {[1, 2, 3, 5].map((n) => (
                <button key={n} className={ui.brush === n ? 'chip on' : 'chip'} onClick={() => setUI({ brush: n })}>{n}</button>
              ))}
            </span>
          </Row>
        )}
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
        {ui.mode === 'edit' && <Check label="显示迷雾" value={ui.showFogInEdit} onChange={(v) => setUI({ showFogInEdit: v })} />}
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
              <button className="small" onClick={() => update((d) => { const m = d.maps.find((x) => x.id === cur.id)!; for (const L of [m, ...Object.values(m.views)]) L.fog = L.fog.map((f) => (f === 1 ? 2 : f)); })}>可见的全部变灰</button>
              <button className="small" onClick={() => update((d) => { d.maps.find((m) => m.id === cur.id)!.fog.fill(1); })}>全部看得见</button>
              <button className="small" onClick={() => update((d) => { const m = d.maps.find((x) => x.id === cur.id)!; m.fog.fill(0); m.seen = { cells: m.cells.map(() => ''), objects: [] }; })}>全部抹黑</button>
            </div>
          </>
        )}
      </Section>

      {ui.showNumbers && cur && (
        <Section title="图例">
          {numbering(w, cur).map((n) => (
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
                onClick={() => setUI({ terrainId: t.id, tool: ui.tool === 'fill' ? 'fill' : 'paint' })}>
                <i style={{ background: t.color }} />{t.name}
              </button>
            ))}
          </div>
          {terrain && (
            <div className="card">
              <Row label="名字"><Txt value={terrain.name} onChange={(v) => update((d) => { d.terrains.find((t) => t.id === terrain.id)!.name = v; }, { coalesce: 'tn' + terrain.id })} /></Row>
              <Row label="颜色"><input type="color" value={terrain.color} onChange={(e) => update((d) => { d.terrains.find((t) => t.id === terrain.id)!.color = e.target.value; }, { coalesce: 'tc' + terrain.id })} /></Row>
              <Row label="视野衰减"><Num value={terrain.visionCoef} step={0.1} min={0} onChange={(v) => update((d) => { d.terrains.find((t) => t.id === terrain.id)!.visionCoef = v; })} /></Row>
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
    </aside>
  );
}

const ROOM_COLORS = ['#e8a87c', '#85cdca', '#c38d9e', '#e8d67c', '#9ab87a', '#8fa6d9', '#d98fb5', '#b0a4e3'];

/** 房间：先选一个房间，再用笔刷刷格子。选"擦掉"刷掉格子的房间归属。 */
function RoomSection({ mapId, rooms, roomId, tool }: { mapId: string; rooms: Room[]; roomId: string; tool: Tool }) {
  const room = rooms.find((r) => r.id === roomId);
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
