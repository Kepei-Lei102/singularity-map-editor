import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GameMap, World } from '../types';
import { CS, cellLine, uid } from '../util';
import { beginBatch, canEditMap, endBatch, getUI, getWorld, setUI, toast, update, useUI, type Selection, type View } from '../store';
import { checkEnterTriggers, clearPendingFocus, findMap, itemsAt, jumpTo, pendingFocus, sameSel } from '../actions';
import { newObject } from '../defaults';
import { brushCells, render, type Mode, type Rect } from '../render';

type Drag =
  | { k: 'pan'; sx: number; sy: number; px: number; py: number }
  | { k: 'paint'; lx: number; ly: number; value: number }
  | { k: 'rect'; x0: number; y0: number; x1: number; y1: number }
  | { k: 'obj'; id: string; ox: number; oy: number; moved: boolean; next: Selection }
  | { k: 'tok'; id: string; fx: number; fy: number; moved: boolean; next: Selection }
  | { k: 'click'; next: Selection };

const PAINT_TOOLS = ['paint', 'erase', 'd100', 'room', 'fogReveal', 'fogHide', 'fogBlack'];

function fitView(map: GameMap, w: number, h: number): View {
  const zoom = Math.min(w / (map.width * CS), h / (map.height * CS)) * 0.9;
  return { zoom, panX: (w - map.width * CS * zoom) / 2, panY: (h - map.height * CS * zoom) / 2 };
}

export function MapCanvas({ world, map, mode, playerNumbers = false, follow, viewer, onCellClick, cursor: cursorProp }: {
  world: World; map: GameMap; mode: Mode; playerNumbers?: boolean;
  follow?: string; // 镜头跟着这个棋子
  viewer?: string; // 玩家视角以谁的眼睛看
  onCellClick?: (x: number, y: number) => void; // 玩家视角下点格子（试玩时：放标记 / 点人切换）
  cursor?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const ui = useUI();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [preview, setPreview] = useState<Rect | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  const space = useRef(false);

  const view = ui.views[map.id] ?? (size.w ? fitView(map, size.w, size.h) : { zoom: 1, panX: 0, panY: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const setView = (v: View) => setUI((s) => ({ views: { ...s.views, [map.id]: v } }));

  useLayoutEffect(() => {
    const el = wrap.current!;
    setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 初始视图 / 跳转对准
  useEffect(() => {
    if (!size.w) return;
    if (pendingFocus && pendingFocus.mapId === map.id) {
      const z = viewRef.current.zoom;
      setView({ zoom: z, panX: size.w / 2 - (pendingFocus.x + 0.5) * CS * z, panY: size.h / 2 - (pendingFocus.y + 0.5) * CS * z });
      clearPendingFocus();
    } else if (!getUI().views[map.id]) setView(fitView(map, size.w, size.h));
  }, [map.id, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps

  // 试玩时镜头跟着棋子：走出画面中间那块区域就重新对准
  const ft = follow ? map.tokens.find((t) => t.id === follow) : undefined;
  useEffect(() => {
    if (!ft || !size.w) return;
    const v = viewRef.current;
    const z = Math.max(v.zoom, 1.2);
    const sx = v.panX + (ft.x + 0.5) * CS * v.zoom, sy = v.panY + (ft.y + 0.5) * CS * v.zoom;
    if (z !== v.zoom || sx < size.w * 0.25 || sx > size.w * 0.75 || sy < size.h * 0.25 || sy > size.h * 0.75)
      setView({ zoom: z, panX: size.w / 2 - (ft.x + 0.5) * CS * z, panY: size.h / 2 - (ft.y + 0.5) * CS * z });
  }, [ft?.x, ft?.y, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps

  // 有标记时，每 10 秒重画一次（标记按真实时间变淡）
  const [, setTick] = useState(0);
  const hasMarks = world.marks.some((k) => k.mapId === map.id);
  useEffect(() => {
    if (!hasMarks) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 10000);
    return () => window.clearInterval(id);
  }, [hasMarks]);

  // 绘制
  useEffect(() => {
    const c = canvas.current;
    if (!c || !size.w) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== size.w * dpr || c.height !== size.h * dpr) {
      c.width = size.w * dpr;
      c.height = size.h * dpr;
    }
    render(c.getContext('2d')!, size.w, size.h, dpr, world, map, view, {
      mode, selection: mode === 'player' ? null : ui.selection, preview, hover, brush: ui.brush,
      tool: ui.tool, pending: ui.pendingConn, showFog: ui.showFogInEdit, viewer,
      numbers: mode === 'player' ? playerNumbers : ui.showNumbers, rulers: mode === 'player' ? true : ui.showRulers,
    });
  });

  // 滚轮缩放（需要非 passive 监听）
  useEffect(() => {
    const c = canvas.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const v = viewRef.current;
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      const zoom = Math.max(0.15, Math.min(6, v.zoom * f));
      setView({ zoom, panX: sx - ((sx - v.panX) * zoom) / v.zoom, panY: sy - ((sy - v.panY) * zoom) / v.zoom });
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    const kd = (e: KeyboardEvent) => { if (e.code === 'Space' && !(e.target as HTMLElement).closest('input,textarea,select')) space.current = true; };
    const ku = (e: KeyboardEvent) => { if (e.code === 'Space') space.current = false; };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => {
      c.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    };
  }, [map.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const toCell = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const v = viewRef.current;
    return { sx, sy, cx: Math.floor((sx - v.panX) / v.zoom / CS), cy: Math.floor((sy - v.panY) / v.zoom / CS) };
  };

  const paintCells = (cells: [number, number][], value: number) => {
    const { tool, terrainId, roomId } = getUI();
    update((d) => {
      const m = findMap(d, map.id)!;
      for (const [x, y] of cells) {
        if (x < 0 || y < 0 || x >= m.width || y >= m.height) continue;
        const i = y * m.width + x;
        if (tool === 'paint') m.cells[i] = terrainId;
        else if (tool === 'erase') m.cells[i] = '';
        else if (tool === 'd100') m.d100[i] = value;
        else if (tool === 'room') m.roomCells[i] = roomId;
        else if (tool.startsWith('fog')) {
          // 各自独立时，主持人改迷雾是改所有人的（全队那份 + 每个人自己那份）
          for (const L of [m, ...Object.values(m.views)]) {
            if (tool === 'fogReveal') L.fog[i] = 1;
            else if (tool === 'fogHide') { if (L.fog[i] === 1) L.fog[i] = 2; }
            else { L.fog[i] = 0; L.seen.cells[i] = ''; }
          }
        }
      }
    });
  };

  const onDown = (e: React.PointerEvent) => {
    try { canvas.current!.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真实指针 */ }
    const { sx, sy, cx, cy } = toCell(e);
    const v = viewRef.current;
    const startPan = () => { drag.current = { k: 'pan', sx, sy, px: v.panX, py: v.panY }; };
    if (e.button !== 0 || space.current || mode === 'player') return startPan();

    const s = getUI();
    const w = getWorld();
    const m = findMap(w, map.id)!;
    const inMap = cx >= 0 && cy >= 0 && cx < m.width && cy < m.height;
    const tool = s.tool;

    if (tool === 'select') {
      const items = inMap ? itemsAt(w, m, cx, cy) : [];
      if (e.detail >= 2) {
        const c = items.find((it) => it.sel.type === 'conn');
        const conn = c && w.connections.find((x) => c.sel.type === 'conn' && x.id === c.sel.id);
        if (conn) {
          const here = conn.a.mapId === m.id && conn.a.x === cx && conn.a.y === cy;
          const other = here ? conn.b : conn.a;
          return jumpTo(other.mapId, other.x, other.y);
        }
      }
      setUI({ pick: inMap ? { mapId: m.id, x: cx, y: cy } : null });
      if (!items.length) {
        setUI({ selection: inMap ? { type: 'cell', mapId: m.id, x: cx, y: cy } : null });
        return startPan();
      }
      // 同一格再点一下（不拖动）就切到下一样东西
      const samePick = s.pick && s.pick.mapId === m.id && s.pick.x === cx && s.pick.y === cy;
      const cur = samePick ? items.findIndex((it) => sameSel(it.sel, s.selection)) : -1;
      const target = items[Math.max(cur, 0)];
      const next = cur >= 0 && items.length > 1 ? items[(cur + 1) % items.length].sel : null;
      setUI({ selection: target.sel, tab: 'inspect' });
      const ts = target.sel;
      if (ts.type === 'token') {
        const tok = m.tokens.find((t) => t.id === ts.id)!;
        beginBatch();
        drag.current = { k: 'tok', id: tok.id, fx: tok.x, fy: tok.y, moved: false, next };
      } else if (ts.type === 'object' && canEditMap(s)) {
        const obj = m.objects.find((o) => o.id === ts.id)!;
        beginBatch();
        drag.current = { k: 'obj', id: obj.id, ox: cx - obj.x, oy: cy - obj.y, moved: false, next };
      } else drag.current = { k: 'click', next };
      return;
    }

    if (!inMap) return;
    if (PAINT_TOOLS.includes(tool)) {
      beginBatch();
      const value = tool === 'd100' ? (m.d100[cy * m.width + cx] ? 0 : 1) : 0;
      drag.current = { k: 'paint', lx: cx, ly: cy, value };
      paintCells(brushCells(cx, cy, s.brush), value);
      return;
    }
    if (tool === 'fill' || tool === 'object' || tool === 'zone') {
      drag.current = { k: 'rect', x0: cx, y0: cy, x1: cx, y1: cy };
      setPreview({ x: cx, y: cy, w: 1, h: 1 });
      return;
    }
    if (tool === 'conn') {
      if (!s.pendingConn) {
        setUI({ pendingConn: { mapId: m.id, x: cx, y: cy } });
        toast('起点已选。在这张图或切到别的图点终点（Esc 取消）');
      } else {
        const id = uid();
        const a = s.pendingConn;
        update((d) => { d.connections.push({ id, kind: s.connKind, label: '', a, b: { mapId: m.id, x: cx, y: cy }, hidden: s.connKind === 'portal' }); });
        setUI({ pendingConn: null, selection: { type: 'conn', id }, tab: 'inspect' });
      }
      return;
    }
    if (tool === 'token') {
      const pc = w.party.find((p) => p.id === s.tokenPcId);
      const existing = pc && m.tokens.find((t) => t.pcId === pc.id);
      if (existing) {
        const fx = existing.x, fy = existing.y;
        update((d) => { const t = findMap(d, m.id)!.tokens.find((x) => x.id === existing.id)!; t.x = cx; t.y = cy; });
        checkEnterTriggers(m.id, existing.id, fx, fy);
        setUI({ selection: { type: 'token', mapId: m.id, id: existing.id } });
      } else {
        const id = uid();
        update((d) => {
          findMap(d, m.id)!.tokens.push({ id, pcId: pc?.id ?? null, name: pc?.name ?? '敌人', color: pc?.color ?? '#c0392b', x: cx, y: cy });
        });
        setUI({ selection: { type: 'token', mapId: m.id, id }, tab: 'inspect' });
      }
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const { sx, sy, cx, cy } = toCell(e);
    if (!hover || hover.x !== cx || hover.y !== cy) setHover({ x: cx, y: cy });
    const dr = drag.current;
    if (!dr) return;
    if (dr.k === 'pan') { setView({ ...viewRef.current, panX: dr.px + sx - dr.sx, panY: dr.py + sy - dr.sy }); return; } // 平移只看画面，不碰世界（玩家窗口没有编辑器的世界）
    const m = findMap(getWorld(), map.id);
    const gone = () => { drag.current = null; endBatch(); setPreview(null); }; // 拖着的东西没了（被撤销掉了、地图删了）：取消这次拖动
    if (!m) return gone();
    const clampX = (x: number, w = 1) => Math.max(0, Math.min(m.width - w, x));
    const clampY = (y: number, h = 1) => Math.max(0, Math.min(m.height - h, y));
    if (dr.k === 'paint') {
      if (cx === dr.lx && cy === dr.ly) return;
      const n = getUI().brush;
      paintCells(cellLine(dr.lx, dr.ly, cx, cy).flatMap(([x, y]) => brushCells(x, y, n)), dr.value);
      dr.lx = cx; dr.ly = cy;
    } else if (dr.k === 'rect') {
      dr.x1 = clampX(cx); dr.y1 = clampY(cy);
      setPreview({ x: Math.min(dr.x0, dr.x1), y: Math.min(dr.y0, dr.y1), w: Math.abs(dr.x1 - dr.x0) + 1, h: Math.abs(dr.y1 - dr.y0) + 1 });
    } else if (dr.k === 'obj') {
      const o = m.objects.find((x) => x.id === dr.id);
      if (!o) return gone();
      const nx = clampX(cx - dr.ox, o.w), ny = clampY(cy - dr.oy, o.h);
      if (nx !== o.x || ny !== o.y) dr.moved = true;
      if (nx !== o.x || ny !== o.y) update((d) => { const od = findMap(d, map.id)!.objects.find((x) => x.id === dr.id)!; od.x = nx; od.y = ny; });
    } else if (dr.k === 'tok') {
      const t = m.tokens.find((x) => x.id === dr.id);
      if (!t) return gone();
      const nx = clampX(cx), ny = clampY(cy);
      if (nx !== t.x || ny !== t.y) dr.moved = true;
      if (nx !== t.x || ny !== t.y) update((d) => { const td = findMap(d, map.id)!.tokens.find((x) => x.id === dr.id)!; td.x = nx; td.y = ny; });
    }
  };

  // 拖到一半切走了（换模式、换地图、关面板）：丢掉这次拖动并收尾，免得之后的修改都不进撤销
  useEffect(() => { drag.current = null; endBatch(); }, [mode, map.id]);
  useEffect(() => () => endBatch(), []);

  const onUp = (e: React.PointerEvent) => {
    const dr = drag.current;
    drag.current = null;
    if (!dr) return;
    // 玩家视角下，没拖动的点击 = 点了一格
    if (dr.k === 'pan' && mode === 'player' && onCellClick) {
      const { sx, sy, cx, cy } = toCell(e);
      if (Math.hypot(sx - dr.sx, sy - dr.sy) < 4) onCellClick(cx, cy);
    }
    if (dr.k === 'paint' || dr.k === 'obj') endBatch();
    if (dr.k === 'tok') {
      endBatch();
      if (dr.moved) checkEnterTriggers(map.id, dr.id, dr.fx, dr.fy);
    }
    if ((dr.k === 'obj' || dr.k === 'tok' || dr.k === 'click') && !(dr.k !== 'click' && dr.moved) && dr.next) {
      setUI({ selection: dr.next });
    }
    if (dr.k === 'rect' && preview) {
      const r = preview;
      const { tool, terrainId } = getUI();
      if (tool === 'fill') {
        update((d) => {
          const m = findMap(d, map.id)!;
          for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) m.cells[y * m.width + x] = terrainId;
        });
      } else {
        const o = newObject(tool === 'zone' ? 'zone' : 'object', r.x, r.y, r.w, r.h);
        update((d) => { findMap(d, map.id)!.objects.push(o); });
        setUI({ selection: { type: 'object', mapId: map.id, id: o.id }, tab: 'inspect', tool: 'select' });
      }
      setPreview(null);
    }
  };

  const cursor = cursorProp ?? (mode === 'player' ? (onCellClick ? 'pointer' : 'grab') : ui.tool === 'select' ? 'default' : 'crosshair');
  return (
    <div ref={wrap} className="canvas-wrap">
      <canvas
        ref={canvas}
        style={{ width: size.w, height: size.h, cursor }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => { drag.current = null; endBatch(); setPreview(null); }}
        onLostPointerCapture={() => { if (drag.current) { drag.current = null; endBatch(); setPreview(null); } }}
        onPointerLeave={() => setHover(null)}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}
