import { effectiveLayer, visionMembers } from './vision';
import { isArchitectureObject, architectureGeometry, clipArchitecture, fogAt, isSubdivided, tokenPosition } from './architecture';
import { anyVisible } from './memory';
import type { Selection, Tool, View } from './store';
import type { GameMap, MapObject, SeenObject, World } from './types';
import { staleMemories } from './memory';
import { CONN_ICON, CONN_LABEL } from './types';
import { CS, colName, distToRect, gridDist } from './util';
import { CLEAR_BANDS, seesPoint, sightCosts, visibleMarks } from './perception';

export type Mode = 'edit' | 'prep' | 'run' | 'player';
export interface Rect { x: number; y: number; w: number; h: number }

export interface RenderOpts {
  mode: Mode;
  selection: Selection;
  preview: Rect | null;
  hover: { x: number; y: number } | null;
  brush: number;
  tool: Tool;
  pending: { mapId: string; x: number; y: number } | null;
  showFog: boolean;
  viewer?: string | null; // 玩家视角时以谁的眼睛看（视野各自独立时用他自己那份迷雾，标记也按他算）
  numbers?: boolean; // 显示编号 O1 / Z2 / T1 / C1（和给 AI 的图一致）
  rulers?: boolean; // 画面边缘的坐标尺
  subgrid?: boolean; // 仅显示已手动细分区的辅助线，不改变几何或走位
}

export interface Numbered { label: string; kind: 'object' | 'zone' | 'token' | 'conn'; id: string; x: number; y: number; w: number; h: number; name: string }

/** 编号规则（主编辑器、玩家窗口、给 AI 的图都用这一套）：物件和触发区按顺序 O/Z，棋子 T，连接点 C。
 * 发给玩家的世界删过东西，编号以它带来的 labels 为准（删之前算好的），保证和主持人那边一致。 */
export function numbering(world: World, map: GameMap, player = false): Numbered[] {
  const out: Numbered[] = [];
  const L = (id: string, fallback: string) => world.labels?.[id] ?? fallback;
  map.objects.forEach((o, i) => {
    if (player && (o.kind === 'zone' || o.hidden)) return;
    out.push({ label: L(o.id, `${o.kind === 'zone' ? 'Z' : 'O'}${i + 1}`), kind: o.kind, id: o.id, x: o.x, y: o.y, w: o.w, h: o.h, name: o.name });
  });
  map.tokens.forEach((t, i) => out.push({ label: L(t.id, `T${i + 1}`), kind: 'token', id: t.id, x: tokenPosition(t).x - .5, y: tokenPosition(t).y - .5, w: 1, h: 1, name: t.name }));
  world.connections.filter((c) => c.a.mapId === map.id || c.b.mapId === map.id).forEach((c, i) => {
    if (player && c.hidden) return;
    const p = c.a.mapId === map.id ? c.a : c.b;
    out.push({ label: L(c.id, `C${i + 1}`), kind: 'conn', id: c.id, x: p.x, y: p.y, w: 1, h: 1, name: c.label || CONN_LABEL[c.kind] });
  });
  return out;
}

export interface PlayerNumbered extends Numbered { state: string | null; height: number; icon: string; memory: boolean }

/**
 * 玩家看得到的编号（玩家窗口、试玩、给 AI 的"玩家视角"图都用这一份）。map 是这个人眼里的那张图（fog / seen 已换成他的）。
 * - 物件：现在看得见的按实时的样子；看不见、但记得的按记忆（位置、尺寸、名字、状态都是记忆里的）；
 *   主持人后来删掉的物件，记忆里还在，但主持人那边已经没有编号，就不标号（编号对不上任何东西）。
 * - 棋子：玩家角色总标；其余的看得见才标。连接点：没隐藏、看得见才标（连接点不进记忆）。
 */
export function playerNumbering(world: World, map: GameMap): PlayerNumbered[] {
  const W = map.width;
  const liveRect = (n: { x: number; y: number; w: number; h: number }) => {
    return anyVisible(map, n);
  };
  const all = numbering(world, map, false);
  const label = new Map([...all.map((n) => [n.id, n.label] as const), ...Object.entries(world.labels ?? {})]); // 玩家世界里删掉的（隐藏的）物件，编号在 labels 里
  const out: PlayerNumbered[] = [];
  const shown = new Set<string>();
  for (const o of map.objects) {
    if (o.kind !== 'object' || o.hidden || !liveRect(o)) continue;
    shown.add(o.id);
    out.push({ label: label.get(o.id)!, kind: 'object', id: o.id, x: o.x, y: o.y, w: o.w, h: o.h, name: o.name, icon: o.icon, height: o.height,
      state: o.states.length > 1 ? o.states[o.state] : null, memory: false });
  }
  const greyRect = (n: { x: number; y: number; w: number; h: number }) => {
    for (let y = Math.max(0, n.y); y < Math.min(map.height, n.y + n.h); y++)
      for (let x = Math.max(0, n.x); x < Math.min(W, n.x + n.w); x++) if (map.fog[y * W + x] === 2) return true;
    return false;
  };
  for (const r of map.seen.objects) {
    const lb = label.get(r.id);
    if (shown.has(r.id) || !lb || liveRect(r) || !greyRect(r)) continue; // 记忆要落在灰区里才标（抹黑了的不标）
    out.push({ label: lb, kind: 'object', id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, name: r.name, icon: r.icon, height: r.height, state: r.stateLabel, memory: true });
  }
  for (const n of all) {
    if (n.kind === 'token') {
      const t = map.tokens.find((x) => x.id === n.id);
      if (t && (t.pcId === world.viewerId || fogAt(map, map, tokenPosition(t).x, tokenPosition(t).y) === 1)) out.push({ ...n, state: null, height: 0, icon: '', memory: false });
    } else if (n.kind === 'conn') {
      const c = world.connections.find((x) => x.id === n.id);
      if (c && !c.hidden && map.fog[n.y * W + n.x] === 1) out.push({ ...n, state: null, height: 0, icon: '', memory: false });
    }
  }
  const order = (l: string) => [l[0] === 'O' ? 0 : l[0] === 'T' ? 1 : 2, Number(l.slice(1))];
  return out.sort((a, b) => { const x = order(a.label), y = order(b.label); return x[0] - y[0] || x[1] - y[1]; });
}

const BADGE_COLOR: Record<Numbered['kind'], string> = { object: '#ffd166', zone: '#9ec1ff', token: '#b5e6b8', conn: '#d9b8ff' };

/** 在屏幕坐标里画编号徽章（不随缩放变大变小）。 */
function drawBadges(ctx: CanvasRenderingContext2D, items: Numbered[], view: View, visible: (n: Numbered) => boolean) {
  ctx.font = '700 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const n of items) {
    if (!visible(n)) continue;
    const cell = CS * view.zoom;
    let sx = view.panX + n.x * cell + 2, sy = view.panY + n.y * cell + 2;
    if (n.kind === 'token') { sx = view.panX + (n.x + 1) * cell - 20; sy = view.panY + (n.y + 1) * cell - 15; }
    if (n.kind === 'conn') { sx = view.panX + (n.x + 1) * cell - 20; sy = view.panY + n.y * cell + 1; }
    const w = Math.max(18, ctx.measureText(n.label).width + 8);
    ctx.fillStyle = BADGE_COLOR[n.kind];
    ctx.fillRect(sx, sy, w, 15);
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx, sy, w, 15);
    ctx.fillStyle = '#111';
    ctx.fillText(n.label, sx + w / 2, sy + 8);
  }
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

/** 贴着画面边缘的坐标尺：平移缩放时一直看得到。 */
function drawRulers(ctx: CanvasRenderingContext2D, cw: number, ch: number, map: GameMap, view: View) {
  const cell = CS * view.zoom;
  const step = cell >= 20 ? 1 : cell >= 8 ? 5 : 10;
  ctx.fillStyle = 'rgba(14,14,18,0.82)';
  ctx.fillRect(0, 0, cw, 16);
  ctx.fillRect(0, 0, 24, ch);
  ctx.fillStyle = '#b8b3a6';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let x = 0; x < map.width; x++) {
    if (step > 1 && x % step !== 0) continue;
    const sx = view.panX + (x + 0.5) * cell;
    if (sx > 24 && sx < cw) ctx.fillText(colName(x), sx, 8);
  }
  for (let y = 0; y < map.height; y++) {
    if (step > 1 && (y + 1) % step !== 0 && y !== 0) continue;
    const sy = view.panY + (y + 0.5) * cell;
    if (sy > 16 && sy < ch) ctx.fillText(String(y + 1), 12, sy);
  }
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

function textColor(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#111';
  const n = parseInt(m[1], 16);
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 140 ? '#1a1a1a' : '#f4f1ea';
}

export function brushCells(cx: number, cy: number, n: number) {
  const off = Math.floor((n - 1) / 2);
  const out: [number, number][] = [];
  for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) out.push([cx - off + dx, cy - off + dy]);
  return out;
}

const tokenGlyph = (name: string) => {
  const s = name.includes('·') ? name.split('·').pop()! : name;
  return s.trim().charAt(0) || '?';
};

function drawObject(ctx: CanvasRenderingContext2D, o: MapObject, player: boolean, zoom: number, scale: number, labelOnly = false, showLabel = true) {
  const X = o.x * CS, Y = o.y * CS, W = o.w * CS, H = o.h * CS;
  // 靠状态开合的物件（隔断、门）：此刻不挡路时只画虚线轮廓，表示板片收起了、人可以从这里过去。
  const ghost = !!o.blocksWhen && !o.blocksWhen.includes(o.state);
  if (!labelOnly) {
    if (ghost) {
      ctx.save();
      ctx.globalAlpha = player ? 0.5 : 0.75;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = o.color;
      ctx.strokeRect(X + 2, Y + 2, W - 4, H - 4);
      ctx.restore();
    } else {
      // 2.5D：越高，影子拉得越长、边缘越虚（羽化）。canvas 的阴影参数不跟着缩放走，所以乘上 scale。
      const lift = Math.min(o.height, 8) * 5;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = (4 + lift * 0.9) * scale;
      ctx.shadowOffsetX = lift * 0.7 * scale;
      ctx.shadowOffsetY = lift * scale;
      ctx.globalAlpha = !player && o.hidden ? 0.55 : 1;
      ctx.fillStyle = o.color;
      ctx.fillRect(X + 2, Y + 2, W - 4, H - 4);
      ctx.restore();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      if (!player && o.hidden) ctx.setLineDash([4, 3]);
      ctx.strokeRect(X + 2, Y + 2, W - 4, H - 4);
      ctx.setLineDash([]);
    }

  }
  // 细节多少看屏幕上有多大：够大才写字，太小只放图标，详情靠悬停/选中时的浮签
  if (showLabel) {
  const big = W * zoom >= 110 && H * zoom >= 44;
  ctx.save();
  ctx.beginPath();
  ctx.rect(X + 2, Y + 2, W - 4, H - 4);
  ctx.clip();
  // Only flat outline markers need help against an unknown terrain background.
  const outlined = o.height === 0 && ghost;
  if (ghost && !outlined) ctx.globalAlpha = 0.6;
  ctx.fillStyle = outlined ? '#f4f1ea' : textColor(o.color);
  if (outlined) { ctx.strokeStyle = 'rgba(18,18,24,0.8)'; ctx.lineWidth = 1 / zoom; ctx.lineJoin = 'round'; }
  const label = (text: string, x: number, y: number) => { if (outlined) ctx.strokeText(text, x, y); ctx.fillText(text, x, y); };
  if (big) {
    ctx.font = '600 10px system-ui, sans-serif';
    label((o.icon ? o.icon + ' ' : '') + o.name, X + 5, Y + 13);
    ctx.font = '9px system-ui, sans-serif';
    if (o.states.length > 1) label(`[${o.states[o.state] ?? ''}]`, X + 5, Y + 24);
    if (o.height > 0) {
      const t = `${o.height}m`;
      label(t, X + W - 5 - ctx.measureText(t).width, Y + H - 5);
    }
  } else {
    const glyph = o.icon || o.name.charAt(0);
    const fs = Math.min(W, H) * 0.55;
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    label(glyph, X + W / 2, Y + H / 2 + 1);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
  }
  if (labelOnly) return;
  // 角标：黄点 = 有隐藏信息，蓝点 = 有媒体
  if (!player) {
    const dots = [o.secrets.length ? '#ffd166' : '', o.media.length ? '#7aa2f7' : ''].filter(Boolean);
    dots.forEach((c, i) => {
      ctx.beginPath();
      ctx.arc(X + W - 5 - i * 7, Y + 5, 3, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.stroke();
    });
  }
}

/** 悬停/选中时，在物件上方显示一个浮签：名字 [状态] · 高度。 */
function drawTag(ctx: CanvasRenderingContext2D, o: MapObject, zoom: number) {
  const parts = [(o.icon ? o.icon + ' ' : '') + o.name];
  if (o.states.length > 1) parts.push(`[${o.states[o.state] ?? ''}]`);
  if (o.kind === 'object' && o.height > 0) parts.push(`${o.height}m`);
  const fullText = parts.join(' ');
  const fs = 12 / zoom;
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  const text = fitLabel(ctx, fullText, 240 / zoom);
  const tw = ctx.measureText(text).width;
  const pad = 5 / zoom;
  const cx = (o.x + o.w / 2) * CS;
  const bx = cx - tw / 2 - pad, by = o.y * CS - fs - pad * 3;
  ctx.fillStyle = 'rgba(18,18,24,0.92)';
  ctx.fillRect(bx, by, tw + pad * 2, fs + pad * 2);
  ctx.strokeStyle = '#ffd166';
  ctx.lineWidth = 1 / zoom;
  ctx.strokeRect(bx, by, tw + pad * 2, fs + pad * 2);
  ctx.fillStyle = '#f4f1ea';
  ctx.fillText(text, bx + pad, by + pad + fs * 0.85);
}

/** 记忆里的物件，借用普通物件的画法。 */
function fromMemory(r: SeenObject): MapObject {
  return {
    ...r, kind: 'object', states: r.stateLabel === null ? ['默认'] : ['', r.stateLabel], state: r.stateLabel === null ? 0 : 1,
    notes: '', hidden: false, secrets: [], media: [],
  };
}

function cellsPath(map: GameMap, x0: number, y0: number, x1: number, y1: number, fogValue: number) {
  const p = new Path2D();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const n = isSubdivided(map, x, y) ? 3 : 1;
    for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) if (fogAt(map, map, x + (sx + .5) / n, y + (sy + .5) / n) === fogValue) p.rect((x + sx / n) * CS, (y + sy / n) * CS, CS / n, CS / n);
  }
  return p;
}

function fitLabel(ctx: CanvasRenderingContext2D, text: string, width: number) {
  if (ctx.measureText(text).width <= width) return text;
  let clipped = text;
  while (clipped && ctx.measureText(clipped + '…').width > width) clipped = clipped.slice(0, -1);
  return clipped + '…';
}

function drawZone(ctx: CanvasRenderingContext2D, o: MapObject, active: boolean, zoom: number) {
  const X = o.x * CS, Y = o.y * CS, W = o.w * CS, H = o.h * CS;
  ctx.save();
  ctx.strokeStyle = o.color;
  ctx.globalAlpha = active ? .9 : .35;
  ctx.lineWidth = (active ? 1.5 : 1) / zoom;
  ctx.setLineDash([5 / zoom, 4 / zoom]);
  ctx.strokeRect(X + 1, Y + 1, W - 2, H - 2);
  ctx.restore();
}

export function render(
  ctx: CanvasRenderingContext2D, cw: number, ch: number, dpr: number,
  world: World, map0: GameMap, view: View, o: RenderOpts,
) {
  // 视野各自独立时，玩家视角换成这个人自己的那份迷雾和记忆；后面的代码照常读 map.fog / map.seen
  const own = o.mode === 'player' && o.viewer ? effectiveLayer(world, map0, o.viewer) : undefined; // 这个人还没有视野层：什么都没看过
  const map: GameMap = own ? { ...map0, fog: own.fog, subFog: own.subFog, seen: own.seen } : map0;
  const player = o.mode === 'player';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = player ? '#08080b' : '#17181d';
  ctx.fillRect(0, 0, cw, ch);
  ctx.translate(view.panX, view.panY);
  ctx.scale(view.zoom, view.zoom);

  const W = map.width, H = map.height;
  const x0 = Math.max(0, Math.floor(-view.panX / view.zoom / CS));
  const y0 = Math.max(0, Math.floor(-view.panY / view.zoom / CS));
  const x1 = Math.min(W - 1, Math.ceil((cw - view.panX) / view.zoom / CS));
  const y1 = Math.min(H - 1, Math.ceil((ch - view.panY) / view.zoom / CS));
  const terrains = new Map(world.terrains.map((t) => [t.id, t]));

  ctx.fillStyle = '#262830';
  ctx.fillRect(0, 0, W * CS, H * CS);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      const n = isSubdivided(map, x, y) ? 3 : 1;
      for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) {
        const f = fogAt(map, map, x + (sx + .5) / n, y + (sy + .5) / n), key = (y * 3 + sy) * W * 3 + x * 3 + sx;
        const id = player ? (f === 1 ? map.cells[i] : f === 2 ? n === 3 ? map.seen.subCells?.[key] ?? '' : map.seen.cells[i] : '') : map.cells[i];
        if (!id) continue;
        ctx.fillStyle = terrains.get(id)?.color ?? '#ff00ff';
        ctx.fillRect((x + sx / n) * CS, (y + sy / n) * CS, CS / n + .1, CS / n + .1);
      }
    }

  // 网格
  ctx.strokeStyle = 'rgba(0,0,0,0.16)';
  ctx.lineWidth = 1 / view.zoom;
  ctx.beginPath();
  for (let x = x0; x <= x1 + 1; x++) { ctx.moveTo(x * CS, y0 * CS); ctx.lineTo(x * CS, (y1 + 1) * CS); }
  for (let y = y0; y <= y1 + 1; y++) { ctx.moveTo(x0 * CS, y * CS); ctx.lineTo((x1 + 1) * CS, y * CS); }
  ctx.stroke();

  if (!player && o.subgrid) for (const i of map.subdivisions ?? []) {
    const x = i % W, y = Math.floor(i / W);
    ctx.strokeStyle = 'rgba(120,190,210,.6)'; ctx.lineWidth = .65 / view.zoom;
    ctx.strokeRect(x * CS, y * CS, CS, CS); ctx.beginPath();
    for (let j = 1; j < 3; j++) { ctx.moveTo((x + j / 3) * CS, y * CS); ctx.lineTo((x + j / 3) * CS, (y + 1) * CS); ctx.moveTo(x * CS, (y + j / 3) * CS); ctx.lineTo((x + 1) * CS, (y + j / 3) * CS); }
    ctx.stroke();
  }
  // 房间底色（主持人视角；墙上不涂）
  if (!player && map.rooms.length) {
    const rc = new Map(map.rooms.map((r) => [r.id, r.color]));
    ctx.globalAlpha = 0.3;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        const c = map.roomCells[i] && rc.get(map.roomCells[i]);
        if (!c || terrains.get(map.cells[i])?.blocksMove) continue;
        ctx.fillStyle = c;
        ctx.fillRect(x * CS, y * CS, CS, CS);
      }
    ctx.globalAlpha = 1;
  }

  // D100 区域
  if (!player) {
    ctx.fillStyle = 'rgba(220,40,70,0.22)';
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (map.d100[y * W + x]) ctx.fillRect(x * CS, y * CS, CS, CS);
  }

  // 选中玩家棋子：画出"看清"的三档（1 / 5 / 15 格），只画看得见的格子
  const st = o.selection?.type === 'token' && o.selection.mapId === map.id ? map.tokens.find((t) => t.id === (o.selection as { id: string }).id) : null;
  if (st && st.pcId && !player) {
    const cost = sightCosts(world, map);
    const R = CLEAR_BANDS[CLEAR_BANDS.length - 1].d;
    const alpha = [0.3, 0.17, 0.07];
    for (let y = Math.max(y0, st.y - R); y <= Math.min(y1, st.y + R); y++)
      for (let x = Math.max(x0, st.x - R); x <= Math.min(x1, st.x + R); x++) {
        const d = gridDist(x + .5 - tokenPosition(st).x, y + .5 - tokenPosition(st).y);
        const band = CLEAR_BANDS.findIndex((b) => d <= b.d);
        if (band < 0 || !seesPoint(cost, map, st, { x: x + .5, y: y + .5 })) continue;
        ctx.fillStyle = `rgba(129,226,255,${alpha[band]})`;
        ctx.fillRect(x * CS, y * CS, CS, CS);
      }
  }

  // 选中物件的"看清"范围：青色 = 自动浮现，黄色 = 要过骰
  const so = o.selection?.type === 'object' && o.selection.mapId === map.id ? map.objects.find((x) => x.id === (o.selection as { id: string }).id) : null;
  if (so && !player && so.secrets.length) {
    const ranges = so.secrets.map((s) => ({ r: s.range, c: s.kind === 'auto' ? 'rgba(94,200,200,0.16)' : 'rgba(255,209,102,0.14)' }));
    const maxR = Math.max(...ranges.map((x) => x.r));
    for (let y = Math.max(y0, so.y - maxR); y <= Math.min(y1, so.y + so.h - 1 + maxR); y++)
      for (let x = Math.max(x0, so.x - maxR); x <= Math.min(x1, so.x + so.w - 1 + maxR); x++) {
        const d = distToRect(x, y, so).d;
        for (const rg of ranges) if (d <= rg.r) { ctx.fillStyle = rg.c; ctx.fillRect(x * CS, y * CS, CS, CS); }
      }
  }

  // 物件（矮的先画）、触发区
  const byHeight = (a: { height: number }, b: { height: number }) => a.height - b.height;
  const labelSets: { objects: MapObject[]; fog?: number }[] = [];
  const drawObjects = (objects: MapObject[], fog?: number) => {
    if (fog) { ctx.save(); ctx.clip(cellsPath(map, x0, y0, x1, y1, fog)); }
    objects.sort(byHeight).forEach(ob => drawObject(ctx, ob, player, view.zoom, view.zoom * dpr, false, false));
    if (fog) ctx.restore();
    labelSets.push({ objects, fog });
  };
  if (!player) drawObjects(map.objects.filter(ob => ob.kind === 'object' && !isArchitectureObject(ob)));
  else {
    drawObjects(map.objects.filter(ob => ob.kind === 'object' && !isArchitectureObject(ob) && !ob.hidden && anyVisible(map, ob)), 1);
    drawObjects(map.seen.objects.map(fromMemory).filter(ob => {
      for (let y = ob.y; y < ob.y + ob.h; y++) for (let x = ob.x; x < ob.x + ob.w; x++)
        if (fogAt(map, map, x + .5, y + .5) === 2) return true;
      return false;
    }), 2);
  }
  if (!player) map.objects.filter(ob => ob.kind === 'zone').forEach(ob => drawZone(ctx, ob,
    o.selection?.type === 'object' && o.selection.id === ob.id || o.tool === 'zone', view.zoom));

  // 建筑层：使用碰撞的实际矩形尺寸；玩家只画可见裁片与历史。
  const drawArchitecture = (fragments: import('./types').ArchitectureFragment[]) => {
    for (const r of fragments) {
      ctx.fillStyle = r.material === 'glass' ? '#70c6dd' : r.material === 'door' ? '#966c41' : '#41434a';
      ctx.strokeStyle = r.material === 'glass' ? '#c1f3ff' : '#14171c'; ctx.lineWidth = .65 / view.zoom;
      if (r.material === 'opening') { ctx.strokeStyle = '#a98c62'; ctx.setLineDash([2, 2]); ctx.strokeRect(r.x * CS, r.y * CS, r.w * CS, r.h * CS); ctx.setLineDash([]); }
      else { ctx.fillRect(r.x * CS, r.y * CS, r.w * CS, r.h * CS); ctx.strokeRect(r.x * CS, r.y * CS, r.w * CS, r.h * CS); }
    }
  };
  if (!player) drawArchitecture(architectureGeometry(map, true));
  else { drawArchitecture(clipArchitecture(map, map, 2, map.seen.architecture ?? [])); drawArchitecture((map.architecture || map.objects.some(isArchitectureObject)) ? clipArchitecture(map, map) : clipArchitecture(map, map, 1, map.architectureFragments ?? [])); }

  // 连接点
  for (const c of world.connections) {
    for (const end of [c.a, c.b]) {
      if (end.mapId !== map.id || (player && (c.hidden || map.fog[end.y * W + end.x] !== 1))) continue; // 连接点不进记忆，玩家只在看得见时看到
      const cx = (end.x + 0.5) * CS, cy = (end.y + 0.5) * CS;
      ctx.beginPath();
      ctx.arc(cx, cy, CS * 0.36, 0, Math.PI * 2);
      ctx.fillStyle = c.kind === 'portal' ? '#5b3b8c' : '#2b2f3a';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#f1e6c8';
      if (c.hidden) ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#f1e6c8';
      ctx.font = '600 14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(CONN_ICON[c.kind], cx, cy + 1);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }
  }

  // Only the representative label is drawn for objects sharing an anchor cell.
  // This is display aggregation: all object footprints and interactions stay intact.
  for (const { objects, fog } of labelSets) {
    if (fog) { ctx.save(); ctx.clip(cellsPath(map, x0, y0, x1, y1, fog)); }
    const stacks = new Map<string, MapObject[]>();
    for (const ob of objects) {
      const key = `${Math.floor(ob.x + ob.w / 2)},${Math.floor(ob.y + ob.h / 2)}`;
      const stack = stacks.get(key) ?? []; stack.push(ob); stacks.set(key, stack);
    }
    for (const stack of stacks.values()) {
      const representative = stack.find(ob => ob.id === so?.id) ?? [...stack].sort((a, b) => a.id.localeCompare(b.id))[0];
      drawObject(ctx, representative, player, view.zoom, view.zoom * dpr, true);
      if (stack.length > 1) {
        const x = (representative.x + representative.w) * CS - 3 / view.zoom, y = representative.y * CS + 11 / view.zoom;
        ctx.save(); ctx.font = `${9 / view.zoom}px system-ui, sans-serif`; ctx.textAlign = 'right';
        ctx.lineWidth = 2 / view.zoom; ctx.strokeStyle = 'rgba(18,18,24,.85)'; ctx.fillStyle = '#f4f1ea';
        ctx.strokeText(`+${stack.length - 1}`, x, y); ctx.fillText(`+${stack.length - 1}`, x, y); ctx.restore();
      }
    }
    if (fog) ctx.restore();
  }

  // 棋子
  for (const t of map.tokens) {
    if (player && !(t.pcId && o.viewer && visionMembers(world, o.viewer).includes(t.pcId)) && t.pcId !== world.viewerId && fogAt(map, map, tokenPosition(t).x, tokenPosition(t).y) !== 1) continue;
    const pos = tokenPosition(t), cx = pos.x * CS, cy = pos.y * CS;
    ctx.beginPath();
    ctx.arc(cx, cy, CS * 0.38, 0, Math.PI * 2);
    ctx.fillStyle = t.color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = textColor(t.color);
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tokenGlyph(t.name), cx, cy + 1);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  // 普通人 NPC（主持人视角）：本场安排的、在场的画实；等回访的淡一点；没安排的、已结束的不画
  if (!player) {
    const month = new Date().getMonth() + 1;
    for (const n of world.npcs ?? []) {
      const p = n.progress;
      // 只画本场安排的、在场的、有事没了结的（等回访的淡一点）
      if (!n.place || n.place.mapId !== map.id || p.status === 'done' || p.status === 'waiting' && !p.cast) continue;
      const off = p.status === 'advised' || (p.status === 'waiting' && n.months.length > 0 && !n.months.includes(month));
      const cx = (n.place.x + 0.5) * CS, cy = (n.place.y + 0.5) * CS;
      ctx.globalAlpha = off ? 0.35 : 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy - CS * 0.42); ctx.lineTo(cx + CS * 0.42, cy); ctx.lineTo(cx, cy + CS * 0.42); ctx.lineTo(cx - CS * 0.42, cy); ctx.closePath();
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n.icon, cx, cy + 1);
      ctx.fillStyle = n.color;
      ctx.font = '600 9px system-ui, sans-serif';
      ctx.fillText(n.name, cx, cy + CS * 0.62);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
      ctx.globalAlpha = 1;
    }
  }

  // 迷雾
  if (player || o.mode !== 'edit' || o.showFog) {
    const black = player ? '#000' : 'rgba(8,8,16,0.62)';
    const grey = player ? 'rgba(14,14,22,0.58)' : 'rgba(40,40,60,0.32)';
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const n = isSubdivided(map, x, y) ? 3 : 1;
        for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) {
          const f = fogAt(map, map, x + (sx + .5) / n, y + (sy + .5) / n);
          if (f === 1) continue;
          ctx.fillStyle = f === 2 ? grey : black;
          ctx.fillRect((x + sx / n) * CS, (y + sy / n) * CS, CS / n, CS / n);
        }
      }
    // 主持人：玩家记得的样子已经过时的物件
    if (!player) {
      ctx.strokeStyle = '#ff9f43';
      ctx.fillStyle = '#ff9f43';
      ctx.lineWidth = 1.5;
      ctx.font = '600 9px system-ui, sans-serif';
      for (const r of staleMemories(map)) {
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(r.x * CS + 1, r.y * CS + 1, r.w * CS - 2, r.h * CS - 2);
        ctx.setLineDash([]);
        ctx.fillText(`玩家记得：${r.name}${r.stateLabel ? `[${r.stateLabel}]` : ''}`, r.x * CS + 2, r.y * CS - 3);
      }
    }
  }

  // 选中 / 预览 / 悬停
  ctx.lineWidth = 2.5 / Math.max(view.zoom, 0.5);
  ctx.strokeStyle = '#ffd166';
  const sel = o.selection;
  if (sel?.type === 'object' && sel.mapId === map.id) {
    const ob = map.objects.find((x) => x.id === sel.id);
    if (ob) ctx.strokeRect(ob.x * CS, ob.y * CS, ob.w * CS, ob.h * CS);
  } else if (sel?.type === 'token' && sel.mapId === map.id) {
    const t = map.tokens.find((x) => x.id === sel.id);
    if (t) { ctx.beginPath(); ctx.arc(tokenPosition(t).x * CS, tokenPosition(t).y * CS, CS * 0.48, 0, Math.PI * 2); ctx.stroke(); }
  } else if (sel?.type === 'cell' && sel.mapId === map.id) {
    ctx.strokeRect(sel.x * CS, sel.y * CS, CS, CS);
  } else if (sel?.type === 'conn') {
    const c = world.connections.find((x) => x.id === sel.id);
    c && [c.a, c.b].filter((e) => e.mapId === map.id).forEach((e) => {
      ctx.beginPath(); ctx.arc((e.x + 0.5) * CS, (e.y + 0.5) * CS, CS * 0.48, 0, Math.PI * 2); ctx.stroke();
    });
  }
  if (o.pending?.mapId === map.id) {
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.arc((o.pending.x + 0.5) * CS, (o.pending.y + 0.5) * CS, CS * 0.45, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (o.preview) {
    const p = o.preview;
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(p.x * CS, p.y * CS, p.w * CS, p.h * CS);
    ctx.setLineDash([]);
  }
  const tagged = new Set<MapObject>();
  if (!player) {
    if (so) tagged.add(so);
    if (o.tool === 'zone') map.objects.filter(ob => ob.kind === 'zone').forEach(ob => tagged.add(ob));
    if (o.hover && o.tool === 'select') {
      const h = o.hover;
      const ho = map.objects.filter((x) => h.x >= x.x && h.x < x.x + x.w && h.y >= x.y && h.y < x.y + x.h)
        .sort((a, b) => Number(a.kind === 'zone') - Number(b.kind === 'zone') || b.height - a.height)[0];
      if (ho) tagged.add(ho);
    }
  }
  if (o.hover && !player && ['paint', 'erase', 'd100', 'room', 'fogReveal', 'fogHide', 'fogBlack'].includes(o.tool)) {
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.5 / view.zoom;
    for (const [x, y] of brushCells(o.hover.x, o.hover.y, o.brush)) ctx.strokeRect(x * CS, y * CS, CS, CS);
  }
  // 屏幕坐标里的叠加层：编号、坐标尺
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (o.numbers) drawBadges(ctx, player ? playerNumbering(world, map) : numbering(world, map), view, () => true);
  if (!player && map.rooms.length) drawRoomLabels(ctx, map, view);
  drawMarks(ctx, world, map, view, player ? o.viewer ?? null : null);
  if (!player && map.spawn) {
    const cell = CS * view.zoom;
    ctx.font = `${Math.max(12, cell * 0.6)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9fe0a3';
    ctx.fillText('⚑', view.panX + (map.spawn.x + 0.5) * cell, view.panY + (map.spawn.y + 0.5) * cell);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }
  if (o.rulers) drawRulers(ctx, cw, ch, map, view);
  if (tagged.size) {
    ctx.save();
    ctx.translate(view.panX, view.panY); ctx.scale(view.zoom, view.zoom);
    tagged.forEach(t => drawTag(ctx, t, view.zoom));
    ctx.restore();
  }
}

/** 房间名写在房间中间（屏幕坐标，房间在屏幕上太小就不写）。 */
function drawRoomLabels(ctx: CanvasRenderingContext2D, map: GameMap, view: View) {
  const cellsOf = new Map<string, number[]>();
  map.roomCells.forEach((id, i) => { if (id) { const cells = cellsOf.get(id) ?? []; cells.push(i); cellsOf.set(id, cells); } });
  const cell = CS * view.zoom;
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const r of map.rooms) {
    const cs = cellsOf.get(r.id);
    if (!cs) continue;
    const xs = cs.map((i) => i % map.width), ys = cs.map((i) => Math.floor(i / map.width));
    if ((Math.max(...xs) - Math.min(...xs) + 1) * cell < ctx.measureText(r.name).width + 10) continue;
    // 环形的房间（比如回廊）中心不在房间里，所以取房间内离中心最近的那一格
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const width = ctx.measureText(r.name).width + 12, height = 20;
    const candidates = cs.map((i, k) => ({ x: xs[k], y: ys[k], distance: (xs[k] - mx) ** 2 + (ys[k] - my) ** 2 })).sort((a, b) => a.distance - b.distance);
    // Test the entire label footprint, not just its anchor: nearby furniture and
    // narrow/disconnected room shapes must not end up behind the name.
    const anchor = candidates.find(({ x, y }) => {
      const left = x + .5 - width / (2 * cell), top = y + .5 - height / (2 * cell);
      const right = left + width / cell, bottom = top + height / cell;
      for (let cy = Math.floor(top); cy < Math.ceil(bottom); cy++) for (let cx = Math.floor(left); cx < Math.ceil(right); cx++)
        if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height || map.roomCells[cy * map.width + cx] !== r.id) return false;
      return !map.objects.some(ob => ob.kind === 'object' && left < ob.x + ob.w && right > ob.x && top < ob.y + ob.h && bottom > ob.y) &&
        !map.tokens.some(t => left < t.x + 1 && right > t.x && top < t.y + 1 && bottom > t.y);
    });
    if (!anchor) continue;
    const sx = view.panX + (anchor.x + .5) * cell, sy = view.panY + (anchor.y + .5) * cell;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(20,20,26,0.75)';
    ctx.strokeText(r.name, sx, sy);
    ctx.fillStyle = '#f4f1ea';
    ctx.fillText(r.name, sx, sy);
  }
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

/** 玩家做的标记：画在迷雾上面（这是他脑子里的地图），越旧越淡。 */
function drawMarks(ctx: CanvasRenderingContext2D, world: World, map: GameMap, view: View, viewer: string | null) {
  const marks = visibleMarks(world, map.id, viewer);
  if (!marks.length) return;
  const cell = CS * view.zoom;
  const color = new Map(world.party.map((p) => [p.id, p.color]));
  const r = Math.max(7, cell * 0.32);
  for (const k of marks) {
    // 照遗忘曲线淡去：刚做的标记掉得快，后面慢慢变淡
    const left = 1 - Math.sqrt(Math.min(1, (Date.now() - k.createdAt) / (k.life * 60000)));
    const sx = view.panX + (k.x + 0.5) * cell, sy = view.panY + (k.y + 0.5) * cell;
    ctx.globalAlpha = Math.max(0.15, left);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,20,26,0.85)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color.get(k.author) ?? '#ffd166';
    ctx.stroke();
    ctx.fillStyle = color.get(k.author) ?? '#ffd166';
    ctx.font = `700 ${Math.round(r * 1.2)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(k.symbol, sx, sy + 1);
    if (k.text) {
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(10,10,14,0.9)';
      ctx.strokeText(k.text, sx, sy + r + 9);
      ctx.fillStyle = '#f4f1ea';
      ctx.fillText(k.text, sx, sy + r + 9);
    }
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}
