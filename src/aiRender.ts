import type { GameMap, World } from './types';
import { CONN_LABEL } from './types';
import { numbering, playerNumbering, render, type Numbered, type PlayerNumbered } from './render';
import { playerWorld } from './sync';
import { CS, cellName, colName, rangeName } from './util';

// 给 AI 看的地图：四周标坐标，每样东西打编号（和主编辑器的"显示编号"一致），旁边附图例（编号 ↔ 名字/状态/坐标/id）。
// view = 'kp'：主持人视角，什么都画；'player'：玩家视角，带迷雾和记忆，只列玩家看得到的东西。

const CELL = 40;
const M = 34;
const LEGEND_W = 440;

export function renderMapForAI(world0: World, map0: GameMap, view: 'kp' | 'player' = 'kp'): HTMLCanvasElement {
  const player = view === 'player';
  // 玩家视角：先换成发给玩家窗口的那份世界（主持人才知道的已经删掉），地图和图例都只从它取，图例里灰区的东西用记忆
  const world = player ? playerWorld(world0, map0.id) : world0;
  const map = player ? world.maps[0] : map0;
  const mw = map.width * CELL, mh = map.height * CELL;
  const items: (Numbered & Partial<PlayerNumbered>)[] = player ? playerNumbering(world, map) : numbering(world, map);
  const H = Math.max(M + mh + 16, 60 + (items.length * 2 + 10) * 17);
  const W = M + mw + 16 + LEGEND_W;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const view0 = { zoom: CELL / CS, panX: M, panY: M };
  render(ctx, W, H, 1, world, map, view0, {
    mode: player ? 'player' : 'edit', selection: null, preview: null, hover: null, brush: 1, tool: 'select',
    pending: null, showFog: false, numbers: true, rulers: false,
  });

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#17181d';
  ctx.fillRect(0, 0, M + mw, M - 2);
  ctx.fillRect(0, 0, M - 2, M + mh);
  ctx.fillStyle = '#cfcabd';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let x = 0; x < map.width; x++) ctx.fillText(colName(x), M + (x + 0.5) * CELL, M / 2);
  for (let y = 0; y < map.height; y++) ctx.fillText(String(y + 1), M / 2, M + (y + 0.5) * CELL);

  const lx = M + mw + 16;
  ctx.fillStyle = '#121318';
  ctx.fillRect(lx - 8, 0, W - lx + 8, H);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  let ly = 22;
  const line = (text: string, color = '#e8e4da', bold = false) => {
    ctx.font = `${bold ? '700 13px' : '12px'} system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(text, lx, ly, LEGEND_W - 12);
    ly += bold ? 20 : 17;
  };
  line(`${map.layer} · F${map.floor} · ${map.name}　${map.width}×${map.height} 格（列 A→ 向右，行 1→ 向下）`, '#ffd166', true);
  line(player ? '玩家视角：黑 = 没去过；灰 = 去过，只显示记忆里的样子' : '主持人视角：没有迷雾，隐藏的东西也画出来', player ? '#e6c2ff' : '#8d8a82');
  line(`map id: ${map.id}`, '#8d8a82');
  ly += 4;
  for (const n of items) {
    if (player && n.kind === 'object') {
      line(`${n.label} ${n.icon} ${n.name}${n.state != null ? ` [${n.state}]` : ''}${n.memory ? '（记忆）' : ''}`, '#ffd166');
      line(`    ${rangeName(n)} ${n.w}×${n.h} 高${n.height}m · id ${n.id}`, '#8d8a82');
    } else if (n.kind === 'object' || n.kind === 'zone') {
      const o = map.objects.find((x) => x.id === n.id)!;
      const st = o.states.length > 1 ? ` [${o.states[o.state]}]` : '';
      const all = o.states.length > 1 ? `（状态：${o.states.join(' / ')}）` : '';
      line(`${n.label} ${o.icon} ${o.name}${st}${all}`, n.kind === 'zone' ? '#9ec1ff' : '#ffd166');
      const extra = `${o.hidden ? ' 对玩家隐藏' : ''}${o.secrets.length ? ` · 隐藏信息 ${o.secrets.length} 条` : ''}`;
      line(`    ${rangeName(o)} ${o.w}×${o.h}${o.kind === 'object' ? ` 高${o.height}m` : ''}${extra} · id ${o.id}`, '#8d8a82');
    } else if (n.kind === 'token') {
      const t = map.tokens.find((x) => x.id === n.id)!;
      line(`${n.label} 棋子：${t.name}${t.pcId ? '（玩家）' : ''} ${cellName(t.x, t.y)}`, '#b5e6b8');
    } else {
      const cn = world.connections.find((x) => x.id === n.id)!;
      const here = cn.a.mapId === map.id ? cn.a : cn.b, there = cn.a.mapId === map.id ? cn.b : cn.a;
      const dest = world0.maps.find((m) => m.id === there.mapId);
      const tm = player && dest && !dest.fog.some(Boolean) ? undefined : dest; // 玩家视角：那张图去过（或拿到过地图）才写名字
      line(`${n.label} ${CONN_LABEL[cn.kind]}${cn.label ? `「${cn.label}」` : ''} ${cellName(here.x, here.y)} → ${tm ? `${tm.layer}·${tm.name}` : '?'}${player ? '' : ` ${cellName(there.x, there.y)}`}`, '#d9b8ff');
    }
  }
  ly += 6;
  const known = player ? map.cells.map((c, i) => (map.fog[i] === 1 ? c : map.fog[i] === 2 ? map.seen.cells[i] : '')) : map.cells;
  const used = [...new Set(known.filter(Boolean))].map((id) => world.terrains.find((t) => t.id === id)).filter(Boolean);
  line('地形：' + used.map((t) => `${t!.name}${t!.blocksMove ? '(不可通行)' : ''}`).join('、'), '#cfcabd');
  if (!player && map.d100.some(Boolean)) line('红色半透明 = D100 区域', '#e88');
  line(player ? '物件越高影子越长' : '物件越高影子越长；虚线框 = 触发区（玩家看不见）', '#8d8a82');
  return c;
}

export function canvasToBlob(c: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('渲染失败'))), 'image/png'));
}
