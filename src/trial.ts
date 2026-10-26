import { beginSandbox, endSandbox, getUI, getWorld, setUI, toast, update, type UIState } from './store';
import { addMark, autoReveal, cancelPendingPlay, checkEnterTriggers, findMap, ioBusy } from './actions';
import type { GameMap, MapObject, World } from './types';
import { uid } from './util';
import { blocksMovement, ROUND_MINUTES } from './perception';

// 试玩：放白板玩家进去，用 WASD 走，体验视野。退出时一切恢复原样（沙盒）。
// 默认是非战斗：不限步数；打开"战斗模式"才是每回合 5 格。

export const MOVE_PER_TURN = 5;
const COLORS = ['#f4f1ea', '#ffd166', '#81e2ff', '#ff9fb2'];

export type Trial = NonNullable<UIState['trial']>;

const insideRect = (o: { x: number; y: number; w: number; h: number }, x: number, y: number) =>
  x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h;

/** 可推物件往这个方向挪一格行不行：每一格都要是能站的地形，没有别的挡路物件，也没有人。 */
function canPush(w: World, m: GameMap, shelf: MapObject, dx: number, dy: number) {
  const sx = shelf.x + dx, sy = shelf.y + dy;
  if (sx < 0 || sy < 0 || sx + shelf.w > m.width || sy + shelf.h > m.height) return false;
  for (let y = sy; y < sy + shelf.h; y++)
    for (let x = sx; x < sx + shelf.w; x++) {
      const t = w.terrains.find((t) => t.id === m.cells[y * m.width + x]);
      if (!t || t.blocksMove) return false;
      if (m.objects.some((o) => o !== shelf && o.kind === 'object' && blocksMovement(o) && insideRect(o, x, y))) return false;
      if (m.tokens.some((k) => k.x === x && k.y === y)) return false;
    }
  return true;
}

function walkable(w: World, m: GameMap, x: number, y: number) {
  if (x < 0 || y < 0 || x >= m.width || y >= m.height) return false;
  const t = w.terrains.find((t) => t.id === m.cells[y * m.width + x]);
  if (!t || t.blocksMove) return false; // 空白格（地图外）也不能走
  return !m.objects.some((o) => o.kind === 'object' && blocksMovement(o) && x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h);
}

/** 出生点：作者设的；没设就是最靠北、最居中的那扇门外面（大家从北边进来）。 */
function spawnPoint(w: World, m: GameMap) {
  if (m.spawn && walkable(w, m, m.spawn.x, m.spawn.y)) return m.spawn;
  const door = w.terrains.find((t) => t.id === 'door' || t.name === '门');
  const cands: { x: number; y: number }[] = [];
  if (door)
    for (let y = 0; y < m.height; y++)
      for (let x = 0; x < m.width; x++) {
        if (m.cells[y * m.width + x] !== door.id) continue;
        for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
          const nx = x + dx, ny = y + dy;
          if (walkable(w, m, nx, ny) && !m.roomCells[ny * m.width + nx]) cands.push({ x: nx, y: ny });
        }
      }
  if (cands.length) return cands.sort((a, b) => a.y - b.y || Math.abs(a.x - m.width / 2) - Math.abs(b.x - m.width / 2))[0];
  for (let y = 0; y < m.height; y++)
    for (let x = 0; x < m.width; x++) if (walkable(w, m, x, y)) return { x, y };
  return null;
}

/** 离 p 最近、能站、没人占的格子（再放一个玩家时用）。 */
function freeNear(w: World, m: GameMap, p: { x: number; y: number }) {
  const seen = new Set<string>();
  const q = [p];
  while (q.length) {
    const c = q.shift()!;
    const k = `${c.x},${c.y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (walkable(w, m, c.x, c.y) && !m.tokens.some((t) => t.x === c.x && t.y === c.y)) return c;
    if (seen.size > 400) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) q.push({ x: c.x + dx, y: c.y + dy });
  }
  return null;
}

const tr = () => getUI().trial;
const setTr = (patch: Partial<Trial>) => { const t = tr(); if (t) setUI({ trial: { ...t, ...patch } }); };

function placePlayer(mapId: string) {
  const w = getWorld();
  const m = findMap(w, mapId)!;
  const base = spawnPoint(w, m);
  const p = base && freeNear(w, m, base);
  if (!p) { toast('这张图上找不到能站的地方（要先铺地形）'); return null; }
  const n = (tr()?.players.length ?? 0) + 1;
  const pcId = uid(), tokenId = uid(), name = `白板玩家${n > 1 ? ' ' + n : ''}`, color = COLORS[(n - 1) % COLORS.length];
  update((d) => {
    d.party.push({ id: pcId, name, tags: [], color });
    const dm = findMap(d, mapId)!;
    dm.autoFog = true;
    dm.tokens.push({ id: tokenId, pcId, name, color, x: p.x, y: p.y });
  });
  return { tokenId, pcId, name };
}

let playingBefore: UIState['nowPlaying'] = null;

export function startTrial() {
  const io = ioBusy();
  if (io) return toast(`正在${io}，完成后再开始试玩`); // 导入途中进试玩，导入的结果会被试玩结束时的还原冲掉
  const mapId = getUI().mapId;
  if (!findMap(getWorld(), mapId)) return;
  beginSandbox();
  cancelPendingPlay();
  playingBefore = getUI().nowPlaying;
  setUI({ trial: { mapId, players: [], current: 0, combat: false, moved: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false }, selection: null, pendingConn: null });
  const p = placePlayer(mapId);
  if (!p) return endTrial();
  setTr({ players: [p] });
}

export function addTrialPlayer() {
  const t = tr();
  if (!t) return;
  const p = placePlayer(t.mapId);
  if (p) setTr({ players: [...t.players, p], current: t.players.length, msg: '' });
}

export function switchTrialPlayer(i?: number) {
  const t = tr();
  if (!t || !t.players.length) return;
  setTr({ current: i ?? (t.current + 1) % t.players.length, msg: '' });
}

export function endTrial() {
  cancelPendingPlay();
  endSandbox();
  // 试玩里触发的播放只在主持人这边（没发给玩家），结束时换回试玩前在放的那个
  setUI({ trial: null, selection: null, nowPlaying: playingBefore });
  playingBefore = null;
}

export function trialMove(dx: number, dy: number) {
  const t = tr();
  const pl = t?.players[t.current];
  if (!t || !pl) return;
  const w = getWorld();
  const m = findMap(w, t.mapId);
  const tok = m?.tokens.find((x) => x.id === pl.tokenId);
  if (!m || !tok) return;
  if (tok.status) {
    if (tok.status.endsAt !== undefined && tok.status.endsAt <= Date.now()) clearTrialStatus(tok.id);
    else return setTr({ msg: `${pl.name}${tok.status.label}中，暂时不能行动` });
  }
  const used = t.moved[pl.tokenId] ?? 0;
  if (t.combat && used >= MOVE_PER_TURN) return setTr({ msg: '这回合的移动力用完了，按空格结束回合' });
  const nx = tok.x + dx, ny = tok.y + dy;
  // 前面是可推的书架／推车：先把它推一格，再走进去。推不动就停下，不悄悄挪半格。
  const shelf = m.objects.find((o) => o.kind === 'object' && blocksMovement(o) && insideRect(o, nx, ny));
  if (shelf) {
    if (!shelf.pushable) return setTr({ msg: '走不过去' });
    if (!canPush(w, m, shelf, dx, dy)) return setTr({ msg: `${shelf.name}推不动` });
    update((d) => {
      const o = findMap(d, t.mapId)!.objects.find((x) => x.id === shelf.id)!;
      o.x += dx; o.y += dy;
    });
  }
  const now = getWorld(), m2 = findMap(now, t.mapId);
  if (!m2 || !walkable(now, m2, nx, ny)) return setTr({ msg: '走不过去' });
  if (m2.tokens.some((x) => x.x === nx && x.y === ny)) return setTr({ msg: '有人挡着' });
  update((d) => {
    const dt = findMap(d, t.mapId)!.tokens.find((x) => x.id === pl.tokenId)!;
    dt.x = nx; dt.y = ny;
  });
  setTr({ moved: { ...t.moved, [pl.tokenId]: used + 1 }, msg: '' });
  checkEnterTriggers(t.mapId, pl.tokenId, tok.x, tok.y); // 和正式带团一样：走进触发区就播，范围里的线索自动浮现（试玩结束都会复原）
  autoReveal(t.mapId);
}

/** 空格（只在战斗中）：结束这一回合。重置每人的移动力；"暂时不能行动"的回合数减一，减到 0 就恢复。 */
export function trialEndTurn() {
  const t = tr();
  if (!t?.combat) return;
  update((d) => {
    const m = findMap(d, t.mapId);
    for (const k of m?.tokens ?? []) {
      if (k.status?.roundsLeft === undefined) continue;
      k.status.roundsLeft -= 1;
      if (k.status.roundsLeft <= 0) delete k.status;
    }
  });
  setTr({ moved: {}, turn: t.turn + 1, msg: '' });
}

/** 进出战斗：暂时不能行动的状态在"真实时间"和"回合"之间换算（1 回合 = 5 分钟）。 */
export function toggleCombat() {
  const t = tr();
  if (!t) return;
  const toCombat = !t.combat, now = Date.now();
  update((d) => {
    for (const k of findMap(d, t.mapId)?.tokens ?? []) {
      const st = k.status;
      if (!st) continue;
      if (toCombat && st.endsAt !== undefined) { st.roundsLeft = Math.max(1, Math.ceil((st.endsAt - now) / 60000 / ROUND_MINUTES)); delete st.endsAt; }
      if (!toCombat && st.roundsLeft !== undefined) { st.endsAt = now + st.roundsLeft * ROUND_MINUTES * 60000; delete st.roundsLeft; }
    }
  });
  setTr({ combat: toCombat, moved: {}, turn: 1, msg: '' });
}

/** 让当前角色暂时不能行动（晕厥、泡温泉……），时长按分钟给；战斗中自动换算成回合。 */
export function setTrialStatus(label: string, minutes: number) {
  const t = tr();
  const pl = t?.players[t.current];
  if (!t || !pl) return;
  update((d) => {
    const k = findMap(d, t.mapId)?.tokens.find((x) => x.id === pl.tokenId);
    if (!k) return;
    k.status = t.combat
      ? { label, roundsLeft: Math.max(1, Math.ceil(minutes / ROUND_MINUTES)) }
      : { label, endsAt: Date.now() + minutes * 60000 };
  });
}

export function clearTrialStatus(tokenId: string) {
  const t = tr();
  if (t) update((d) => { const k = findMap(d, t.mapId)?.tokens.find((x) => x.id === tokenId); if (k) delete k.status; });
}

/** 这个状态还剩多久：自由行动显示分秒，战斗显示回合；已经结束返回 null。 */
export function statusLeft(st: { endsAt?: number; roundsLeft?: number }) {
  if (st.roundsLeft !== undefined) return st.roundsLeft > 0 ? `还剩 ${st.roundsLeft} 回合` : null;
  const ms = (st.endsAt ?? 0) - Date.now();
  if (ms <= 0) return null;
  const sec = Math.ceil(ms / 1000);
  return `还剩 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export function toggleMarkMode(on?: boolean) {
  const t = tr();
  if (t) setTr({ markMode: on ?? !t.markMode, msg: '' });
}

/** 试玩时点地图：放标记状态下放标记；否则点到自己队里的人就切换操控他。 */
export function trialClick(x: number, y: number) {
  const t = tr();
  if (!t) return;
  if (t.markMode) { trialPlaceMark(x, y); setTr({ markMode: false }); return; }
  const m = findMap(getWorld(), t.mapId);
  const i = t.players.findIndex((p) => m?.tokens.some((k) => k.id === p.tokenId && k.x === x && k.y === y));
  if (i >= 0) switchTrialPlayer(i);
}

/** 在地图上做标记：只能标自己知道的地方（看得见的或记得的）。 */
export function trialPlaceMark(x: number, y: number) {
  const t = tr();
  const pl = t?.players[t.current];
  if (!t || !pl) return;
  const w = getWorld();
  const m = findMap(w, t.mapId);
  if (!m || x < 0 || y < 0 || x >= m.width || y >= m.height) return;
  const fog = w.visionMode === 'individual' ? m.views[pl.pcId]?.fog : m.fog;
  if (!fog?.[y * m.width + x]) return setTr({ msg: '没去过的地方标不了' });
  addMark(t.mapId, pl.pcId, x, y, t.markSymbol, t.markText.trim());
  setTr({ msg: '' });
}
