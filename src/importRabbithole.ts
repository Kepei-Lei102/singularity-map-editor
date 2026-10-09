import JSZip from 'jszip';
import type { GameMap, MapObject, MediaMeta, Room, Terrain, World } from './types';
import { DEFAULT_TERRAINS, newMap, newObject } from './defaults';
import { uid } from './util';

// 导入旧工具 Rabbithole 的地图（map.json，或连配图一起打的 bundle zip）。
// Rabbithole 每格记三样：roomId / objectId / interactiveId，格子的键是 "行,列"。
// 墙、门、楼梯、暗门、绿幕变成地形；其余物件和可交互物按连通块变成物件；房间原样保留。

interface RHCell { roomId?: string | null; objectId?: string | null; interactiveId?: string | null }
interface RHLevel { name: string; rows: number; cols: number; cells: Record<string, RHCell> }
interface RHAttachment { id: string; name: string; path: string }
interface RHItem { id: string; name: string; color?: string; note?: string; groupId?: string; attachments?: RHAttachment[] }
interface RHGroup { id: string; name: string; kind: string }
interface RHMap { levels: RHLevel[]; rooms: RHItem[]; objects: RHItem[]; interactives: RHItem[]; groups?: RHGroup[] }

const EXTRA_TERRAINS: Terrain[] = [
  { id: 'door', name: '门', color: '#c9a227', blocksMove: false, visionCoef: 1 },
  { id: 'stairs', name: '楼梯', color: '#9a8cc2', blocksMove: false, visionCoef: 0.1 },
  { id: 'secret-door', name: '暗门', color: '#55493d', blocksMove: true, visionCoef: 99 },
  { id: 'baize', name: '绿呢门', color: '#3f7d4e', blocksMove: false, visionCoef: 1 },
  { id: 'lawn', name: '草坪', color: '#a9c99a', blocksMove: false, visionCoef: 0.1 },
  { id: 'yard', name: '外围空地', color: '#bdb5a3', blocksMove: false, visionCoef: 0.1 },
];
const AS_TERRAIN: Record<string, string> = { 墙: 'wall', 门: 'door', 楼梯: 'stairs', 暗门: 'secret-door', 绿幕: 'baize' };
const HEIGHT: Record<string, number> = { 苹果树: 8, 书架: 2.2, 柜子: 1.8, 升降机: 2, 桌子: 0.75, 椅子: 0.9, 黑板: 1.5, 小沙发床: 0.5 };
const ICON: Record<string, string> = { 苹果树: '🍎', 书架: '📚', 柜子: '🗄', 升降机: '🛗', 椅子: '🪑', 小沙发床: '🛋', 黑板: '🧮' };

export interface RabbitholeImport { world: World; blobs: { id: string; blob: Blob }[]; summary: string }

/** 把同一个 id 占的格子按上下左右连通分块，每块一个外接矩形。 */
function components(cells: [number, number][]) {
  const left = new Set(cells.map(([x, y]) => `${x},${y}`));
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (const [sx, sy] of cells) {
    if (!left.has(`${sx},${sy}`)) continue;
    const stack = [[sx, sy]];
    left.delete(`${sx},${sy}`);
    let x0 = sx, x1 = sx, y0 = sy, y1 = sy;
    while (stack.length) {
      const [x, y] = stack.pop()!;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${x + dx},${y + dy}`;
        if (left.has(k)) { left.delete(k); stack.push([x + dx, y + dy]); }
      }
    }
    out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return out;
}

const floorOf = (name: string, i: number) => (/地下|basement/i.test(name) ? -1 : i === 0 ? 1 : i + 1);

export async function importRabbithole(file: File): Promise<RabbitholeImport> {
  let rh: RHMap;
  const files = new Map<string, Blob>();
  if (file.name.toLowerCase().endsWith('.json')) {
    rh = JSON.parse(await file.text());
  } else {
    const zip = await JSZip.loadAsync(file);
    const mj = zip.file('map.json');
    if (!mj) throw new Error('压缩包里没有 map.json，不像是 Rabbithole 的包');
    rh = JSON.parse(await mj.async('string'));
    for (const f of Object.values(zip.files)) if (!f.dir && f.name.startsWith('attachments/')) files.set(f.name, await f.async('blob'));
  }
  if (!Array.isArray(rh.levels) || !Array.isArray(rh.rooms)) throw new Error('不是 Rabbithole 的地图格式');

  const roomsById = new Map(rh.rooms.map((r) => [r.id, r]));
  const objById = new Map(rh.objects.map((o) => [o.id, o]));
  const intById = new Map(rh.interactives.map((o) => [o.id, o]));
  const groupName = new Map((rh.groups ?? []).map((g) => [g.id, g.name]));

  // 三层用同一个偏移，保证上下对齐；四周留两格，一楼外圈铺成能走的空地（多入口要能绕着楼走）
  let minR = Infinity, minC = Infinity, maxR = -Infinity, maxC = -Infinity;
  for (const L of rh.levels) for (const k of Object.keys(L.cells)) {
    const [r, c] = k.split(',').map(Number);
    minR = Math.min(minR, r); maxR = Math.max(maxR, r); minC = Math.min(minC, c); maxC = Math.max(maxC, c);
  }
  const MARGIN = 2;
  const W = maxC - minC + 1 + MARGIN * 2, H = maxR - minR + 1 + MARGIN * 2;
  const pos = (k: string) => { const [r, c] = k.split(',').map(Number); return { x: c - minC + MARGIN, y: r - minR + MARGIN }; };

  const media: MediaMeta[] = [];
  const blobs: { id: string; blob: Blob }[] = [];
  const mediaByPath = new Map<string, string>();
  let nObj = 0, nInt = 0;

  const maps: GameMap[] = rh.levels.map((L, li) => {
    const m = newMap(L.name, '现实', floorOf(L.name, li), W, H, '', false);
    const roomIdMap = new Map<string, string>();
    const objCells = new Map<string, [number, number][]>();
    const intCells = new Map<string, [number, number][]>();
    for (const [k, cell] of Object.entries(L.cells)) {
      const { x, y } = pos(k);
      const i = y * W + x;
      const rr = cell.roomId ? roomsById.get(cell.roomId) : undefined;
      const ob = cell.objectId ? objById.get(cell.objectId) : undefined;
      const terrain = ob && AS_TERRAIN[ob.name];
      m.cells[i] = terrain ?? (rr?.name === '棋盘区' ? 'lawn' : 'floor');
      if (rr && terrain !== 'wall' && terrain !== 'secret-door') {
        if (!roomIdMap.has(rr.id)) {
          const room: Room = {
            id: uid(), name: rr.name, color: rr.color || '#cccccc', note: rr.note || '',
            tags: rr.groupId && groupName.get(rr.groupId) ? [groupName.get(rr.groupId)!] : [],
          };
          m.rooms.push(room);
          roomIdMap.set(rr.id, room.id);
        }
        m.roomCells[i] = roomIdMap.get(rr.id)!;
      }
      if (ob && !terrain) objCells.set(ob.id, [...(objCells.get(ob.id) ?? []), [x, y]]);
      if (cell.interactiveId) intCells.set(cell.interactiveId, [...(intCells.get(cell.interactiveId) ?? []), [x, y]]);
    }
    if (m.floor === 1) m.cells = m.cells.map((c) => c || 'yard');
    for (const [id, cells] of objCells) {
      const ob = objById.get(id)!;
      for (const r of components(cells)) {
        m.objects.push({ ...newObject('object', r.x, r.y, r.w, r.h), name: ob.name, color: ob.color || '#b08968', icon: ICON[ob.name] ?? '', height: HEIGHT[ob.name] ?? 1 });
        nObj++;
      }
    }
    for (const [id, cells] of intCells) {
      const it = intById.get(id);
      if (!it) continue;
      const group = it.groupId ? groupName.get(it.groupId) : undefined;
      for (const r of components(cells)) {
        const o: MapObject = {
          ...newObject('object', r.x, r.y, r.w, r.h), name: it.name, color: it.color || '#c0510a', icon: '✦', height: 1,
          notes: (group ? `【${group}】\n` : '') + (it.note ?? '').trim(),
        };
        for (const a of it.attachments ?? []) {
          if (!a.path) continue;
          const blob = files.get(a.path);
          if (!blob) continue;
          let mediaId = mediaByPath.get(a.path);
          if (!mediaId) {
            mediaId = uid();
            mediaByPath.set(a.path, mediaId);
            const typed = blob.type ? blob : new Blob([blob], { type: a.path.endsWith('.png') ? 'image/png' : 'image/jpeg' });
            blobs.push({ id: mediaId, blob: typed });
            media.push({ id: mediaId, name: a.name || it.name, mime: typed.type, size: typed.size });
          }
          o.media.push({ id: uid(), mediaId, label: a.name || it.name, trigger: 'manual', broadcast: true, once: false });
        }
        m.objects.push(o);
        nInt++;
      }
    }
    return m;
  });

  const ground = maps.find((m) => m.floor === 1) ?? maps[0];
  const world: World = {
    version: 1,
    name: '牛津四角楼（从 Rabbithole 导入）',
    terrains: [...structuredClone(DEFAULT_TERRAINS), ...EXTRA_TERRAINS],
    maps,
    connections: [],
    party: [],
    flows: [{ id: uid(), name: '主线', mapId: ground.id, edges: [], nodes: [{ id: uid(), title: '开场', x: 40, y: 40, kind: 'start', effect: null, origin: 'predicted', status: 'predicted' }] }],
    log: [],
    media,
    session: 1,
    playerMapId: ground.id,
    visionMode: 'shared',
    marks: [],
  };
  const nRooms = maps.reduce((s, m) => s + m.rooms.length, 0);
  const summary = `导入了 ${maps.length} 层（${W}×${H} 格）、${nRooms} 个房间、${nObj} 件家具、${nInt} 个可交互物、${media.length} 张配图。楼梯之间的连接点要手动加。`;
  return { world, blobs, summary };
}
