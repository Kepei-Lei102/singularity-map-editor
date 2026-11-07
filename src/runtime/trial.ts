import { clearTrialWindows, openPlayerWindow, selectTrialViewer } from './sync';
import { playerObject } from '../scene/identity';
import { effectiveLayer } from '../scene/vision';
import { objectEnabled } from '../core/objectData.js';
import { beginSandbox, endSandbox, getUI, getWorld, setUI, toast, update, type UIState } from '../core/store';
import { addMark, autoReveal, cancelPendingPlay, checkEnterTriggers, findMap, ioBusy } from './actions';
import type { Facing, GameMap, MapObject, World } from '../core/types';
import { gridDist, uid } from '../core/util';
import { blocksMovement, ROUND_MINUTES } from '../scene/perception';
import { characterPathClear, furnitureSweepBlocked, nextTokenStep, setTokenPosition, tokenPosition } from '../scene/architecture';
import { terrainBlocksPoint, terrainBlocksRect } from '../scene/terrain';
import { slidingPuzzleForObject } from '../scene/sliding';
import { viewerOf, visiblePoint } from '../scene/sight';
import { ATTACK_RANGE, attackTargets, describeAttack, hpOf, rollAttack, type AttackTarget, type Roller } from '../rules/combat';

// 试玩：放白板玩家进去，用 WASD 走，体验视野。退出时一切恢复原样（沙盒）。
// 默认是非战斗：不限步数；打开"战斗模式"才是每回合 5 格。

export const MOVE_PER_TURN = 5;
/** 缠斗：身边这一格内有别人，转身就受限（这回合只能转一次）。 */
export const ENGAGED_RANGE = 1;

/** 方向键对应的 4 向。 */
export function dirOf(dx: number, dy: number): Facing {
  if (dy < 0) return '北';
  if (dy > 0) return '南';
  if (dx > 0) return '东';
  return '西';
}

/** 有没有人被缠住：紧邻一格内有别的棋子。 */
export function isEngaged(m: GameMap, tok: { id: string; x: number; y: number }): boolean {
  return m.tokens.some((k) => k.id !== tok.id && gridDist(k.x - tok.x, k.y - tok.y) <= ENGAGED_RANGE);
}
const COLORS = ['#f4f1ea', '#ffd166', '#81e2ff', '#ff9fb2'];

export type Trial = NonNullable<UIState['trial']>;

const insideRect = (o: { x: number; y: number; w: number; h: number }, x: number, y: number) =>
  x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h;

/** 可推物件往这个方向挪一格行不行：每一格都要是能站的地形，没有别的挡路物件，也没有人。 */
function canPush(w: World, m: GameMap, shelf: MapObject, dx: number, dy: number) {
  if (!objectEnabled(m, shelf)) return false;
  const sx = shelf.x + dx, sy = shelf.y + dy;
  if (furnitureSweepBlocked(m, shelf, sx, sy)) return false;
  if (sx < 0 || sy < 0 || sx + shelf.w > m.width || sy + shelf.h > m.height) return false;
  const a = shelf.anchor ?? { x: 0, y: 0 };
  if (terrainBlocksRect(w, m, { x: sx + a.x / 3, y: sy + a.y / 3, w: shelf.w, h: shelf.h })) return false;
  for (let y = sy; y < sy + shelf.h; y++)
    for (let x = sx; x < sx + shelf.w; x++) {
      if (m.objects.some((o) => o !== shelf && o.kind === 'object' && objectEnabled(m, o) && blocksMovement(o) && insideRect(o, x, y))) return false;
      if (m.tokens.some((k) => k.x === x && k.y === y)) return false;
    }
  return true;
}

/** 沉重物件要两个人：另一个棋子得贴着这件东西（上下左右斜角都算），不是只贴着推的人。 */
function hasHelper(m: GameMap, shelf: MapObject, pusherId: string) {
  return m.tokens.some((k) => k.id !== pusherId &&
    k.x >= shelf.x - 1 && k.x <= shelf.x + shelf.w && k.y >= shelf.y - 1 && k.y <= shelf.y + shelf.h);
}

function walkable(w: World, m: GameMap, x: number, y: number) {
  if (x < 0 || y < 0 || x >= m.width || y >= m.height) return false;
  if (terrainBlocksPoint(w, m, x + 0.5, y + 0.5)) return false; // 空白格（地图外）也不能走
  if (!characterPathClear(w, { ...m, tokens: [] }, { x: x + 0.5, y: y + 0.5 }, { x: x + 0.5, y: y + 0.5 })) return false;
  return !m.objects.some((o) => o.kind === 'object' && objectEnabled(m, o) && blocksMovement(o) && x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h);
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
  setUI({ trial: { mapId, players: [], current: 0, combat: false, moved: {}, turned: {}, turn: 1, msg: '', markSymbol: '!', markText: '', markMode: false }, selection: null, pendingConn: null });
  const p = placePlayer(mapId);
  if (!p) return endTrial();
  setTr({ players: [p] });
  openPlayerWindow(p.pcId, true);
}

export function addTrialPlayer() {
  const t = tr();
  if (!t) return;
  const p = placePlayer(t.mapId);
  if (p) { setTr({ players: [...t.players, p], current: t.players.length, msg: '' }); selectTrialViewer(p.pcId); }
}

export function switchTrialPlayer(i?: number) {
  const t = tr();
  if (!t || !t.players.length) return;
  const current = i ?? (t.current + 1) % t.players.length;
  setTr({ current, msg: '' });
  selectTrialViewer(t.players[current].pcId);
}

export function endTrial() {
  clearTrialWindows();
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
  // 朝向：战斗中第一次按方向＝原地转身，再按同方向才走（回合制下等于一次确认）。
  // 自由行动不确认，朝向跟着走；转身不占行动点；被缠斗时一回合只能转一次。
  const dir = dirOf(dx, dy);
  if (t.combat && tok.facing !== dir) {
    if (t.combat && isEngaged(m, tok) && t.turned?.[pl.tokenId]) return setTr({ msg: '被缠斗住了：这回合只能转一次身' });
    update((d) => {
      const dt = findMap(d, t.mapId)!.tokens.find((x) => x.id === pl.tokenId)!;
      dt.facing = dir;
    });
    setTr({ msg: `转向${dir}`, turned: t.combat ? { ...(t.turned ?? {}), [pl.tokenId]: true } : t.turned });
    return;
  }
  const used = t.moved[pl.tokenId] ?? 0;
  const step = nextTokenStep(m, tok, dx, dy);
  if (t.combat && used + step.cost > MOVE_PER_TURN * 3) return setTr({ msg: '这回合的移动力用完了，按空格结束回合' });
  const nx = Math.floor(step.b.x), ny = Math.floor(step.b.y);
  // 棋盘块由检查器抽象操控，不能用普通推箱绕过边界、碰撞和门状态规则。
  const puzzleBlock = m.objects.find((o) => objectEnabled(m, o) && slidingPuzzleForObject(m, o.id) && insideRect(o, nx, ny));
  if (puzzleBlock) return setTr({ msg: `${playerObject(puzzleBlock, pl.pcId).name}是滑块，请拖动当前看得见的家具，或使用检查器的方向按钮` });
  // 前面是可推的书架／推车：先把它推一格，再走进去。推不动就停下，不悄悄挪半格。
  const shelf = m.objects.find((o) => o.kind === 'object' && objectEnabled(m, o) && blocksMovement(o) && insideRect(o, nx, ny));
  if (shelf) {
    if (step.cost !== 3) return setTr({ msg: '推家具需要回到主格中心，整格推动' });
    if (!shelf.pushable) return setTr({ msg: '走不过去' });
    if (shelf.heavy && !hasHelper(m, shelf, pl.tokenId)) return setTr({ msg: `${playerObject(shelf, pl.pcId).name}太沉，要两个人一起推` });
    if (!canPush(w, m, shelf, dx, dy)) return setTr({ msg: `${playerObject(shelf, pl.pcId).name}推不动` });
    const projected = { ...m, objects: m.objects.map(o => o.id === shelf.id ? { ...o, x: o.x + dx, y: o.y + dy } : o) };
    if (!characterPathClear(w, projected, step.a, step.b, tok.id)) return setTr({ msg: '人物路径被墙或其它人挡住' });
    update((d) => {
      const o = findMap(d, t.mapId)!.objects.find((x) => x.id === shelf.id)!;
      o.x += dx; o.y += dy;
    });
  }
  const now = getWorld(), m2 = findMap(now, t.mapId);
  if (!m2) return setTr({ msg: '走不过去' });
  if (!characterPathClear(now, m2, step.a, step.b, tok.id)) return setTr({ msg: '人物或墙体挡住了路径' });
  update((d) => {
    const dt = findMap(d, t.mapId)!.tokens.find((x) => x.id === pl.tokenId)!;
    setTokenPosition(findMap(d, t.mapId)!, dt, step.b);
    dt.facing = dir; // 自由行动：朝向跟着移动；战斗中这时朝向已经等于 dir
  });
  setTr({ moved: { ...t.moved, [pl.tokenId]: used + step.cost }, msg: '' });
  checkEnterTriggers(t.mapId, pl.tokenId, step.a.x, step.a.y); // 和正式带团一样：走进触发区就播，范围里的线索自动浮现（试玩结束都会复原）
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
  setTr({ moved: {}, turned: {}, turn: t.turn + 1, acted: false, msg: '' });
}

/** 这一回合还有几点行动点：每回合 1 点，攻击/主动技能花掉就算用完。 */
export const actionsLeft = (t: Trial | null | undefined): number => {
  if (!t?.combat) return 1;
  return t.acted ? 0 : 1;
};

/** 攻击当前目标：D100，只有大失败才落空，00 = 特大成功伤害 ×4；伤害默认 1D8。 */
export function trialAttack(targetTokenId: string, opts: { roll?: number; roller?: Roller } = {}): string | null {
  const t = tr();
  const pl = t?.players[t.current];
  if (!t || !pl) return '没有正在试玩的角色';
  if (!t.combat) return '先打开战斗模式再攻击';
  if (t.acted) return '这回合的行动点已经用掉了，按空格结束回合';
  const w = getWorld();
  const m = findMap(w, t.mapId);
  const attacker = m?.tokens.find((x) => x.id === pl.tokenId);
  const target = m?.tokens.find((x) => x.id === targetTokenId);
  if (!m || !attacker || !target) return '找不到攻击者或目标';
  if (attacker.id === target.id) return '不能打自己';
  const dist = Math.abs(attacker.x - target.x) + Math.abs(attacker.y - target.y);
  if (dist > ATTACK_RANGE) return `超出攻击距离（${dist} 格 > ${ATTACK_RANGE}）`;
  const pc = w.party.find((p) => p.id === pl.pcId);
  const eye = viewerOf(attacker, { sex: pc?.sex, heightCm: pc?.heightCm });
  if (!visiblePoint(w, m, eye, tokenPosition(target))) return '看不见目标，不能攻击';
  // 骰点默认现掷；测试可以注入 roll（D100 点数）和 roller（伤害骰）。
  const roll = opts.roll ?? 1 + Math.floor(Math.random() * 100);
  const r = rollAttack(roll, 8, opts.roller);
  const notes: string[] = [describeAttack(pl.name, target.name, r)];
  update((d) => {
    const dm = findMap(d, t.mapId)!;
    const dt = dm.tokens.find((x) => x.id === targetTokenId)!;
    if (dt.pcId) {
      const p = d.party.find((x) => x.id === dt.pcId)!;
      const { hp, max } = hpOf(p);
      const next = Math.max(0, hp - r.damage);
      p.hp = next;
      p.hpMax ??= max;
      notes.push(`${dt.name} HP ${hp}→${next}/${max}`);
      if (next <= 0 && dt.status?.label !== '濒死') { dt.status = { label: '濒死', roundsLeft: 3 }; notes.push(`${dt.name} 濒死`); }
    } else notes.push(`${dt.name} 是 NPC，HP 不设上限，伤害记在裁定里`);
  });
  setTr({ acted: true, msg: notes.join('；') });
  return null;
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
  setTr({ combat: toCombat, moved: {}, acted: false, turn: 1, msg: '' });
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

/** 这个状态还剩多久：分秒、回合或持续至手动解除；已经结束返回 null。 */
export function statusLeft(st: { endsAt?: number; roundsLeft?: number }) {
  if (st.roundsLeft !== undefined) return st.roundsLeft > 0 ? `还剩 ${st.roundsLeft} 回合` : null;
  if (st.endsAt === undefined) return '持续至手动解除';
  const ms = st.endsAt - Date.now();
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
  const i = t.players.findIndex((p) => m?.tokens.some((k) => k.id === p.tokenId && Math.floor(tokenPosition(k).x) === x && Math.floor(tokenPosition(k).y) === y));
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
  const fog = effectiveLayer(w, m, pl.pcId).fog;
  if (!fog?.[y * m.width + x]) return setTr({ msg: '没去过的地方标不了' });
  addMark(t.mapId, pl.pcId, x, y, t.markSymbol, t.markText.trim());
  setTr({ msg: '' });
}

/** 战斗面板：当前角色看得见、能打的棋子。 */
export function trialAttackTargets(): AttackTarget[] {
  const t = tr();
  const pl = t?.players[t.current];
  if (!t || !pl) return [];
  const w = getWorld();
  const m = findMap(w, t.mapId);
  const attacker = m?.tokens.find((x) => x.id === pl.tokenId);
  if (!m || !attacker) return [];
  const pc = w.party.find((p) => p.id === pl.pcId);
  const eye = viewerOf(attacker, { sex: pc?.sex, heightCm: pc?.heightCm });
  return attackTargets(w, m, attacker, (k) => visiblePoint(w, m, eye, tokenPosition(k)));
}
