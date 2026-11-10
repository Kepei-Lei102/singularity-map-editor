import { clearTrialWindows, openPlayerWindow, pushJudgmentRequest, registerTrialMove, selectTrialViewer } from './sync';
import { playerObject } from '../scene/identity';
import { effectiveLayer } from '../scene/vision';
import { objectEnabled } from '../core/objectData.js';
import { beginSandbox, endSandbox, getUI, getWorld, setUI, toast, update, type UIState } from '../core/store';
import { addMark, autoReveal, cancelPendingPlay, checkEnterTriggers, findMap, ioBusy } from './actions';
import type { Facing, GameMap, JumpRequest, MapObject, Stance, World } from '../core/types';
import { gridDist, uid } from '../core/util';
import { blocksMovement, ROUND_MINUTES } from '../scene/perception';
import { characterPathClear, furnitureSweepBlocked, nextTokenStep, setTokenPosition, tokenPosition } from '../scene/architecture';
import { terrainBlocksPoint, terrainBlocksRect } from '../scene/terrain';
import { slidingPuzzleForObject } from '../scene/sliding';
import { viewerOf, visiblePoint } from '../scene/sight';
import { describeSense, rollSense, senseHints, type SenseKind } from '../rules/sense';
import {
  describeInjury, describePitFall, describeStepDrop, gapAhead, INJURY_DICE, INJURY_LABEL, injuryTier,
  judgeValue, jumpSkillsOf, pitFall, planJump, rollInjury, rollPitFall, stepDrop,
  type JumpCheck, type JumpRoll,
} from '../rules/jump';
import { openJudgment } from '../rules/judgments';
import { CELL_METERS, heightAt } from '../scene/height';
import { cellFloor, hasPitBottom } from '../scene/terrain';
import { canAffordStep, canTurn, chargeUsedThisTurn, moveBudgetOn, movePool, RUN_MODES, runMeShort, spendCharge, stepPrice, tickCharge, STAND_UP_COST, ROLL_OVER_COST, type ChargeState, type RunMode } from '../rules/move';
import { ATTACK_RANGE, DYING_LABEL, DYING_ROUNDS, ENGAGE_RANGE, RESCUED_HP, ROBOT_LABEL, attackTargets, canRescue, canUseSharp, downedBy, downedLabel, hpOf, opportunityTriggers, robotArrived, robotIncoming, rollAttack, rollRescue, settleDeath, stepLimitNear, type AttackTarget, type Downed, type Roller } from '../rules/combat';

// 试玩：放白板玩家进去，用 WASD 走，体验视野。退出时一切恢复原样（沙盒）。
// 默认是非战斗：不限步数；打开"战斗模式"才是每回合 5 格。

export const MOVE_PER_TURN = 5;
/** 小数格坐标 → 落在哪一格。 */
const landingOf = (p: { x: number; y: number }) => ({ x: Math.floor(p.x), y: Math.floor(p.y) });
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

// 玩家窗口按方向键时，sync 回调到这里执行。两边互相 import，用注册避开直接依赖。
registerTrialMove((dx, dy) => { trialMove(dx, dy); });

export function addTrialPlayer() {
  const t = tr();
  if (!t) return;
  const p = placePlayer(t.mapId);
  if (p) { setTr({ players: [...t.players, p], current: t.players.length, msg: '' }); selectTrialViewer(p.pcId); }
}

/** 暂停/放开某个玩家的操作。见证者怕一个人把全场的骰子都掷了。 */
export function toggleTrialPause(i: number) {
  const t = tr();
  if (!t || !t.players[i]) return;
  const players = t.players.map((p, j) => j === i ? { ...p, paused: !p.paused } : p);
  setTr({ players, msg: '' });
}

export function switchTrialPlayer(i?: number) {
  const t = tr();
  if (!t || !t.players.length) return;
  const current = i ?? (t.current + 1) % t.players.length;
  setTr({ current, msg: '' });
  refreshOpportunity(t.players[current].tokenId);
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

/** 躺下的人干不了什么，得先花行动点翻身或者站起来。 */
function lyingMsg(tok: { stance?: string; name: string }): string | null {
  return tok.stance === '躺' ? `${tok.name}躺着，先翻身或站起来（要花行动点）` : null;
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
  const lying = lyingMsg(tok);
  if (lying) return setTr({ msg: lying });
  // 朝向：战斗中第一次按方向＝原地转身，再按同方向才走（回合制下等于一次确认）。
  // 自由行动不确认，朝向跟着走；转身不占行动点；被缠斗时一回合只能转一次。
  const dir = dirOf(dx, dy);
  const runSpec = t.runMode ? RUN_MODES[t.runMode] : null;
  if (t.combat && tok.facing !== dir) {
    if (t.combat && isEngaged(m, tok) && t.turned?.[pl.tokenId]) return setTr({ msg: '被缠斗住了：这回合只能转一次身' });
    // 跑起来拐弯有限：奔跑整回合只能拐一次，爆跑一次都不准。
    if (runSpec && !canTurn(runSpec, t.runTurns ?? 0)) {
      return setTr({ msg: runSpec.turns === 0 ? `【${runSpec.label}】不能拐弯，往${dir}得先停下来` : `【${runSpec.label}】这一回合已经拐过弯了` });
    }
    update((d) => {
      const dt = findMap(d, t.mapId)!.tokens.find((x) => x.id === pl.tokenId)!;
      dt.facing = dir;
    });
    setTr({
      msg: `转向${dir}`,
      turned: t.combat ? { ...(t.turned ?? {}), [pl.tokenId]: true } : t.turned,
      runTurns: runSpec ? (t.runTurns ?? 0) + 1 : t.runTurns,
    });
    return;
  }
  const used = t.moved[pl.tokenId] ?? 0;
  const step = nextTokenStep(m, tok, dx, dy);
  // 移动力按角色属性算：梦境层用心理移动，其它层用物理移动。
  const mover = w.party.find((p) => p.id === pl.pcId);
  const budget = mover ? moveBudgetOn(mover, m.layer) : null;
  const stored = t.charge?.[pl.tokenId]?.cells ?? 0;
  const prone = tok.stance === '趴';
  // 战斗模式才花移动点数；自由行动不限步数。
  // 这一回合的点池在回合开始时建好，这里只查够不够、走完扣掉。
  const price = stepPrice(t.runMode ?? null, prone);
  if (t.combat) {
    const left = t.movePoints?.[pl.tokenId] ?? movePool(budget, stored);
    if (!canAffordStep(left, price)) return setTr({ msg: '这回合的移动点数用完了，按空格结束回合' });
  }
  // 贴身缠斗：在敌人周围 2 格内，一次移动只能挪 1 格。
  if (t.combat && stepLimitNear(landingOf(step.a), m.tokens.filter((k) => k.id !== tok.id)) === 1 && step.cost > 3)
    return setTr({ msg: '贴身缠斗：一次只能挪 1 格' });
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
  // 战斗模式：玩家可以互相路过，但不能停在同一个格子上。
  const landing = { x: Math.floor(step.b.x), y: Math.floor(step.b.y) };
  const occupied = t.combat && m2.tokens.find((k) => k.id !== tok.id && Math.floor(tokenPosition(k).x) === landing.x && Math.floor(tokenPosition(k).y) === landing.y);
  if (occupied) return setTr({ msg: `${occupied.name} 在这里，不能停在同一个格子上` });
  // 前面是坑？不是走着能过去的。第一下给提示并记住方向，第二下同方向才真的起跳——
  // 跳跃不能误触，掉下去是要扣血的。
  const from = { x: Math.floor(step.a.x), y: Math.floor(step.a.y) };
  const skills = jumpSkillsOf(w.party.find((p) => p.id === pl.pcId)?.skills ?? []);
  // 坑要分两种：有坑底的（沟、浅坑）人掉下去是站在坑底的，站在坑里时这格就能走；
  // 没坑底的天井永远是坑。
  const here = heightAt(m2, from.x, from.y);
  const floorAt = (x: number, y: number) => {
    const f = cellFloor(now, m2, x, y);
    if (f !== 'gap') return f;
    return hasPitBottom(now, m2, x, y) && heightAt(m2, x, y) >= here ? 'open' : 'gap';
  };
  const ahead = gapAhead(floorAt, from, dx, dy, skills);
  if (ahead.kind === 'gap') {
    if (!ahead.landing) return setTr({ msg: ahead.reason });
    const armed = getUI().pendingGap;
    const confirmed = !!armed && armed.tokenId === tok.id && armed.dx === dx && armed.dy === dy;
    if (!confirmed) {
      setUI({ pendingGap: { tokenId: tok.id, dx, dy } });
      const m = (ahead.width * CELL_METERS).toFixed(2);
      const need = ahead.check
        ? `跳过去要过【${ahead.check.attr}】（${ahead.check.why}）`
        : '一格宽的坑，直接跳过去，不用掷骰';
      return setTr({ msg: `前面是坑（宽 ${ahead.width} 格，${m} 米）。${need}。再按一次同方向才起跳` });
    }
    setUI({ pendingGap: null });
    return beginGapJump(now, m2, tok, from, { width: ahead.width, landingStep: ahead.landingStep, check: ahead.check },
      dx, dy, pl.pcId, price);
  }
  // 人在坑底的时候，坑格的地形不该挡：那格是「能跨过去的不可通行」，
  // 但有底就说明它是能站的地面。起步那格（自己脚下）和落脚那格都要放行。
  const destX = Math.floor(step.b.x), destY = Math.floor(step.b.y);
  const standingInPit = hasPitBottom(now, m2, from.x, from.y) && heightAt(m2, from.x, from.y) === here;
  const intoPitBottom = cellFloor(now, m2, destX, destY) === 'gap'
    && hasPitBottom(now, m2, destX, destY) && heightAt(m2, destX, destY) >= here;
  if (!characterPathClear(now, m2, step.a, step.b, tok.id, { skipTerrain: standingInPit || intoPitBottom })) {
    return setTr({ msg: '人物或墙体挡住了路径' });
  }
  // 落差：上一步台阶能走（双倍点数），再高就得上攀跳/攀爬；往下就是跳，会摔。
  const drop = stepDrop(heightAt(m2, Math.floor(step.a.x), Math.floor(step.a.y)), heightAt(m2, landing.x, landing.y));
  // 上面比自己高 2 格以上：不是走上去的，是攀上去。同方向按第二下才攀。
  if (drop.kind === 'climb') {
    const climber = w.party.find((p) => p.id === pl.pcId);
    const climbPlan = planJump('up', drop.height, jumpSkillsOf(climber?.skills ?? []), drop.height);
    // 根本没资格攀（4 格以上没【攀爬】）：别让他按第二下，直接说明白。
    if (!climbPlan.allowed) return setTr({ msg: climbPlan.reason });
    const armed = getUI().pendingGap;
    const confirmed = !!armed && armed.tokenId === tok.id && armed.dx === dx && armed.dy === dy;
    if (!confirmed) {
      setUI({ pendingGap: { tokenId: tok.id, dx, dy } });
      const need = climbPlan.check
        ? `要过【${climbPlan.check.attr}】`
        : '一格台阶，双倍移动点';
      return setTr({ msg: `${drop.reason}。${need}${climbPlan.usesAction ? '，占行动点' : ''}。再按一次同方向就攀上去` });
    }
    setUI({ pendingGap: null });
    return beginUpClimb(now, m2, tok, landing, drop.height, dx, dy, pl.pcId, price);
  }
  if (drop.kind === 'blocked') return setTr({ msg: drop.reason });
  // 往下 2 格以上不是走着下去的，是跳下去——会摔。同方向按第二下才跳。
  if (drop.kind === 'stepDown' && !drop.safe) {
    const armed = getUI().pendingGap;
    const confirmed = !!armed && armed.tokenId === tok.id && armed.dx === dx && armed.dy === dy;
    if (!confirmed) {
      setUI({ pendingGap: { tokenId: tok.id, dx, dy } });
      return setTr({ msg: `${describeStepDrop(drop)}。再按一次同方向就跳下去` });
    }
    setUI({ pendingGap: null });
    return beginDownJump(now, m2, tok, landing, drop.height, dx, dy, pl.pcId, price);
  }
  const extraPrice = drop.kind === 'stepUp' ? price : 0; // 上台阶再付一份
  if (t.combat && drop.kind !== 'flat') {
    const left = t.movePoints?.[pl.tokenId] ?? movePool(budget, stored);
    if (!canAffordStep(left, price + extraPrice)) return setTr({ msg: `移动点数不够上这步台阶（要 ${Math.round(price + extraPrice)} 点，还剩 ${Math.round(left)}）` });
  }
  // 借机攻击：只认贴身脱离（原本 1–2 格内，这一步往外挪）。弹提示，不自动打。
  const others = m2.tokens.filter((k) => k.id !== tok.id);
  const opp = t.combat ? opportunityTriggers(landingOf(step.a), landingOf(step.b), others) : null;
  update((d) => {
    const dt = findMap(d, t.mapId)!.tokens.find((x) => x.id === pl.tokenId)!;
    setTokenPosition(findMap(d, t.mapId)!, dt, step.b);
    dt.facing = dir; // 自由行动：朝向跟着移动；战斗中这时朝向已经等于 dir
  });
  // 战斗模式才扣移动点数；自由行动不限步数。
  const poolStart = t.movePoints?.[pl.tokenId] ?? movePool(budget, stored);
  const pointsLeft = t.combat
    ? Math.max(0, poolStart - price - extraPrice)
    : t.movePoints?.[pl.tokenId];
  // 蓄的那一格用掉就清零，得重新蓄。
  // 「用掉」= 这回合花掉的点数超过本身移动值——池子里超出的那部分就是蓄来的。
  const chargeUsed = t.combat && chargeUsedThisTurn(budget, pointsLeft ?? 0, stored);
  if (getUI().pendingGap) setUI({ pendingGap: null });
  setTr({
    moved: { ...t.moved, [pl.tokenId]: used + step.cost },
    movePoints: t.combat ? { ...(t.movePoints ?? {}), [pl.tokenId]: pointsLeft! } : t.movePoints,
    ...(chargeUsed ? { charge: { ...(t.charge ?? {}), [pl.tokenId]: spendCharge(t.charge?.[pl.tokenId] ?? { progress: 0, cells: stored }) } } : {}),
    msg: '',
    opportunity: opp?.leaving && opp.enemies.length
      ? { moverTokenId: tok.id, enemies: opp.enemies, from: opp.from, to: opp.to }
      : null,
  });
  checkEnterTriggers(t.mapId, pl.tokenId, step.a.x, step.a.y); // 和正式带团一样：走进触发区就播，范围里的线索自动浮现（试玩结束都会复原）
  autoReveal(t.mapId);
}

/**
 * 试玩里这个角色的六维填了吗。
 * 没填的话区值是 0、门槛是 0，任何属性检定都必败——
 * 掷了也只会得出「不行」，不如直接告诉他去填。
 */
function attributesFilled(pc: World['party'][number] | null | undefined): boolean {
  const a = pc?.attributes;
  return !!a && ['力量', '敏捷', '意志', '观察', '智慧', '魅力'].some((k) => (a[k] ?? 0) > 0);
}

/** 往上攀：爬到上面那格。爬不上去就按已攀的高度摔。 */
function beginUpClimb(
  w: World, m: GameMap, tok: GameMap['tokens'][number], landing: { x: number; y: number },
  climb: number, dx: number, dy: number, pcId: string, unitPrice: number,
) {
  const t = tr();
  if (!t) return;
  const pc = w.party.find((p) => p.id === pcId);
  const skills = jumpSkillsOf(pc?.skills ?? []);
  const plan = planJump('up', climb, skills, climb);
  if (!plan.allowed) return setTr({ msg: plan.reason });
  const req: JumpRequest = {
    tokenId: tok.id, dx, dy, kind: 'up', cells: climb, fall: climb,
    attr: plan.check?.attr ?? null, landing, injury: plan.injury, moveMultiplier: plan.moveMultiplier,
    usesAction: plan.usesAction,
  };
  req.landingStep = 1;
  req.unitPrice = unitPrice;
  if (!plan.check) { settleJump(req, []); return; }
  if (!attributesFilled(pc)) {
    return setTr({ msg: `${tok.name} 还没填六维（右上角角色面板 → 六维与 HP）。没填的话任何检定都是必败，先填上再攀` });
  }
  const tier = plan.injury ?? injuryTier(climb);
  const err = openJudgment({
    title: `往上攀：${climb} 格`,
    ruling: `${tok.name} 爬到上面 ${climb} 格（${(climb * CELL_METERS).toFixed(2)} 米）高处，过【${plan.check.attr}】。`
      + `没攀住就从 ${climb} 格摔下来：${INJURY_LABEL[tier]} 1D${INJURY_DICE[tier]}。`
      + (plan.usesAction ? '这一下占掉行动点。' : ''),
    sides: 100, subjectId: pcId,
    place: { mapId: m.id, x: landing.x + 0.5, y: landing.y + 0.5 },
    jump: req,
  });
  if (err) return setTr({ msg: err });
  pushJudgmentRequest(pcId);
  setTr({ msg: '往上攀的判定已开出。他掷完你点「按结果执行」' });
}

/** 往下跳：落到下面那格，摔不摔看检定。 */
function beginDownJump(
  w: World, m: GameMap, tok: GameMap['tokens'][number], landing: { x: number; y: number },
  fall: number, dx: number, dy: number, pcId: string, unitPrice: number,
) {
  const t = tr();
  if (!t) return;
  const skills = jumpSkillsOf(w.party.find((p) => p.id === pcId)?.skills ?? []);
  const plan = planJump('down', fall, skills, fall);
  const req: JumpRequest = {
    tokenId: tok.id, dx, dy, kind: 'down', cells: fall, fall,
    attr: plan.check?.attr ?? null, landing, injury: plan.injury, moveMultiplier: plan.moveMultiplier,
  };
  req.landingStep = 1;
  req.unitPrice = unitPrice;
  if (!plan.check) { settleJump(req, []); return; }
  const pc = w.party.find((p) => p.id === pcId);
  if (!attributesFilled(pc)) {
    return setTr({ msg: `${tok.name} 还没填六维（右上角角色面板 → 六维与 HP）。没填的话任何检定都是必败，先填上再跳` });
  }
  const tier = plan.injury ?? injuryTier(fall);
  const err = openJudgment({
    title: `跳下去：落差 ${fall} 格`,
    ruling: `${tok.name} 从 ${fall} 格（${(fall * CELL_METERS).toFixed(2)} 米）跳下去，过【${plan.check.attr}】。`
      + `没过就摔：${INJURY_LABEL[tier]} 1D${INJURY_DICE[tier]}。`,
    sides: 100, subjectId: pcId,
    place: { mapId: m.id, x: landing.x + 0.5, y: landing.y + 0.5 },
    jump: req,
  });
  if (err) return setTr({ msg: err });
  pushJudgmentRequest(pcId);
  setTr({ msg: '往下跳的判定已开出。他掷完你点「按结果执行」' });
}

/** 坑深：有坑底按落差算，没坑底（天井）就当掉一层。 */
function pitFallOf(w: World, m: GameMap, from: { x: number; y: number }, dx: number, dy: number): number {
  const x = from.x + dx, y = from.y + dy;
  const bottom = hasPitBottom(w, m, x, y) ? heightAt(m, x, y) : null;
  return pitFall(heightAt(m, from.x, from.y), bottom).cells;
}

/** 玩家按了第二下：算这次跳跃。不用掷就直接过去，要掷就开一个判定等他掷。 */
function beginGapJump(
  w: World, m: GameMap, tok: GameMap['tokens'][number], from: { x: number; y: number },
  ahead: { width: number; landingStep: number; check: JumpCheck | null },
  dx: number, dy: number, pcId: string, unitPrice: number,
) {
  const t = tr();
  if (!t) return;
  const fall = pitFallOf(w, m, from, dx, dy);
  const skills = jumpSkillsOf(w.party.find((p) => p.id === pcId)?.skills ?? []);
  const plan = planJump('across', ahead.width, skills, fall);
  const landing = { x: from.x + dx * ahead.landingStep, y: from.y + dy * ahead.landingStep };
  const req: JumpRequest = {
    tokenId: tok.id, dx, dy, kind: 'across', cells: ahead.width, fall,
    attr: plan.check?.attr ?? null, landing, injury: plan.injury, moveMultiplier: plan.moveMultiplier,
  };
  req.landingStep = ahead.landingStep;
  req.unitPrice = unitPrice;
  if (!plan.check) { settleJump(req, []); return; }
  // 没填六维就别开判定：门槛 0，掷什么都过不了，白掷一次骰子。
  const pc = w.party.find((p) => p.id === pcId);
  if (!attributesFilled(pc)) {
    return setTr({ msg: `${tok.name} 还没填六维（右上角角色面板 → 六维与 HP）。没填的话任何检定都是必败，先填上再跳` });
  }
  const tier = plan.injury ?? injuryTier(fall);
  const err = openJudgment({
    title: `跳跃：坑宽 ${ahead.width} 格`,
    ruling: `${tok.name} 跳过 ${ahead.width} 格宽的坑（${(ahead.width * CELL_METERS).toFixed(2)} 米），过【${plan.check.attr}】。`
      + `没过就摔下去：${INJURY_LABEL[tier]} 1D${INJURY_DICE[tier]}。`,
    sides: 100, subjectId: pcId,
    place: { mapId: m.id, x: from.x + 0.5, y: from.y + 0.5 },
    jump: req,
  });
  if (err) return setTr({ msg: err });
  pushJudgmentRequest(pcId);
  setTr({ msg: '跳跃判定已开出。他掷完你点「按结果执行」' });
}

/** 扣血：扣到 0 就倒下。没有血条（没填六维的白板）就什么也不做。 */
function hurt(mapId: string, tokenId: string, damage: number): void {
  update((d) => {
    const dm = findMap(d, mapId);
    const dt = dm?.tokens.find((x) => x.id === tokenId);
    if (!dm || !dt) return;
    const p = dt.pcId ? d.party.find((x) => x.id === dt.pcId) : null;
    const pool = p ? hpOf(p) : (dt.hpMax ?? 0) > 0 ? { hp: dt.hp ?? dt.hpMax!, max: dt.hpMax! } : null;
    if (!pool) return;
    const next = Math.max(0, pool.hp - damage);
    if (p) { p.hp = next; p.hpMax ??= pool.max; } else { dt.hp = next; }
    if (next <= 0) { dt.down = true; delete dt.status; }
  });
}

/**
 * 按掷出来的点数结算一次跳跃。见证者点「按结果执行」时调它。
 * @param values 玩家掷的点数：单掷一颗，不用掷就传空数组。
 */
export function settleJump(req: JumpRequest, values: number[]): string {
  const t = tr();
  if (!t) return '不在试玩里';
  const w = getWorld();
  const m = findMap(w, t.mapId);
  if (!m) return '找不到地图';
  const tok = m.tokens.find((x) => x.id === req.tokenId);
  if (!tok) return '找不到棋子';
  const pc = tok.pcId ? w.party.find((p) => p.id === tok.pcId) : null;

  let roll: JumpRoll | null = null;
  if (req.attr) {
    const check: JumpCheck = { attr: req.attr, mode: 'single', why: '' };
    roll = judgeValue(check, pc ?? ({ attributes: {} } as never), values);
  }
  const landed = roll === null || roll.success;
  const dir = dirOf(req.dx, req.dy);
  const before = tokenPosition(tok);
  // 跳、攀、跳下去是三个动作，别都叫「跳」。
  const done = { across: '跳过去', up: '攀上去', down: '跳下去' }[req.kind];
  const fail = { across: '没跳过去', up: '没攀上去', down: '没跳下去' }[req.kind];
  const landingStep = req.landingStep ?? Math.abs(req.landing.x - Math.floor(tok.x)) + Math.abs(req.landing.y - Math.floor(tok.y));

  if (landed) {
    update((d) => {
      const dm = findMap(d, t.mapId)!;
      const dt = dm.tokens.find((x) => x.id === req.tokenId)!;
      setTokenPosition(dm, dt, { x: req.landing.x + 0.5, y: req.landing.y + 0.5 });
      dt.facing = dir;
    });
    // 跳过去的那几格照样花移动点（战斗中才扣）。
    if (t.combat) {
      const cost = (req.unitPrice ?? 75) * req.moveMultiplier * landingStep;
      const left = Math.max(0, (t.movePoints?.[req.tokenId] ?? 0) - cost);
      setTr({ movePoints: { ...(t.movePoints ?? {}), [req.tokenId]: left },
        ...(req.usesAction ? { acted: true } : {}),
        msg: `${done}了${roll ? `：${roll.used} / ${roll.target}` : ''}` });
    } else {
      setTr({ ...(req.usesAction ? { acted: true } : {}),
        msg: roll ? `${done}了：${roll.used} / ${roll.target}` : `${done}了` });
    }
    // 跳过去也是走过去了：触发区和自动揭图照常。
    checkEnterTriggers(t.mapId, req.tokenId, before.x, before.y);
    autoReveal(t.mapId);
    return '';
  }

  // 没跳过去：摔。
  if (req.kind === 'across') {
    // 横跨失败＝掉进坑里。坑底有高度就落到坑底；
    // 没建模坑底（坑格高度跟脚下一样）就当掉一层，见证者手动把人挪去下一层。
    const start = { x: Math.floor(before.x), y: Math.floor(before.y) };
    const pit = { x: start.x + req.dx, y: start.y + req.dy };
    const bottom = hasPitBottom(w, m, pit.x, pit.y) ? heightAt(m, pit.x, pit.y) : null;
    const fall = pitFall(heightAt(m, start.x, start.y), bottom);
    const damage = rollPitFall(fall);
    hurt(t.mapId, req.tokenId, damage);
    if (!fall.nextFloor) {
      update((d) => {
        const dm = findMap(d, t.mapId)!;
        const dt = dm.tokens.find((x) => x.id === req.tokenId)!;
        setTokenPosition(dm, dt, { x: pit.x + 0.5, y: pit.y + 0.5 });
        dt.facing = dir;
      });
      checkEnterTriggers(t.mapId, req.tokenId, before.x, before.y);
      autoReveal(t.mapId);
    }
    setTr({ msg: describePitFall(fall, damage) });
    return '';
  }

  // 往上攀失败＝留在原地，按已攀的高度摔；往下跳失败＝人已经在下面了，落点照落，只是带着伤。
  const tier = req.injury ?? injuryTier(req.fall);
  const damage = rollInjury(tier);
  hurt(t.mapId, req.tokenId, damage);
  if (req.kind === 'down') {
    update((d) => {
      const dm = findMap(d, t.mapId)!;
      const dt = dm.tokens.find((x) => x.id === req.tokenId)!;
      setTokenPosition(dm, dt, { x: req.landing.x + 0.5, y: req.landing.y + 0.5 });
      dt.facing = dir;
    });
    checkEnterTriggers(t.mapId, req.tokenId, before.x, before.y);
    autoReveal(t.mapId);
  }
  setTr({ msg: `${fail}，${describeInjury(req.fall, damage)}` });
  return '';
}

/** 空格（只在战斗中）：结束这一回合。重置每人的移动力；"暂时不能行动"的回合数减一，减到 0 就恢复。 */
export function trialEndTurn() {
  const t = tr();
  if (!t?.combat) return;
  // 濒死倒计时走完就是撕卡：卡标已死亡，棋子变尸体留在原地，不删掉。
  const died: string[] = [];
  update((d) => {
    const m = findMap(d, t.mapId);
    for (const k of m?.tokens ?? []) {
      if (k.status?.roundsLeft === undefined) continue;
      k.status.roundsLeft -= 1;
      if (k.status.roundsLeft > 0) continue;
      if (k.status.label === DYING_LABEL && k.pcId) {
        const pc = d.party.find((x) => x.id === k.pcId);
        if (pc) {
          if (settleDeath(pc, { mapId: t.mapId, x: k.x, y: k.y })) died.push(k.name);
          k.corpse = true;
        }
      }
      delete k.status;
    }
  });
  for (const name of died) {
    update((d) => { d.log.push({ id: uid(), at: Date.now(), session: d.session, kind: 'note', text: `${name} 濒死三回合无人救治，撕卡。尸体留在原地。` }); });
  }
  // 自己行动完（结束回合）后，借机攻击重新亮起：每个人新一轮都能再借机一次。
  update((d) => {
    for (const k of findMap(d, t.mapId)?.tokens ?? []) delete k.opportunityUsed;
  });
  // 每回合推进一次蓄力：移动力超出基准 25 点的人每回合攒 1/3 格，超出 38 点攒 1/2 格。
  const charge = (() => {
    const w = getWorld();
    const m = findMap(w, t.mapId);
    if (!m) return t.charge ?? {};
    const next: Record<string, ChargeState> = { ...(t.charge ?? {}) };
    for (const pl of t.players) {
      const pc = w.party.find((p) => p.id === pl.pcId);
      if (!pc) continue;
      next[pl.tokenId] = tickCharge(moveBudgetOn(pc, m.layer), next[pl.tokenId] ?? { progress: 0, cells: 0 });
    }
    return next;
  })();
  // 新回合把移动点数池重置成各角色的移动值（加上蓄好的额外格）。
  const movePoints = (() => {
    const w = getWorld();
    const m = findMap(w, t.mapId);
    if (!m) return t.movePoints ?? {};
    const next: Record<string, number> = {};
    for (const pl of t.players) {
      const pc = w.party.find((p) => p.id === pl.pcId);
      next[pl.tokenId] = movePool(pc ? moveBudgetOn(pc, m.layer) : null, charge[pl.tokenId]?.cells ?? 0);
    }
    return next;
  })();
  setTr({ moved: {}, turned: {}, turn: t.turn + 1, acted: false, opportunity: null, msg: '', charge, movePoints });
}

/** 这一回合还有几点行动点：每回合 1 点，攻击/主动技能花掉就算用完。 */
export const actionsLeft = (t: Trial | null | undefined): number => {
  if (!t?.combat) return 1;
  return t.acted ? 0 : 1;
};

/** 攻击当前目标：D100，只有大失败才落空，00 = 特大成功伤害 ×4；伤害默认 1D8。 */
export function trialAttack(targetTokenId: string, opts: { roll?: number; roller?: Roller; sharp?: boolean } = {}): string | null {
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
  if (attacker.stance === '躺') return `${attacker.name}躺着，打不了。先翻身或站起来`;
  if (target.status?.label === '濒死') return `${target.name} 已经濒死了`;
  const dist = Math.abs(attacker.x - target.x) + Math.abs(attacker.y - target.y);
  if (dist > ATTACK_RANGE) return `超出攻击距离（${dist} 格 > ${ATTACK_RANGE}）`;
  const pc = w.party.find((p) => p.id === pl.pcId);
  // 钝器默认；锐器要攻击者身上带着才行，不带的人勾不了。
  const sharp = !!opts.sharp;
  if (sharp && !canUseSharp(pc)) return `${pl.name} 身上没有锐器，只能用钝器`;
  const eye = viewerOf(attacker, { sex: pc?.sex, heightCm: pc?.heightCm });
  if (!visiblePoint(w, m, eye, tokenPosition(target))) return '看不见目标，不能攻击';
  // 骰点默认现掷；测试可以注入 roll（D100 点数）和 roller（伤害骰）。
  const roll = opts.roll ?? 1 + Math.floor(Math.random() * 100);
  const r = rollAttack(roll, 8, opts.roller);
  // 伤害这种大事单独给一张卡片（event），底部小字只留一句不起眼的补充。
  let hpBefore: number | null = null, hpAfter: number | null = null, hpMax: number | null = null;
  let downed: Downed | null = null;
  let note = '';
  const kind = downedBy(sharp);
  update((d) => {
    const dm = findMap(d, t.mapId)!;
    const dt = dm.tokens.find((x) => x.id === targetTokenId)!;
    // NPC：棋子上填了 hp/hpMax 就按它扣；没填就当作没有血条，伤害只进裁定。
    const tokenHP = (dt.hpMax ?? 0) > 0 ? { hp: dt.hp ?? dt.hpMax!, max: dt.hpMax! } : null;
    const p = dt.pcId ? d.party.find((x) => x.id === dt.pcId) : null;
    const pool = p ? hpOf(p) : tokenHP;
    if (!pool) { note = `${dt.name} 没有血条（角色卡和棋子都没填 HP）；伤害记在裁定里`; return; }
    const next = Math.max(0, pool.hp - r.damage);
    hpBefore = pool.hp; hpAfter = next; hpMax = pool.max;
    if (p) { p.hp = next; p.hpMax ??= pool.max; }
    else { dt.hp = next; }
    const already = dt.status?.label === '濒死' ? 'dying' : dt.down ? 'down' : null;
    if (next <= 0) {
      downed = already ?? kind;
      if (downed === 'dying') {
        // 战斗模式下倒计时按回合走；自由行动没有回合，改由急救机器人挂一个到场时间。
        dt.status = t.combat
          ? { label: downedLabel('dying'), roundsLeft: DYING_ROUNDS }
          : robotIncoming();
      } else { delete dt.status; dt.down = true; }
    } else downed = already;
  });
  setTr({
    acted: true,
    msg: '',
    event: {
      kind: r.hit ? 'hit' : 'miss',
      attackerPcId: pl.pcId, attackerName: pl.name,
      targetPcId: target.pcId, targetName: target.name,
      roll: r.roll, crit: r.crit, damage: r.damage,
      hpBefore, hpAfter, hpMax, downed, note, at: Date.now(),
    },
  });
  return null;
}

/** 关掉大事卡片。 */
export function clearTrialEvent() {
  const t = tr();
  if (t?.event) setTr({ event: null });
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

/** 借机攻击：那一步触发后，主持人点「打」才会结算。 */
export function trialOpportunityAttack(): string | null {
  const t = tr();
  const o = t?.opportunity;
  if (!t || !o) return '没有待结算的借机攻击';
  const w = getWorld();
  const m = findMap(w, t.mapId);
  if (!m) return '地图不见了';
  const mover = m.tokens.find((k) => k.id === o.moverTokenId);
  if (!mover) return '被攻击的棋子不在了';
  const hits: string[] = [];
  update((d) => {
    const dm = findMap(d, t.mapId)!;
    for (const enemyId of o.enemies) {
      const e = dm.tokens.find((k) => k.id === enemyId);
      if (!e || e.opportunityUsed) continue;
      e.opportunityUsed = true;
      // 没有技能就是纯幸运骰 D100；这一击也走同一套命中规则（只有大失败落空）。
      const roll = 1 + Math.floor(Math.random() * 100);
      const r = rollAttack(roll, 8);
      const mv = dm.tokens.find((k) => k.id === mover.id)!;
      let noted = '';
      if (r.hit && mv.pcId) {
        const p = d.party?.find((x) => x.id === mv.pcId);
        if (p) {
          const { hp, max } = hpOf(p);
          const next = Math.max(0, hp - r.damage);
          p.hp = next; p.hpMax ??= max;
          noted = ` HP ${hp}→${next}/${max}`;
        }
      }
      hits.push(`${e.name} 借机攻击 ${mv.name}：D100=${r.roll === 100 ? '00' : r.roll}${r.crit ? '（特大成功 ×4）' : ''}${r.hit ? `，伤害 ${r.damage}` : '，大失败落空'}${noted}`);
    }
  });
  setTr({ opportunity: null, msg: hits.join('；') });
  return null;
}

/** 不打：跳过这次借机。 */
export function trialSkipOpportunity() {
  const t = tr();
  if (t?.opportunity) setTr({ opportunity: null });
}

/** 轮到谁行动时，它的借机攻击重新亮起。 */
export function refreshOpportunity(tokenId: string) {
  update((d) => {
    const m = findMap(d, getUI().trial?.mapId ?? '');
    const k = m?.tokens.find((x) => x.id === tokenId);
    if (k) delete k.opportunityUsed;
  });
}

/** 救治：把濒死/昏厥的人拉起来。敏捷 D100，投 1 没救回来。要解锁急救类技能才能做。 */
export function trialRescue(targetTokenId: string, opts: { roll?: number } = {}): string | null {
  const t = tr();
  const pl = t?.players[t.current];
  if (!t || !pl) return '没有正在试玩的角色';
  if (!t.combat) return '先打开战斗模式';
  if (t.acted) return '这回合的行动点已经用掉了，按空格结束回合';
  const w = getWorld();
  const m = findMap(w, t.mapId);
  const rescuer = m?.tokens.find((x) => x.id === pl.tokenId);
  const target = m?.tokens.find((x) => x.id === targetTokenId);
  if (!m || !rescuer || !target) return '找不到角色或目标';
  const dist = Math.abs(rescuer.x - target.x) + Math.abs(rescuer.y - target.y);
  if (dist > ENGAGE_RANGE) return `救治要贴身（${dist} 格 > ${ENGAGE_RANGE}）`;
  if (target.corpse) return `${target.name} 已经死了，救不回来`; // 尸体不能治
  if (target.status?.label !== '濒死' && !target.down && !target.status?.label.startsWith('急救机器人')) return `${target.name} 不需要救治`;
  const pc = w.party.find((p) => p.id === pl.pcId);
  if (!canRescue(pc?.skills ?? [])) return '没有解锁急救 / 救治类技能，做不了急救（动作库 #119 救治）';
  const roll = opts.roll ?? 1 + Math.floor(Math.random() * 100);
  const r = rollRescue(roll);
  if (!r.success) {
    setTr({ acted: true, msg: `救治失败（D100=${roll === 100 ? '00' : roll}）：${target.name} 还是没醒过来` });
    return null;
  }
  update((d) => {
    const dm = findMap(d, t.mapId)!;
    const dt = dm.tokens.find((x) => x.id === targetTokenId)!;
    delete dt.status;
    delete dt.down;
    if (dt.pcId) {
      const p = d.party.find((x) => x.id === dt.pcId);
      if (p) { p.hp = Math.max(p.hp ?? 0, RESCUED_HP); }
    } else {
      dt.hp = Math.max(dt.hp ?? 0, RESCUED_HP);
    }
  });
  setTr({ acted: true, msg: `救治成功（D100=${roll === 100 ? '00' : roll}${r.crit ? '，特大成功' : ''}）：${target.name} 被拉起来了，1 HP` });
  return null;
}

/**
 * 自由行动（非战斗）下的急救机器人：到点就把人拉起来。
 * 战斗模式不走这里——那边是回合倒计时。
 * 由界面定时调用即可，重复调用没有副作用。
 */
export function tickRobots(now = Date.now()): void {
  const t = tr();
  if (!t || t.combat) return;
  update((d) => {
    const m = findMap(d, t.mapId);
    if (!m) return;
    for (const k of m.tokens) {
      if (!k.status?.label.startsWith(ROBOT_LABEL)) continue;
      if (!robotArrived(k.status.endsAt, now)) continue;
      delete k.status;
      if (k.pcId) {
        const p = d.party.find((x) => x.id === k.pcId);
        if (p) p.hp = Math.max(p.hp ?? 0, RESCUED_HP);
      } else {
        k.hp = Math.max(k.hp ?? 0, RESCUED_HP);
      }
      d.log.push({ id: uid(), at: now, session: d.session, kind: 'note', text: `急救机器人到场，${k.name} 被拉起来了（1 HP）。` });
    }
  });
}

/**
 * 感知动作：观察／搜索／嗅闻／倾听。
 * 掷骰成功之后，规则版会把对得上的线索摆出来当候选，见证者再决定给什么。
 * 失败就什么都不给——这是作者定的口径。
 *
 * 战斗模式下占一个行动点；自由行动不占。
 */
export function trialSense(kind: SenseKind, opts: { targetObjectId?: string | null; roll?: (sides: number) => number } = {}): string | null {
  const t = tr();
  const pl = t?.players[t.current];
  if (!t || !pl) return '没有正在试玩的角色';
  if (t.combat && t.acted) return '这回合的行动点已经用掉了，按空格结束回合';
  const w = getWorld();
  const m = findMap(w, t.mapId);
  const tok = m?.tokens.find((x) => x.id === pl.tokenId);
  if (!m || !tok) return '找不到你的棋子';
  if (tok.corpse) return '你已经死了';
  const pc = w.party.find((p) => p.id === pl.pcId);
  if (!pc) return '找不到角色卡';

  const roll = rollSense(kind, pc, opts.roll);
  const hints = senseHints({ pc, pcName: pl.name, map: m, at: { x: tok.x, y: tok.y }, targetObjectId: opts.targetObjectId, roll });
  const useful = hints.filter((h) => h.from !== 'none');

  setTr({ acted: t.combat ? true : t.acted, sense: { kind, roll, hints: useful, at: Date.now() }, msg: describeSense(roll, pl.name) });
  update((d) => {
    d.log.push({ id: uid(), at: Date.now(), session: d.session, kind: 'note', text: describeSense(roll, pl.name) });
  });
  return null;
}

/**
 * 换跑法。跑步要花 ME、占行动点；慢跑两样都不花。
 * 只有进战斗模式才谈得上「占行动点」——自由行动不数行动点。
 */
export function trialRun(mode: RunMode | null): string | null {
  const t = tr();
  const pl = t?.players[t.current];
  if (!t || !pl) return '没有正在试玩的角色';
  const w = getWorld();
  const pc = w.party.find((p) => p.id === pl.pcId);
  if (!pc) return '找不到角色卡';
  if (mode === null) { setTr({ runMode: null, runTurns: 0, msg: '' }); return null; }

  const spec = RUN_MODES[mode];
  if (t.combat && spec.usesAction && t.acted) return `【${spec.label}】要占行动点，这回合已经用掉了`;
  if (runMeShort(pc, spec)) return `ME 不够：【${spec.label}】要 ${spec.meCost} ME，现在只有 ${pc.me}`;

  if (spec.meCost > 0) {
    update((d) => { const p = d.party.find((x) => x.id === pl.pcId); if (p && p.me != null) p.me -= spec.meCost; });
  }
  setTr({
    runMode: mode,
    runTurns: 0,
    acted: t.combat && spec.usesAction ? true : t.acted,
    msg: spec.usesAction ? `换【${spec.label}】` : '',
  });
  return null;
}

/**
 * 姿态：站、坐、蹲、躺、趴。
 *
 * 作者口径：
 * - 躺下基本丧失行动能力，要先用行动点翻身（躺→趴）或站起来（躺→站）
 * - 趴着能动，但按三倍消耗爬：普通人一回合 1 格
 * - 坐／蹲可以直接躺下，不用先站起来
 * - 目前姿态只影响视野高度；战斗里的额外效果还没定，先不写死
 */
export function trialStance(stance: Stance | null): string | null {
  const t = tr();
  const pl = t?.players[t.current];
  if (!t || !pl) return '没有正在试玩的角色';
  const w = getWorld();
  const tok = findMap(w, t.mapId)?.tokens.find((x) => x.id === pl.tokenId);
  if (!tok) return '找不到你的棋子';
  if (tok.corpse) return '你已经死了';
  if (tok.status?.label === '昏厥') return `${pl.name}昏厥中，动不了`;

  const mMap = findMap(w, t.mapId)!;
  const mover = w.party.find((p) => p.id === pl.pcId);
  const from = tok.stance ?? '站';
  const to = stance ?? '站';
  if (from === to) return `已经是${to}着了`;

  // 从躺或趴起来要花移动点数（不是行动点）：起身 150，翻身到趴 75。
  // 坐／蹲直接躺下不用花。
  const rising = (from === '躺' || from === '趴') && to !== from;
  const cost = !rising ? 0 : to === '趴' ? ROLL_OVER_COST : STAND_UP_COST;
  // 这回合还没走过路时，点池还是满的——按满池算，不是按 0 算。
  const poolNow = t.movePoints?.[pl.tokenId]
    ?? movePool(mover ? moveBudgetOn(mover, mMap.layer) : null, t.charge?.[pl.tokenId]?.cells ?? 0);
  if (cost > 0 && t.combat && !canAffordStep(poolNow, cost)) {
    return `移动点数不够：${to === '趴' ? '翻身' : '起身'}要 ${cost} 点，这回合只剩 ${Math.round(poolNow)} 点`;
  }

  update((d) => {
    const dt = findMap(d, t.mapId)!.tokens.find((x) => x.id === pl.tokenId)!;
    if (to === '站') delete dt.stance; else dt.stance = to;
  });
  const say: Record<Stance, string> = {
    站: `${pl.name}站起来了`, 坐: `${pl.name}坐下了`, 蹲: `${pl.name}蹲下了`,
    躺: `${pl.name}躺下了`, 趴: `${pl.name}趴下了`,
  };
  setTr({
    msg: say[to],
    movePoints: cost > 0 && t.combat
      ? { ...(t.movePoints ?? {}), [pl.tokenId]: Math.max(0, poolNow - cost) }
      : t.movePoints,
  });
  return null;
}
