import { effectiveLayer } from '../scene/vision';
import { objectEnabled } from '../core/objectData.js';
import { architectureWalls, architectureDoors, isArchitectureObject, characterPathClear, furnitureSweepBlocked, isSubdivided, tokenPosition, objectRect, anchorFromPoint } from '../scene/architecture';
import { addArchitectureDoor, addArchitectureWall, eraseArchitecture, moveMapToken, paintFog, paintMaterialCells, paintMaterialSubcells, paintTerrainCells, paintTerrainSubcells, subdivideRegion, toggleArchitectureDoor } from '../runtime/actions';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GameMap, World } from '../core/types';
import { CS, cellLine, uid } from '../core/util';
import { beginBatch, canEditMap, endBatch, getUI, getWorld, setUI, toast, update, useUI, type Selection, type View } from '../core/store';
import { checkEnterTriggers, clearPendingFocus, findMap, itemsAt, jumpTo, moveSlidingObject, pendingFocus, sameSel } from '../runtime/actions';
import { checkSlidingMove, slidingPuzzleForObject } from '../scene/sliding';
import { newObject } from '../core/defaults';
import { brushCells, render, type Mode, type Rect } from '../scene/render';

type Drag =
  | { k: 'wall'; ax: number; ay: number; bx: number; by: number }
  | { k: 'pan'; sx: number; sy: number; px: number; py: number }
  | { k: 'paint'; lx: number; ly: number; fx: number; fy: number; value: number }
  | { k: 'rect'; x0: number; y0: number; x1: number; y1: number; ax: number; ay: number; fine?: boolean; fx0?: number; fy0?: number; fx1?: number; fy1?: number }
  | { k: 'obj'; id: string; ox: number; oy: number; moved: boolean; next: Selection }
  | { k: 'tok'; id: string; fx: number; fy: number; moved: boolean; next: Selection }
  | { k: 'click'; next: Selection };

const PAINT_TOOLS = ['paint', 'erase', 'd100', 'room', 'fogReveal', 'fogHide', 'fogBlack'];

/** 小格画笔落点用：把物件实际占到的格子顺手细分，已经细分过的就跳过。 */
function subdivideFootprint(mapId: string, rect: { x: number; y: number; w: number; h: number }) {
  const m = findMap(getWorld(), mapId);
  if (!m) return;
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(m.width - 1, Math.ceil(rect.x + rect.w - 1e-9) - 1), y1 = Math.min(m.height - 1, Math.ceil(rect.y + rect.h - 1e-9) - 1);
  if (x1 < x0 || y1 < y0) return;
  const subs = new Set(m.subdivisions ?? []);
  let all = true;
  for (let y = y0; y <= y1 && all; y++) for (let x = x0; x <= x1; x++) if (!subs.has(y * m.width + x)) { all = false; break; }
  if (all) return;
  subdivideRegion(mapId, { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, false);
}

/** Zones are background: only their visible border is an explicit selection/drag target. */
export function zoneBorderHit(r: { x: number; y: number; w: number; h: number }, gx: number, gy: number, zoom: number) {
  const margin = 6 / (CS * zoom);
  return gx >= r.x - margin && gx <= r.x + r.w + margin && gy >= r.y - margin && gy <= r.y + r.h + margin &&
    Math.min(Math.abs(gx - r.x), Math.abs(gx - r.x - r.w), Math.abs(gy - r.y), Math.abs(gy - r.y - r.h)) <= margin;
}

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

  // 试玩时镜头不再跟着走：开始试玩或切换操控角色时对准一次，之后由「回到棋子」按钮决定。
  // 每走一步就回正会让人看不清刚走过的路线，也没法自己看周边。
  const followToken = follow ? map.tokens.find((t) => t.id === follow) : undefined;
  const centeredFor = useRef<string | null>(null);
  const centerOnToken = (t: { x: number; y: number; subcell?: { x: number; y: number } }) => {
    if (!size.w) return;
    const z = viewRef.current.zoom;
    setView({ zoom: z, panX: size.w / 2 - tokenPosition(t).x * CS * z, panY: size.h / 2 - tokenPosition(t).y * CS * z });
  };
  useEffect(() => {
    if (!follow) { centeredFor.current = null; return; }
    if (!followToken || !size.w || centeredFor.current === follow) return;
    centeredFor.current = follow;
    centerOnToken(followToken);
  }, [follow, size.w, map.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
      subgrid: ui.showSubgrid,
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
    return { sx, sy, gx: (sx - v.panX) / v.zoom / CS, gy: (sy - v.panY) / v.zoom / CS, cx: Math.floor((sx - v.panX) / v.zoom / CS), cy: Math.floor((sy - v.panY) / v.zoom / CS) };
  };

  /** 只剩按大格生效的工具：迷雾 / D100 / 房间。地形画笔在 paintTerrain 里。 */
  const paintCells = (cells: [number, number][], value: number) => {
    const { tool, roomId, knowledgeTarget } = getUI();
    if (tool.startsWith('fog')) return paintFog(map.id, cells, tool as 'fogReveal' | 'fogHide' | 'fogBlack', knowledgeTarget ? [knowledgeTarget] : undefined);
    update((d) => {
      const m = findMap(d, map.id)!;
      for (const [x, y] of cells) {
        if (x < 0 || y < 0 || x >= m.width || y >= m.height) continue;
        const i = y * m.width + x;
        if (tool === 'd100') m.d100[i] = value;
        else if (tool === 'room') m.roomCells[i] = roomId;
      }
    });
  };

  /** 小格画笔落点：n 按小格算。 */
  const brushSubcells = (x3: number, y3: number, n: number): [number, number][] => {
    const out: [number, number][] = [];
    const start = -Math.floor((Math.max(1, n) - 1) / 2);
    for (let dy = 0; dy < Math.max(1, n); dy++) for (let dx = 0; dx < Math.max(1, n); dx++) out.push([x3 + start + dx, y3 + start + dy]);
    return out;
  };

  /** 画笔统一入口：按当前画笔层写地形或材质；d100/房间/迷雾仍按大格。 */
  const paintTerrain = (cx: number, cy: number, fx: number, fy: number, value: number, tool: string, brush: number, fine: boolean, terrainId: string, materialId: string, layer: 'terrain' | 'material') => {
    const painting = tool === 'paint' || tool === 'erase';
    const erase = tool === 'erase';
    if (fine && painting) {
      if (layer === 'material') paintMaterialSubcells(map.id, brushSubcells(fx, fy, brush), erase ? null : materialId);
      else paintTerrainSubcells(map.id, brushSubcells(fx, fy, brush), erase ? '' : terrainId);
      return;
    }
    if (painting) {
      if (layer === 'material') paintMaterialCells(map.id, brushCells(cx, cy, brush), erase ? null : materialId);
      else paintTerrainCells(map.id, brushCells(cx, cy, brush), erase ? '' : terrainId);
      return;
    }
    paintCells(brushCells(cx, cy, brush), value);
  };

  const onDown = (e: React.PointerEvent) => {
    try { canvas.current!.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真实指针 */ }
    const { sx, sy, cx, cy } = toCell(e);
    const v = viewRef.current;
    const startPan = () => { drag.current = { k: 'pan', sx, sy, px: v.panX, py: v.panY }; };
    if (e.button !== 0 || space.current) return startPan();

    const s = getUI();
    if (s.trial?.markMode && onCellClick) { onCellClick(cx, cy); return; }
    // 平移工具先于任何命中/选择/编辑逻辑；从家具、触发区边框或棋子起拖都一样。
    if (mode !== 'player' && s.tool === 'pan') return startPan();
    const w = mode === 'player' && !s.trial ? world : getWorld();
    const m = findMap(w, map.id) ?? map;
    // 试玩允许直接拖棋盘块；独立玩家窗口仍只平移，标记模式仍交给点击处理。
    if (mode === 'player') {
      const trial = s.trial;
      const obj = trial?.mapId === m.id && !trial.markMode
        ? m.objects.find(o => objectEnabled(m, o) && !o.hidden && slidingPuzzleForObject(m, o.id) &&
          (viewer ? effectiveLayer(w, m, viewer).fog : m.fog)?.[cy * m.width + cx] === 1 &&
          cx >= o.x && cx < o.x + o.w && cy >= o.y && cy < o.y + o.h)
        : undefined;
      if (!obj) return startPan();
      beginBatch();
      drag.current = { k: 'obj', id: obj.id, ox: cx - obj.x, oy: cy - obj.y, moved: false, next: null };
      setUI({ selection: { type: 'object', mapId: m.id, id: obj.id }, tab: 'inspect' });
      return;
    }
    const inMap = cx >= 0 && cy >= 0 && cx < m.width && cy < m.height;
    const tool = s.tool;

    if (tool === 'wall' || tool === 'glass') {
      const { gx, gy } = toCell(e), ax = Math.round(gx * 3), ay = Math.round(gy * 3);
      drag.current = { k: 'wall', ax, ay, bx: ax, by: ay }; return;
    }
    if (tool === 'archDoor' || tool === 'archErase') {
      const { gx, gy } = toCell(e);
      const wall = architectureWalls(m).find(w => objectEnabled(m, m.objects.find(o => o.id === w.id)) && Math.min(w.a.x, w.b.x) / 3 - .12 <= gx && gx <= Math.max(w.a.x, w.b.x) / 3 + .12 && Math.min(w.a.y, w.b.y) / 3 - .12 <= gy && gy <= Math.max(w.a.y, w.b.y) / 3 + .12);
      if (!wall) return;
      const along = Math.round(wall.a.x === wall.b.x ? (gy * 3 - wall.a.y) * Math.sign(wall.b.y - wall.a.y) : (gx * 3 - wall.a.x) * Math.sign(wall.b.x - wall.a.x));
      const door = architectureDoors(m).find(d => objectEnabled(m, m.objects.find(o => o.id === d.id)) && d.wallId === wall.id && along >= d.offset && along <= d.offset + d.width);
      if (tool === 'archErase') eraseArchitecture(m.id, door?.id ?? wall.id, !!door);
      else { const error = door ? toggleArchitectureDoor(m.id, door.id) : addArchitectureDoor(m.id, wall.id, Math.max(0, along - Math.floor(s.doorWidth / 2)), s.doorWidth); if (error) toast(error); }
      return;
    }
    if (tool === 'select') {
      const { gx, gy } = toCell(e);
      const hits = inMap ? itemsAt(w, m, cx, cy) : [];
      const foreground = hits.filter(it => it.kind !== '触发区');
      // Furniture keeps priority even where a zone border crosses it. An already
      // selected zone still pans from its interior; drag only starts on its border.
      const items = foreground.length ? foreground : hits.filter(it => {
        const sel = it.sel;
        const zone = sel.type === 'object' && m.objects.find(o => o.id === sel.id);
        return zone && zoneBorderHit(zone, gx, gy, v.zoom);
      });
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
      } else if (ts.type === 'object' && (!isArchitectureObject(m.objects.find(o => o.id === ts.id)!) && (canEditMap(s) || slidingPuzzleForObject(m, ts.id)))) {
        const obj = m.objects.find((o) => o.id === ts.id)!;
        beginBatch();
        const q = objectRect(obj), pp = toCell(e);
        drag.current = { k: 'obj', id: obj.id, ox: pp.gx - q.x, oy: pp.gy - q.y, moved: false, next };
      } else drag.current = { k: 'click', next };
      return;
    }

    if (!inMap) return;
    if (PAINT_TOOLS.includes(tool)) {
      beginBatch();
      const value = tool === 'd100' ? (m.d100[cy * m.width + cx] ? 0 : 1) : 0;
      const { gx, gy } = toCell(e);
      const fx = Math.floor(gx * 3), fy = Math.floor(gy * 3);
      drag.current = { k: 'paint', lx: cx, ly: cy, fx, fy, value };
      paintTerrain(cx, cy, fx, fy, value, tool, s.brush, s.fine, s.terrainId, s.materialId, s.paintLayer);
      return;
    }
    if (tool === 'fill' || tool === 'object' || tool === 'zone' || tool === 'subdivide' || tool === 'unsubdivide') {
      const { gx, gy } = toCell(e);
      const a = anchorFromPoint({ x: gx, y: gy });
      const fineFill = s.fine && tool === 'fill';
      const fx0 = fineFill ? Math.floor(gx * 3) : 0, fy0 = fineFill ? Math.floor(gy * 3) : 0;
      drag.current = { k: 'rect', x0: cx, y0: cy, x1: cx, y1: cy, ax: a.x, ay: a.y, fine: fineFill, fx0, fy0, fx1: fx0, fy1: fy0 };
      setPreview(fineFill ? { x: fx0 / 3, y: fy0 / 3, w: 1 / 3, h: 1 / 3 } : { x: cx, y: cy, w: 1, h: 1 });
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
        const { gx, gy } = toCell(e), p = isSubdivided(m, gx, gy) ? { x: (Math.floor(gx * 3) + .5) / 3, y: (Math.floor(gy * 3) + .5) / 3 } : { x: cx + .5, y: cy + .5 };
        const error = moveMapToken(m.id, existing.id, p); if (error) return toast(error);
        checkEnterTriggers(m.id, existing.id, fx + .5, fy + .5);
        setUI({ selection: { type: 'token', mapId: m.id, id: existing.id } });
      } else {
        const { gx, gy } = toCell(e), p = isSubdivided(m, gx, gy) ? { x: (Math.floor(gx * 3) + .5) / 3, y: (Math.floor(gy * 3) + .5) / 3 } : { x: cx + .5, y: cy + .5 };
        if (!characterPathClear(w, m, p, p)) return toast('此处放不下人物');
        const id = uid();
        update((d) => {
          findMap(d, m.id)!.tokens.push({ id, pcId: pc?.id ?? null, name: pc?.name ?? '敌人', color: pc?.color ?? '#c0392b', x: cx, y: cy, ...(isSubdivided(m, p.x, p.y) ? { subcell: { x: Math.floor(p.x * 3), y: Math.floor(p.y * 3) } } : {}) });
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
    if (dr.k === 'wall') {
      const { gx, gy } = toCell(e); let bx = Math.round(gx * 3), by = Math.round(gy * 3);
      if (Math.abs(bx - dr.ax) >= Math.abs(by - dr.ay)) by = dr.ay; else bx = dr.ax;
      dr.bx = bx; dr.by = by;
      setPreview({ x: Math.min(dr.ax, bx) / 3, y: Math.min(dr.ay, by) / 3, w: Math.max(.05, Math.abs(bx - dr.ax) / 3), h: Math.max(.05, Math.abs(by - dr.ay) / 3) });
    } else if (dr.k === 'paint') {
      const { gx, gy } = toCell(e);
      const fx = Math.floor(gx * 3), fy = Math.floor(gy * 3);
      const s = getUI();
      if (s.fine && (s.tool === 'paint' || s.tool === 'erase')) {
        if (fx === dr.fx && fy === dr.fy) return;
        if (s.paintLayer === 'material') paintMaterialSubcells(map.id, cellLine(dr.fx, dr.fy, fx, fy).flatMap(([x, y]) => brushSubcells(x, y, s.brush)), s.tool === 'erase' ? null : s.materialId);
        else paintTerrainSubcells(map.id, cellLine(dr.fx, dr.fy, fx, fy).flatMap(([x, y]) => brushSubcells(x, y, s.brush)), s.tool === 'erase' ? '' : s.terrainId);
        dr.fx = fx; dr.fy = fy;
        return;
      }
      if (cx === dr.lx && cy === dr.ly) return;
      paintTerrain(cx, cy, fx, fy, dr.value, s.tool, s.brush, false, s.terrainId, s.materialId, s.paintLayer);
      dr.lx = cx; dr.ly = cy;
    } else if (dr.k === 'rect') {
      if (dr.fine && dr.fx0 !== undefined && dr.fy0 !== undefined) {
        const { gx, gy } = toCell(e);
        const fx = Math.max(0, Math.min(m.width * 3 - 1, Math.floor(gx * 3)));
        const fy = Math.max(0, Math.min(m.height * 3 - 1, Math.floor(gy * 3)));
        dr.fx1 = fx; dr.fy1 = fy;
        setPreview({ x: Math.min(dr.fx0, fx) / 3, y: Math.min(dr.fy0, fy) / 3, w: (Math.abs(fx - dr.fx0) + 1) / 3, h: (Math.abs(fy - dr.fy0) + 1) / 3 });
        return;
      }
      dr.x1 = clampX(cx); dr.y1 = clampY(cy);
      setPreview({ x: Math.min(dr.x0, dr.x1), y: Math.min(dr.y0, dr.y1), w: Math.abs(dr.x1 - dr.x0) + 1, h: Math.abs(dr.y1 - dr.y0) + 1 });
    } else if (dr.k === 'obj') {
      const o = m.objects.find((x) => x.id === dr.id);
      if (!o || !objectEnabled(m, o)) return gone();
      if (slidingPuzzleForObject(m, o.id)) {
        const nx = cx - dr.ox, ny = cy - dr.oy;
        if (nx !== o.x || ny !== o.y) {
          const error = checkSlidingMove(getWorld(), m, o.id, nx, ny);
          setPreview(error ? null : { x: nx, y: ny, w: o.w, h: o.h });
          dr.moved = true;
        }
      } else {
        const { gx, gy } = toCell(e);
        const fineNow = getUI().fine;
        const target = { x: gx - dr.ox, y: gy - dr.oy };
        const nx = clampX(Math.floor(target.x), o.w), ny = clampY(Math.floor(target.y), o.h);
        const prevAx = o.anchor?.x ?? 0, prevAy = o.anchor?.y ?? 0;
        const ax = fineNow && nx + o.w < map.width ? Math.max(0, Math.min(2, Math.round((target.x - nx) * 3))) : 0;
        const ay = fineNow && ny + o.h < map.height ? Math.max(0, Math.min(2, Math.round((target.y - ny) * 3))) : 0;
        if (nx !== o.x || ny !== o.y || ax !== prevAx || ay !== prevAy) dr.moved = true;
        if ((nx !== o.x || ny !== o.y || ax !== prevAx || ay !== prevAy) && (o.kind === 'zone' || !furnitureSweepBlocked(m, o, nx, ny))) {
          if (fineNow) subdivideFootprint(map.id, { x: nx + ax / 3, y: ny + ay / 3, w: o.w, h: o.h });
          update((d) => { const od = findMap(d, map.id)!.objects.find((x) => x.id === dr.id)!; od.x = nx; od.y = ny; if (ax || ay) od.anchor = { x: ax, y: ay }; else delete od.anchor; });
        }
      }
    } else if (dr.k === 'tok') {
      const t = m.tokens.find((x) => x.id === dr.id);
      if (!t) return gone();
      const { gx, gy } = toCell(e), fine = isSubdivided(m, gx, gy);
      const p = fine ? { x: (Math.floor(gx * 3) + .5) / 3, y: (Math.floor(gy * 3) + .5) / 3 } : { x: clampX(cx) + .5, y: clampY(cy) + .5 };
      if (characterPathClear(getWorld(), m, tokenPosition(t), p, t.id)) { moveMapToken(map.id, t.id, p); dr.moved = true; }
    }
  };

  // 拖到一半切走了（换模式、换地图、关面板）：丢掉这次拖动并收尾，免得之后的修改都不进撤销
  // 换工具也终止旧拖动，保证切到平移后不会继续移动刚才抓住的对象。
  useEffect(() => { drag.current = null; endBatch(); setPreview(null); }, [mode, map.id, ui.tool]);
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
    if (dr.k === 'obj' && dr.moved) {
      const m = findMap(getWorld(), map.id);
      const o = m?.objects.find(o => o.id === dr.id);
      if (m && o && objectEnabled(m, o) && slidingPuzzleForObject(m, dr.id)) {
        const { cx, cy } = toCell(e);
        const error = moveSlidingObject(map.id, dr.id, cx - dr.ox, cy - dr.oy);
        if (error) toast(error);
      }
      setPreview(null);
    }
    if (dr.k === 'wall') { const error = addArchitectureWall(map.id, { x: dr.ax, y: dr.ay }, { x: dr.bx, y: dr.by }, getUI().tool === 'glass' ? 'glass' : 'wall', getUI().wallThickness); if (error) toast(error); setPreview(null); }
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
      const { tool, terrainId, materialId, paintLayer } = getUI();
      if (tool === 'subdivide' || tool === 'unsubdivide') {
        const error = subdivideRegion(map.id, r, tool === 'unsubdivide');
        if (error) toast(error);
        else if (tool === 'subdivide') setUI({ fine: true, showSubgrid: true }); // 细分完直接给小格画笔
      } else if (tool === 'fill') {
        if (dr.fine && dr.fx0 !== undefined && dr.fx1 !== undefined && dr.fy0 !== undefined && dr.fy1 !== undefined) {
          const cells3: [number, number][] = [];
          for (let y = Math.min(dr.fy0, dr.fy1); y <= Math.max(dr.fy0, dr.fy1); y++)
            for (let x = Math.min(dr.fx0, dr.fx1); x <= Math.max(dr.fx0, dr.fx1); x++) cells3.push([x, y]);
          if (paintLayer === 'material') paintMaterialSubcells(map.id, cells3, materialId);
          else paintTerrainSubcells(map.id, cells3, terrainId);
        } else if (paintLayer === 'material') {
          const cells: [number, number][] = [];
          for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) cells.push([x, y]);
          paintMaterialCells(map.id, cells, materialId);
        } else {
          update((d) => {
            const m = findMap(d, map.id)!;
            for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) m.cells[y * m.width + x] = terrainId;
          });
        }
      } else {
        const o = newObject(tool === 'zone' ? 'zone' : 'object', r.x, r.y, r.w, r.h);
        const fineNow = getUI().fine;
        // 小格画笔：位置吸附到 1/3 格；贴到地图边时只能取 0，免得物件被推出地图
        const ax = fineNow && r.x + r.w < map.width ? dr.ax : 0;
        const ay = fineNow && r.y + r.h < map.height ? dr.ay : 0;
        if (ax || ay) o.anchor = { x: ax, y: ay };
        if (fineNow) subdivideFootprint(map.id, { x: r.x + ax / 3, y: r.y + ay / 3, w: r.w, h: r.h });
        update((d) => { findMap(d, map.id)!.objects.push(o); });
        setUI({ selection: { type: 'object', mapId: map.id, id: o.id }, tab: 'inspect', tool: 'select' });
      }
      setPreview(null);
    }
  };

  const cursor = cursorProp ?? (mode === 'player' ? (onCellClick ? 'pointer' : 'grab') : ui.tool === 'pan' ? 'grab' : ui.tool === 'select' ? 'default' : 'crosshair');
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
      {followToken && (
        <button className="recenter-btn" title="把镜头移回当前操控的角色（移动时镜头不会自动回正）" onClick={() => centerOnToken(followToken)}>
          ⌖ 回到棋子
        </button>
      )}
    </div>
  );
}
