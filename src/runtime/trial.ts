import { clearTrialWindows, closePendingJudgment, openPlayerWindow, playerWindowFor, pushJudgeCancel, pushJudgmentRequest, registerTrialMove, selectTrialViewer } from './sync';
import { cancelJudgment, publishJudgment } from '../rules/judgments';
import { playerObject } from '../scene/identity';
import { effectiveLayer } from '../scene/vision';
import { objectEnabled } from '../core/objectData.js';
import { beginSandbox, endSandbox, getUI, getWorld, setUI, toast, update, worldContext, type UIState } from '../core/store';
import { addMark, autoReveal, cancelPendingPlay, checkEnterTriggers, findMap, ioBusy } from './actions';
import type { Delta, Facing, GameMap, Id, JumpCheckRecord, JumpRequest, MapObject, PC, PendingJudgment, Stance, Token, World } from '../core/types';
import { gridDist, uid } from '../core/util';
import { blocksMovement, ROUND_MINUTES } from '../scene/perception';
import { architectureGeometry, architectureObjectBounds, characterPathClear, furnitureSweepBlocked, nextTokenStep, openingIsOpen, setTokenPosition, tokenPosition } from '../scene/architecture';
import { terrainBlocksPoint, terrainBlocksRect } from '../scene/terrain';
import { slidingPuzzleForObject } from '../scene/sliding';
import { sightCacheFor, viewerOf, visiblePoint } from '../scene/sight';
import { describeSense, rollSense, senseHints, type SenseKind } from '../rules/sense';
import { resolveCheck } from '../rules/interaction';
import {
  describeInjury, describePitFall, describeStepDrop, gapAhead, INJURY_DICE, INJURY_LABEL, injuryTier,
  judgeValue, jumpSkillsOf, pitFall, planJump, rollInjury, stepDrop,
  type JumpCheck, type JumpRoll,
} from '../rules/jump';
import { openJudgment } from '../rules/judgments';
import { appendEvent, newEvent } from '../rules/events';
import { CELL_METERS, heightAt } from '../scene/height';
import { cellFloor, hasPitBottom } from '../scene/terrain';
import { canAffordStep, canTurn, chargeUsedThisTurn, moveBudgetOn, movePool, RUN_MODES, runMeShort, spendCharge, stepPrice, tickCharge, STAND_UP_COST, ROLL_OVER_COST, type ChargeState, type RunMode } from '../rules/move';
import { ATTACK_BAND_LABEL, ATTACK_RANGE, DYING_LABEL, DYING_ROUNDS, ENGAGE_RANGE, RESCUED_HP, ROBOT_LABEL, attackTargets, canRescue, canUseSharp, downedBy, downedLabel, hpOf, opportunityTriggers, robotArrived, robotIncoming, rollAttack, rollRescue, settleDeath, stepLimitNear, type AttackTarget, type Downed, type Roller } from '../rules/combat';

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
  // 试玩是另一个世界：外面还等着的判定不能带进去（结算会写进沙盒，结束试玩就丢了）。
  if (getUI().pendingJudgment) { closePendingJudgment(); toast('开始试玩，之前等着的判定已取消'); }
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
  // 试玩结束：这笔判定跟着试玩一起作废，主持端和玩家窗口都不该再等它。
  closePendingJudgment();
  clearTrialWindows();
  cancelPendingPlay();
  endSandbox();
  // 试玩里触发的播放只在主持人这边（没发给玩家），结束时换回试玩前在放的那个
  setUI({ trial: null, selection: null, nowPlaying: playingBefore });
  playingBefore = null;
}

/** 躺下的人干不了什么，得先花移动点翻身或者站起来（不是行动点）。 */
function lyingMsg(tok: { stance?: string; name: string }): string | null {
  return tok.stance === '躺' ? `${tok.name}躺着，先翻身或站起来（要花移动点）` : null;
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
  // 尸体和昏厥是另外两个字段，不挡在 status 里——这里补一道，不然死了还能走。
  if (tok.corpse) return setTr({ msg: `${pl.name}已经死了` });
  if (tok.down) return setTr({ msg: `${pl.name}昏厥中，动不了` });
  const lying = lyingMsg(tok);
  if (lying) return setTr({ msg: lying });
  // 朝向：战斗中第一次按方向＝原地转身，再按同方向才走（回合制下等于一次确认）。
  // 自由行动不确认，朝向跟着走；转身不占行动点；被缠斗时一回合只能转一次。
  const dir = dirOf(dx, dy);
  const runModeNow = runModeOf(t, pl.tokenId);
  const runSpec = runModeNow ? RUN_MODES[runModeNow] : null;
  if (t.combat && tok.facing !== dir) {
    if (t.combat && isEngaged(m, tok) && t.turned?.[pl.tokenId]) return setTr({ msg: '被缠斗住了：这回合只能转一次身' });
    // 跑起来拐弯有限：奔跑整回合只能拐一次，爆跑一次都不准。
    if (runSpec && !canTurn(runSpec, runTurnsOf(t, pl.tokenId))) {
      return setTr({ msg: runSpec.turns === 0 ? `【${runSpec.label}】不能拐弯，往${dir}得先停下来` : `【${runSpec.label}】这一回合已经拐过弯了` });
    }
    update((d) => {
      const dt = findMap(d, t.mapId)!.tokens.find((x) => x.id === pl.tokenId)!;
      dt.facing = dir;
    });
    setTr({
      msg: `转向${dir}`,
      turned: t.combat ? { ...(t.turned ?? {}), [pl.tokenId]: true } : t.turned,
      runTurns: runSpec ? { ...(t.runTurns ?? {}), [pl.tokenId]: runTurnsOf(t, pl.tokenId) + 1 } : t.runTurns,
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
  const price = stepPrice(runModeNow, prone);
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
  // 不管战斗还是自由行动，都不能停在别人的格子上。
  const landing = { x: Math.floor(step.b.x), y: Math.floor(step.b.y) };
  const occupied = m2.tokens.find((k) => k.id !== tok.id && Math.floor(tokenPosition(k).x) === landing.x && Math.floor(tokenPosition(k).y) === landing.y);
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
    attr: plan.check?.attr ?? null, dice: plan.check?.dice, landing, injury: plan.injury, moveMultiplier: plan.moveMultiplier,
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
    sides: 20, subjectId: pcId,
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
    attr: plan.check?.attr ?? null, dice: plan.check?.dice, landing, injury: plan.injury, moveMultiplier: plan.moveMultiplier,
    forcedFall: !plan.check,
  };
  req.landingStep = 1;
  req.unitPrice = unitPrice;
  if (!plan.check) { beginFall(req, null); return; }
  const pc = w.party.find((p) => p.id === pcId);
  if (!attributesFilled(pc)) {
    return setTr({ msg: `${tok.name} 还没填六维（右上角角色面板 → 六维与 HP）。没填的话任何检定都是必败，先填上再跳` });
  }
  const tier = plan.injury ?? injuryTier(fall);
  const err = openJudgment({
    title: `跳下去：落差 ${fall} 格`,
    ruling: `${tok.name} 从 ${fall} 格（${(fall * CELL_METERS).toFixed(2)} 米）跳下去，过【${plan.check.attr}】。`
      + `没过就摔：${INJURY_LABEL[tier]} 1D${INJURY_DICE[tier]}。`,
    sides: 20, subjectId: pcId,
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
    attr: plan.check?.attr ?? null, dice: plan.check?.dice, landing, injury: plan.injury, moveMultiplier: plan.moveMultiplier,
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
    sides: 20, subjectId: pcId,
    place: { mapId: m.id, x: from.x + 0.5, y: from.y + 0.5 },
    jump: req,
  });
  if (err) return setTr({ msg: err });
  pushJudgmentRequest(pcId);
  setTr({ msg: '跳跃判定已开出。他掷完你点「按结果执行」' });
}

type JumpRollBy = 'player' | 'witness' | 'host';

interface JumpSettleOptions {
  injuryRoll?: number;
  injuryBy?: JumpRollBy;
  checkBy?: JumpRollBy;
}

/** 把已经掷完的属性骰记成可以带进第二棒和最终事件的形状。 */
function jumpCheckRecord(req: JumpRequest, roll: JumpRoll, by: JumpRollBy): JumpCheckRecord {
  return {
    attr: req.attr ?? '',
    dice: req.dice ?? 'single',
    rolls: [...roll.rolls],
    used: roll.used,
    value: roll.value,
    total: roll.total,
    dc: roll.dc,
    success: roll.success,
    tier: roll.tier === 'crit' || roll.tier === 'fumble' ? roll.tier : null,
    outcome: roll.success
      ? (roll.tier === 'crit' ? '大成功' : '成功')
      : (roll.tier === 'fumble' ? '大失败' : '失败'),
    rolledBy: by,
  };
}

/** 跳跃动作的账本名字。 */
function jumpActionName(req: JumpRequest): string {
  if (req.kind === 'across') return `跨过 ${req.cells} 格坑`;
  if (req.kind === 'up') return `往上攀 ${req.cells} 格`;
  return `往下跳 ${req.cells} 格`;
}

/** 第二棒（摔伤骰）只开给有窗口的玩家；没窗口就由见证者现掷。 */
function openFallPending(req: JumpRequest, check: JumpCheckRecord | null, place: { mapId: string; x: number; y: number } | null): string | null {
  const t = tr();
  const w = getWorld();
  const m = t ? findMap(w, t.mapId) : null;
  const tok = m?.tokens.find((x) => x.id === req.tokenId);
  const pc = tok?.pcId ? w.party.find((p) => p.id === tok.pcId) : null;
  if (!t || !m || !tok || !pc) return '找不到摔伤骰的对象';
  if (!playerWindowFor(pc.id)) return '没有试玩玩家窗口';
  const injury = req.injury ?? injuryTier(req.fall);
  const sides = INJURY_DICE[injury];
  const pos = tokenPosition(tok);
  const err = openJudgment({
    title: `摔伤骰：${INJURY_LABEL[injury]} 1D${sides}`,
    ruling: `${tok.name} 没跳/没攀住，摔下来。${INJURY_LABEL[injury]} 1D${sides} 由他自己掷；掷完见证者按结果扣血。`,
    sides: sides as 4 | 6 | 8 | 10 | 12 | 20,
    subjectId: pc.id,
    place: place ?? { mapId: m.id, x: pos.x, y: pos.y },
    fall: { mapId: m.id, tokenId: tok.id, req, check, injury },
  });
  if (err) return err;
  pushJudgmentRequest(pc.id);
  setTr({ msg: '摔伤骰已开出去，等他掷；掷完你再点「按结果执行」' });
  return '';
}

/** 不用属性检定的必摔：有玩家窗口就让他掷摔伤骰，没有就见证者现掷。 */
function beginFall(req: JumpRequest, check: JumpCheckRecord | null, checkBy: JumpRollBy = 'host'): string {
  const t = tr();
  const w = getWorld();
  const m = t ? findMap(w, t.mapId) : null;
  const tok = m?.tokens.find((x) => x.id === req.tokenId);
  const pc = tok?.pcId ? w.party.find((p) => p.id === tok.pcId) : null;
  if (pc && playerWindowFor(pc.id)) return openFallPending(req, check, null) ?? '';
  const injury = req.injury ?? injuryTier(req.fall);
  const dmg = rollInjury(injury);
  return settleJump(req, check?.rolls ?? [], { injuryRoll: dmg, injuryBy: 'host', checkBy });
}

/** 结算前确认地图/棋子还在；广播前先查，避免“骰子已经发出去、账却没落”。 */
function jumpTarget(req: JumpRequest): { w: World; m: GameMap; tok: Token; pc: PC | null } | null {
  const t = tr();
  if (!t) return null;
  const w = getWorld();
  const m = findMap(w, t.mapId);
  if (!m) return null;
  const tok = m.tokens.find((x) => x.id === req.tokenId);
  if (!tok) return null;
  const pc = tok.pcId ? w.party.find((p) => p.id === tok.pcId) ?? null : null;
  return { w, m, tok, pc };
}

/** 广播第一颗骰之前先做这个；失败就一个字都不广播。 */
function jumpPrecheck(req: JumpRequest): string | null {
  return jumpTarget(req) ? null : '找不到跳跃对象';
}

/**
 * 按掷出来的点数结算一次跳跃。
 * - 成功：挪棋子、扣移动点，记一条事件；
 * - 失败：按落差掷/读摔伤骰，扣血、处理落点，记一条事件。
 * @param values 属性骰点数；不用掷就传空数组。
 * @param opts.injuryRoll 已经掷好的摔伤骰（玩家窗口第二棒/见证者代掷时传）；不传就现掷。
 */
export function settleJump(req: JumpRequest, values: number[], opts: JumpSettleOptions = {}): string {
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
    const check: JumpCheck = { attr: req.attr, dice: req.dice ?? 'single', why: '' };
    roll = judgeValue(check, pc ?? ({ attributes: {} } as never), values);
  }
  const landed = req.forcedFall ? false : roll === null || roll.success;
  const dir = dirOf(req.dx, req.dy);
  const before = tokenPosition(tok);
  const gridFrom = { x: Math.floor(before.x), y: Math.floor(before.y) };
  const done = { across: '跳过去', up: '攀上去', down: '跳下去' }[req.kind];
  const fail = { across: '没跳过去', up: '没攀上去', down: '没跳下去' }[req.kind];
  const landingStep = req.landingStep ?? Math.abs(req.landing.x - Math.floor(tok.x)) + Math.abs(req.landing.y - Math.floor(tok.y));
  const landingAt = { x: req.landing.x + 0.5, y: req.landing.y + 0.5 };

  // 落点、摔伤档和摔伤骰先算清，再一次性改世界（这样账本能同时拿到前后值）。
  let fallInfo: ReturnType<typeof pitFall> | null = null;
  let to: { x: number; y: number } | null = landed ? landingAt : null;
  let nextFloor = false;
  let damageInjury = req.injury ?? injuryTier(req.fall);
  if (!landed && req.kind === 'across') {
    const start = { x: Math.floor(before.x), y: Math.floor(before.y) };
    const pit = { x: start.x + req.dx, y: start.y + req.dy };
    const bottom = hasPitBottom(w, m, pit.x, pit.y) ? heightAt(m, pit.x, pit.y) : null;
    fallInfo = pitFall(heightAt(m, start.x, start.y), bottom);
    damageInjury = fallInfo.injury;
    nextFloor = !!fallInfo.nextFloor;
    if (!nextFloor) to = { x: pit.x + 0.5, y: pit.y + 0.5 };
  } else if (!landed && req.kind === 'down') {
    to = landingAt;
  }

  const injurySides = INJURY_DICE[damageInjury];
  const rawInjury = landed ? 0 : (opts.injuryRoll ?? rollInjury(damageInjury));
  const damageRoll = landed ? 0 : Math.max(1, Math.min(injurySides, Math.round(rawInjury)));
  const injuryBy = opts.injuryBy ?? 'host';
  const checkBy = opts.checkBy ?? 'host';
  const record = roll && req.attr ? jumpCheckRecord(req, roll, checkBy) : null;

  // 成功才扣移动点；失败照旧不扣（和原来一样）。
  let pointsBefore: number | null = null;
  let pointsAfter: number | null = null;
  if (landed && t.combat) {
    const pool = t.movePoints?.[req.tokenId]
      ?? movePool(pc ? moveBudgetOn(pc, m.layer) : null, t.charge?.[req.tokenId]?.cells ?? 0);
    const cost = (req.unitPrice ?? 75) * req.moveMultiplier * landingStep;
    pointsBefore = pool;
    pointsAfter = Math.max(0, pool - cost);
  }

  const at = Date.now();
  update((d) => {
    const dm = findMap(d, t.mapId);
    if (!dm) return;
    const dt = dm.tokens.find((x) => x.id === req.tokenId);
    if (!dt) return;
    const p = dt.pcId ? d.party.find((x) => x.id === dt.pcId) : null;
    const tokenHP = (dt.hpMax ?? 0) > 0 ? { hp: dt.hp ?? dt.hpMax!, max: dt.hpMax! } : null;
    const pool = p ? hpOf(p) : tokenHP;
    let hpBefore: number | null = null;
    let hpAfter: number | null = null;
    let oldLabel: string | null = null;
    let downed: Downed | null = null;
    const deltas: Delta[] = [];

    if (pool && damageRoll > 0) {
      hpBefore = pool.hp;
      hpAfter = Math.max(0, pool.hp - damageRoll);
      if (p) { p.hp = hpAfter; p.hpMax ??= pool.max; } else { dt.hp = hpAfter; }
      if (hpAfter !== hpBefore) {
        deltas.push({ kind: 'hp', id: dt.pcId ?? dt.id, name: dt.name, from: hpBefore, to: hpAfter });
      }
      oldLabel = dt.status?.label ?? (dt.down ? downedLabel('down') : null);
      if (hpAfter === 0) {
        // 作者口径（2026-11-11）：单次摔伤超过 10 点才把「归零」办成濒死；没超过就是昏厥。
        downed = oldLabel === DYING_LABEL ? 'dying' : damageRoll > 10 ? 'dying' : 'down';
        if (downed === 'dying') {
          // 已经濒死的人再摔一次，不该被重置成满回合；保留原来的倒计时。
          if (oldLabel !== DYING_LABEL) dt.status = t.combat ? { label: DYING_LABEL, roundsLeft: DYING_ROUNDS } : robotIncoming();
        } else {
          delete dt.status;
          dt.down = true;
        }
        // 状态的“真值”要看棋子实际挂着的 label：非战斗濒死其实挂的是急救机器人，
        // 不能把语义上的『濒死』直接写成一条假的 status delta。
        const actualLabel = dt.status?.label ?? (dt.down ? downedLabel('down') : null);
        if (oldLabel !== actualLabel) {
          deltas.push({ kind: 'status', id: dt.id, name: dt.name, from: oldLabel, to: actualLabel });
        }
      }
    }

    if (to) {
      setTokenPosition(dm, dt, to);
      dt.facing = dir;
      const at2 = tokenPosition(dt);
      const gridTo = { x: Math.floor(at2.x), y: Math.floor(at2.y) };
      if (gridFrom.x !== gridTo.x || gridFrom.y !== gridTo.y) {
        deltas.push({ kind: 'moved', id: dt.pcId ?? dt.id, name: dt.name, from: gridFrom, to: gridTo });
      }
    }
    if (pointsBefore !== null && pointsAfter !== null && pointsBefore !== pointsAfter) {
      deltas.push({ kind: 'points', id: dt.pcId ?? dt.id, name: dt.name, pool: 'move', from: pointsBefore, to: pointsAfter });
    }

    let note = '';
    if (!landed) {
      note = fallInfo ? describePitFall(fallInfo, damageRoll) : describeInjury(req.fall, damageRoll);
      if (fallInfo?.nextFloor) note += '；掉到下一层，棋子要见证者手动挪';
      if (!pool) note += '；没有血条，摔伤没落地';
      else if (hpAfter === 0) {
        const actualLabel = dt.status?.label ?? (dt.down ? downedLabel('down') : null);
        if (oldLabel === actualLabel) {
          if (oldLabel === DYING_LABEL) note += '；本来就已经是濒死，倒计时没有重置';
          else if (oldLabel === downedLabel('down')) note += '；本来就已经是昏厥，状态没有变';
          else note += `；状态已经是「${oldLabel ?? '无'}」，这次没有变`;
        } else {
          note += damageRoll > 10 ? `；单次摔伤超过 10 点，HP 归零 → ${actualLabel}` : `；HP 归零 → ${actualLabel}`;
        }
      } else if (damageRoll > 10) note += `；摔伤超过 10 点，但 HP 还剩 ${hpAfter}，没进濒死`;
      if (pool && hpBefore !== null && hpAfter !== null && hpBefore > 0 && hpBefore < damageRoll) note += `；实扣 ${hpBefore}（掷出 ${damageRoll}）`;
    }

    const actor = p
      ? { kind: 'pc' as const, id: p.id, name: dt.name }
      : { kind: 'npc' as const, id: dt.id, name: dt.name };
    const check = record ? {
      kind: 'check' as const,
      scale: 'd20' as const,
      attrs: [{ attr: record.attr, dice: record.dice, roll: record.used, used: record.used, value: record.value, total: record.total }],
      merge: 'single' as const,
      dc: record.dc,
      success: record.success,
      tier: record.tier,
      outcome: record.outcome,
      rolledBy: record.rolledBy,
    } : undefined;
    appendEvent(d, newEvent(d, at, actor, { name: jumpActionName(req), source: '临场' }, {
      ...(check ? { check } : {}),
      ...(damageRoll > 0 ? { damage: { kind: 'fall' as const, sides: injurySides as 4 | 6 | 8 | 10 | 12 | 20, roll: damageRoll, by: injuryBy, tier: damageInjury } } : {}),
      deltas,
      ...(note ? { note } : {}),
    }));
  });

  // 账本已经落了，界面这一句仍保留原来的口径。
  if (landed) {
    const detail = roll ? `：骰点 ${roll.used} + 区值 ${roll.value} = ${roll.total} / DC ${roll.dc}` : '';
    setTr({
      ...(pointsAfter !== null ? { movePoints: { ...(t.movePoints ?? {}), [req.tokenId]: pointsAfter } } : {}),
      ...(req.usesAction ? { acted: { ...(t.acted ?? {}), [req.tokenId]: true } } : {}),
      msg: `${done}了${detail}`,
    });
    checkEnterTriggers(t.mapId, req.tokenId, before.x, before.y);
    autoReveal(t.mapId);
    return '';
  }

  setTr({ msg: `${fail}，${fallInfo ? describePitFall(fallInfo, damageRoll) : describeInjury(req.fall, damageRoll)}` });
  if (to) {
    checkEnterTriggers(t.mapId, req.tokenId, before.x, before.y);
    autoReveal(t.mapId);
  }
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
  // 换回合要把这一回合的账本清干净：跑了什么、拐了几次都是「本回合」的。
  // 不清的话「奔跑只准拐一次」会变成整场只准拐一次，下一回合还会白送一个跑法。
  // 锐器只对「这一击」有效：勾了没打就结束回合，也回默认钝器，别把上一轮的勾带进下一轮。
  setTr({ moved: {}, turned: {}, turn: t.turn + 1, acted: {}, runMode: {}, runTurns: {}, sharpAttack: {},
    opportunity: null, msg: '', charge, movePoints });
}

/** 当前该谁行动（试玩里同一时间只有一个角色能动）。 */
export function currentTokenId(t: Trial | null | undefined): string | null {
  return t?.players[t.current]?.tokenId ?? null;
}
/** 这一回合的行动点用掉没有——按人记，不是全队一份。 */
const actedOf = (t: Trial, tokenId: string | null): boolean => !!(tokenId && t.acted?.[tokenId]);
/** 这个棋子这一回合选的跑法。 */
export const runModeOf = (t: Trial | null | undefined, tokenId: string | null): RunMode | null =>
  (tokenId && t?.runMode?.[tokenId]) || null;
/** 这一回合拐了几次弯。 */
const runTurnsOf = (t: Trial, tokenId: string | null): number => (tokenId ? t.runTurns?.[tokenId] ?? 0 : 0);
/** 这次攻击是不是用锐器。 */
export const sharpOf = (t: Trial | null | undefined, tokenId: string | null): boolean =>
  !!(tokenId && t?.sharpAttack?.[tokenId]);

/** 这一回合还有几点行动点：每回合 1 点，攻击/主动技能花掉就算用完。 */
export const actionsLeft = (t: Trial | null | undefined): number => {
  if (!t?.combat) return 1;
  return actedOf(t, currentTokenId(t)) ? 0 : 1;
};

/**
 * 攻击的前置：校验 + 取攻击者/目标。返回错误字符串，或者一份可以直接用的上下文。
 * 校验只写这一份——发起（开判定）和结算（真扣血）都走它，免得两边口径漂。
 */
function attackContext(targetTokenId: string, sharp: boolean) {
  const t = tr();
  const pl = t?.players[t.current];
  if (!t || !pl) return '没有正在试玩的角色';
  if (!t.combat) return '先打开战斗模式再攻击';
  if (actedOf(t, pl.tokenId)) return '这回合的行动点已经用掉了，按空格结束回合';
  const w = getWorld();
  const m = findMap(w, t.mapId);
  const attacker = m?.tokens.find((x) => x.id === pl.tokenId);
  const target = m?.tokens.find((x) => x.id === targetTokenId);
  if (!m || !attacker || !target) return '找不到攻击者或目标';
  if (attacker.id === target.id) return '不能打自己';
  if (attacker.stance === '躺') return `${attacker.name}躺着，打不了。先翻身或站起来`;
  // 尸体/昏厥是单独两个字段，不在 status 里——不拦的话死了还能打人。
  if (attacker.corpse) return `${attacker.name}已经死了`;
  if (attacker.down) return `${attacker.name}昏厥中，打不了`;
  if (target.corpse) return `${target.name} 已经死了，不用再打`;
  if (target.status?.label === '濒死') return `${target.name} 已经濒死了`;
  const dist = Math.abs(attacker.x - target.x) + Math.abs(attacker.y - target.y);
  if (dist > ATTACK_RANGE) return `超出攻击距离（${dist} 格 > ${ATTACK_RANGE}）`;
  const pc = w.party.find((p) => p.id === pl.pcId);
  // 钝器默认；锐器要攻击者身上带着才行，不带的人勾不了。
  if (sharp && !canUseSharp(pc)) return `${pl.name} 身上没有锐器，只能用钝器`;
  const eye = viewerOf(attacker, { sex: pc?.sex, heightCm: pc?.heightCm });
  if (!visiblePoint(w, m, eye, tokenPosition(target))) return '看不见目标，不能攻击';
  return { t, pl, w, m, attacker, target, pc, sharp };
}

/**
 * 发起攻击。骰子归发起者：玩家发起 → 开一笔判定，骰子进他的窗口；NPC/见证者 → 这边现掷。
 * 攻击走 D100 攻击口径（000 特大 / 1–5 落空 / 95–99 大成功 / 其余命中），伤害默认 1D8。
 */
export function trialAttack(targetTokenId: string, opts: { roll?: number; roller?: Roller; sharp?: boolean } = {}): string | null {
  const ctx = attackContext(targetTokenId, !!opts.sharp);
  if (typeof ctx === 'string') return ctx;
  if (opts.roll === undefined && ctx.pl.pcId && playerWindowFor(ctx.pl.pcId)) {
    const err = openJudgment({
      title: `攻击 ${ctx.target.name}`, ruling: '', sides: 100, subjectId: ctx.pl.pcId, place: null,
      attack: { attackerTokenId: ctx.pl.tokenId, targetTokenId, sharp: ctx.sharp },
    });
    if (err) return err;
    pushJudgmentRequest(ctx.pl.pcId);
    return null;
  }
  return settleAttack(targetTokenId, opts.roll ?? 1 + Math.floor(Math.random() * 100), { ...opts, rolledBy: 'host' });
}

// —— 门：开门 / 撬锁 ——
//
// 门锁是门上的正交状态：locked（锁着没有）+ keyable（还能不能配钥匙）。
// 「卡死」不是第三种开合状态，而是「锁着 + 配不出钥匙」：门照旧关着挡路，只能强行打开。
export const LOCKPICK_SKILL_ID = '001-9-204';
/** 标准 DC：D20 区 20。门不单独带 DC。 */
export const LOCK_DC = 20;
const PICK_ATTRS = ['智慧', '敏捷'] as const;
const FORCE_ATTRS = ['力量', '敏捷'] as const;

export interface TrialDoor {
  objectId: Id;
  name: string;
  open: boolean;
  locked: boolean;
  keyable: boolean;
  kind?: 'physical' | 'electronic';
  /** 身上有【开锁副手】才能巧力撬锁；暴力开锁谁都能试。 */
  canPick: boolean;
}

/** 当前试玩角色贴身 1 格以内、看得见的门。 */
export function trialDoors(): TrialDoor[] {
  const t = tr();
  const pl = t?.players[t.current];
  if (!t || !pl) return [];
  const w = getWorld();
  const m = findMap(w, t.mapId);
  const tok = m?.tokens.find((x) => x.id === pl.tokenId);
  const pc = w.party.find((p) => p.id === pl.pcId);
  if (!m || !tok || !pc) return [];
  const at = tokenPosition(tok);
  const near = (b: { x: number; y: number; w: number; h: number }) =>
    Math.max(b.x - at.x, 0, at.x - (b.x + b.w), b.y - at.y, 0, at.y - (b.y + b.h)) <= 1;
  // 门就在手边：不按身体朝向卡（人回头就能看见），只按视线通不通。
  const eye = { ...viewerOf(tok, { sex: pc.sex, heightCm: pc.heightCm }), facing: undefined };
  const geom = architectureGeometry(m);
  /** 看得见：视线能到门板中央，但不算这扇门自己挡自己。 */
  const seen = (o: MapObject) => {
    const b = architectureObjectBounds(m, o);
    return visiblePoint(w, m, eye, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, geom.filter((r) => r.objectId !== o.id));
  };
  return m.objects
    .filter((o) => o.opening && objectEnabled(m, o) && !o.hidden)
    .filter((o) => near(architectureObjectBounds(m, o)) && seen(o))
    .map((o) => ({
      objectId: o.id, name: o.name, open: openingIsOpen(o),
      locked: !!o.lock?.locked, keyable: o.lock ? o.lock.keyable : true, kind: o.lock?.kind,
      canPick: (pc.skills ?? []).includes(LOCKPICK_SKILL_ID),
    }));
}

interface DoorCtx {
  t: NonNullable<UIState['trial']>;
  m: GameMap;
  door: MapObject;
  pl: NonNullable<UIState['trial']>['players'][number];
  pc: PC;
  tok: Token;
}

/** 门操作共同的前置：在试玩里、贴身 1 格、门在、角色卡在。 */
function doorContext(objectId: string): DoorCtx | string {
  const t = tr();
  const pl = t?.players[t.current];
  if (!t || !pl) return '没有正在试玩的角色';
  const w = getWorld();
  const m = findMap(w, t.mapId);
  if (!m) return '找不到试玩地图';
  const door = m.objects.find((o) => o.id === objectId && o.opening);
  if (!door || !objectEnabled(m, door)) return '找不到这扇门';
  if (door.hidden) return '看不见这扇门';
  const tok = m.tokens.find((x) => x.id === pl.tokenId);
  const pc = w.party.find((p) => p.id === pl.pcId);
  if (!tok || !pc) return '找不到当前角色';
  const at = tokenPosition(tok), b = architectureObjectBounds(m, door);
  const dist = Math.max(b.x - at.x, 0, at.x - (b.x + b.w), b.y - at.y, 0, at.y - (b.y + b.h));
  if (dist > 1) return '要贴身才能操作这扇门';
  const eye = { ...viewerOf(tok, { sex: pc.sex, heightCm: pc.heightCm }), facing: undefined };
  const geom = architectureGeometry(m).filter((r) => r.objectId !== door.id);
  if (!visiblePoint(w, m, eye, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, geom)) return '看不见这扇门';
  if (t.combat && actedOf(t, pl.tokenId)) return '这回合的行动点已经用掉了，按空格结束回合';
  return { t, m, door, pl, pc, tok };
}

/** 开一扇没锁的门。不掷骰，记一条事件。 */
export function trialOpenDoor(objectId: string): string | null {
  const ctx = doorContext(objectId);
  if (typeof ctx === 'string') return ctx;
  const { t, door, pl } = ctx;
  if (openingIsOpen(door)) return '门已经开着';
  if (door.lock?.locked) return '门锁着，得先撬锁';
  const openIdx = door.states.findIndex((_, i) => door.opening!.openStates.includes(i));
  if (openIdx < 0) return '门缺少打开状态';
  update((d) => {
    const dm = findMap(d, t.mapId)!;
    const o = dm.objects.find((x) => x.id === door.id)!;
    const from = o.states[o.state];
    o.state = openIdx;
    appendEvent(d, newEvent(d, Date.now(),
      { kind: 'pc', id: pl.pcId, name: pl.name },
      { name: '开门', source: '临场' },
      {
        target: { kind: 'object', id: o.id, name: o.name },
        deltas: [{ kind: 'object', id: o.id, name: o.name, path: '状态', from, to: o.states[openIdx] }],
      },
    ));
  });
  setTr({ ...(t.combat ? { acted: { ...(t.acted ?? {}), [pl.tokenId]: true } } : {}), msg: `${pl.name} 开了 ${door.name}` });
  return null;
}

/**
 * 撬锁 / 暴力开锁。
 * 巧力：智慧＋敏捷都过（要【开锁副手】）；暴力：力量＋敏捷都过（谁都能试，会响）。
 * 玩家窗口在 → 开一笔正式判定，骰子进他的窗口；不在 → 见证者现掷，同样落成正式判定。
 */
export function trialPickLock(objectId: string, method: 'pick' | 'force', opts: { rolls?: number[] } = {}): string | null {
  const ctx = doorContext(objectId);
  if (typeof ctx === 'string') return ctx;
  const { t, door, pl, pc } = ctx;
  const lock = door.lock;
  if (!lock) return '这扇门没有锁';
  if (lock.kind === 'electronic') return '电子锁还没接开锁动作';
  if (!lock.locked) return '锁已经解开了，直接开门';
  if (!lock.keyable && method === 'pick') return '锁芯卡死，巧力撬不开，只能强行打开';
  if (method === 'pick' && !(pc.skills ?? []).includes(LOCKPICK_SKILL_ID)) return '没有解锁【开锁副手】，只能暴力开锁';
  if (!door.opening!.openStates.length) return '门缺少打开状态，开不了（先检查门的设置）';
  const attrs = method === 'pick' ? PICK_ATTRS : FORCE_ATTRS;
  if (opts.rolls !== undefined && (opts.rolls.length !== attrs.length || opts.rolls.some((v) => !Number.isInteger(v) || v < 1 || v > 20))) return '骰点不对';
  const title = `${method === 'pick' ? '撬锁' : '暴力开锁'}：${door.name}`;
  const err = openJudgment({
    title, ruling: '', sides: 20, subjectId: pl.pcId, place: null,
    door: { mapId: t.mapId, objectId: door.id, method },
    check: { attrs: attrs.map((attr) => ({ attr, dice: 'single' as const })), dc: LOCK_DC, merge: 'all' },
  });
  if (err) return err;
  if (opts.rolls === undefined && pl.pcId && playerWindowFor(pl.pcId)) { pushJudgmentRequest(pl.pcId); return null; }
  const rolls = opts.rolls ?? attrs.map(() => 1 + Math.floor(Math.random() * 20));
  if (rolls.length !== attrs.length || rolls.some((v) => !Number.isInteger(v) || v < 1 || v > 20)) return '骰点不对';
  return settlePendingJudgment({ rollId: `host-${uid()}`, sides: 20, value: rolls[0], values: rolls, tens: null, units: null, material: 'wood', seed: 0 }, true);
}

/** 门判定的落地：按两颗骰子分别过 DC，都过才算成功；大成功一颗顶俩。 */
function settleDoorAttempt(
  p: NonNullable<UIState['pendingJudgment']>,
  input: JudgmentRollInput,
  byStandIn: boolean,
): string | null {
  if (!p.door || !p.check) return '判定数据不全';
  const w = getWorld();
  const pc = w.party.find((x) => x.id === p.subjectId);
  const m = findMap(w, p.door.mapId);
  const door = m?.objects.find((o) => o.id === p.door!.objectId);
  if (!pc || !door || !door.lock || !door.opening || !door.opening.openStates.length) return '这扇门已经变了，重开判定';
  const values = input.values?.length ? input.values : [input.value];
  if (values.length !== p.check.attrs.length) return '骰子数量不对';
  const checks = p.check.attrs.map((a, i) => resolveCheck({
    attributes: pc.attributes, attr: a.attr, rolls: [values[i]], scale: 'd20', dc: p.check!.dc,
  }));
  const crit = checks.find((c) => c.tier === 'crit');
  const success = !!crit || checks.every((c) => c.success);
  const fumble = !success && checks.some((c) => c.tier === 'fumble');
  let msg = '';
  let note: string | undefined;
  update((d) => {
    const dm = findMap(d, p.door!.mapId)!;
    const o = dm.objects.find((x) => x.id === p.door!.objectId)!;
    const deltas: Delta[] = [];
    const noise = p.door!.method === 'force' ? '，动静传出去了' : '';
    if (success) {
      if (o.lock!.locked) {
        o.lock = { ...o.lock!, locked: false };
        deltas.push({ kind: 'object', id: o.id, name: o.name, path: '锁具', from: '锁着', to: '已解开' });
      }
      const openIdx = o.states.findIndex((_, i) => o.opening!.openStates.includes(i));
      if (openIdx >= 0 && o.state !== openIdx) {
        deltas.push({ kind: 'object', id: o.id, name: o.name, path: '状态', from: o.states[o.state], to: o.states[openIdx] });
        o.state = openIdx;
      }
      if (deltas.length === 0) note = '门和锁在判定期间被处理过，没有新的变化';
      else if (p.door!.method === 'force') note = '暴力开锁，动静传出去了';
      else if (crit) note = '锁没有留痕';
      msg = `${pc.name} ${p.door!.method === 'pick' ? '撬开了' : '砸开了'} ${o.name}`;
    } else if (fumble) {
      if (o.lock!.keyable) {
        o.lock = { ...o.lock!, keyable: false };
        deltas.push({ kind: 'object', id: o.id, name: o.name, path: '锁具', from: '锁着', to: '卡死' });
        msg = `${o.name} 的锁芯卡死了，只能强行打开`;
        note = `锁芯卡死，只能强行打开${noise}`;
      } else {
        msg = `${o.name} 的锁芯早就卡死了，只能强行打开`;
        note = `锁芯早就卡死了${noise}`;
      }
    } else {
      msg = `${o.name} 的锁没动`;
      note = `锁没动${noise}`;
    }
    appendEvent(d, newEvent(d, Date.now(),
      { kind: 'pc', id: p.subjectId, name: pc.name },
      { name: p.door!.method === 'pick' ? '撬锁' : '暴力开锁', source: '临场' },
      {
        target: { kind: 'object', id: o.id, name: o.name },
        check: {
          kind: 'check', scale: 'd20', merge: 'all', dc: p.check!.dc, success,
          attrs: checks.map((c, i) => ({ attr: c.attr, dice: 'single' as const, roll: c.used, used: c.used, value: c.value, total: c.total })),
          tier: crit ? 'crit' : fumble ? 'fumble' : null,
          level: crit?.level === '特大' ? '特大' : null,
          rolledBy: byStandIn ? 'witness' : 'player',
        },
        deltas,
        ...(note ? { note } : {}),
      },
    ));
  });
  const t = tr();
  const who = t?.players.find((x) => x.pcId === p.subjectId);
  setTr({ ...(t && t.combat && who ? { acted: { ...(t.acted ?? {}), [who.tokenId]: true } } : {}), msg });
  return null;
}

/** 按掷出来的点数结算一次攻击。见证者点「按结果执行」，或 NPC 当场出手时走这里。 */
export function settleAttack(
  targetTokenId: string, roll: number,
  opts: { roller?: Roller; sharp?: boolean; rolledBy?: 'player' | 'witness' | 'host' } = {},
): string | null {
  const ctx = attackContext(targetTokenId, !!opts.sharp);
  if (typeof ctx === 'string') return ctx;
  const { t, pl, target, sharp } = ctx;

  const r = rollAttack(roll, 8, opts.roller);
  // 伤害这种大事单独给一张卡片（event），底部小字只留一句不起眼的补充。
  let hpBefore: number | null = null, hpAfter: number | null = null, hpMax: number | null = null;
  let downed: Downed | null = null;
  let note = '';
  const kind = downedBy(sharp);
  // 攻击也要进事件账本：句子是渲染出来的，不再各处自己拼一段中文。
  const deltas: Delta[] = [];
  const record = (d: World, extraNote?: string) => {
    const band = r.band;
    const ev = newEvent(d, Date.now(),
      { kind: 'pc', id: pl.pcId ?? pl.tokenId, name: pl.name },
      { name: sharp ? '攻击（锐器）' : '攻击（钝器）', source: '临场' },
      {
        target: { kind: target.pcId ? 'pc' : 'npc', id: target.pcId ?? target.id, name: target.name },
        check: {
          // 攻击没有 DC、也没有属性对抗：用 kind/band 说清楚，别拿 dc:0 当哨兵。
          kind: 'attack', band, scale: 'd100', attrs: [], merge: 'single', total: r.roll, success: r.hit,
          tier: band === 'super' || band === 'great' ? 'crit' : band === 'miss' ? 'fumble' : null,
          level: band === 'super' ? '特大' : null,
          // 攻击档位用攻击口径的词（落空/命中/大成功/特大成功）；别再翻成判定那套「失败」。
          outcome: ATTACK_BAND_LABEL[band],
          rolledBy: opts.rolledBy ?? 'host',
        },
        deltas,
        ...(extraNote ? { note: extraNote } : {}),
      });
    appendEvent(d, ev);
  };
  update((d) => {
    const dm = findMap(d, t.mapId)!;
    const dt = dm.tokens.find((x) => x.id === targetTokenId)!;
    // NPC：棋子上填了 hp/hpMax 就按它扣；没填就当作没有血条，伤害只进裁定。
    const tokenHP = (dt.hpMax ?? 0) > 0 ? { hp: dt.hp ?? dt.hpMax!, max: dt.hpMax! } : null;
    const p = dt.pcId ? d.party.find((x) => x.id === dt.pcId) : null;
    const pool = p ? hpOf(p) : tokenHP;
    if (!pool) {
      // 落空本来就没有伤害可记；只有真打中才需要说明「伤害没落地」。
      if (r.hit) { note = `${dt.name} 没有血条（角色卡和棋子都没填 HP）；伤害没落地`; record(d, note); }
      else record(d);
      return;
    }
    // 旧状态要先留成 from：被打到 0 的人本来可能是晕厥/中毒，不能写成「状态从 无 改为 昏厥」。
    const already = dt.status?.label === '濒死' ? 'dying' : dt.down ? 'down' : null;
    const oldLabel = dt.status?.label ?? (dt.down ? downedLabel('down') : null);
    const next = Math.max(0, pool.hp - r.damage);
    hpBefore = pool.hp; hpAfter = next; hpMax = pool.max;
    // 只有真变了才记：落空（伤害 0）不写「HP 从 6 改为 6」。
    if (next !== pool.hp) deltas.push({ kind: 'hp', id: dt.pcId ?? dt.id, name: dt.name, from: pool.hp, to: next });
    if (p) { p.hp = next; p.hpMax ??= pool.max; }
    else { dt.hp = next; }
    // 落空（伤害 0）不许进倒地分支：目标本来就是 hp0 的话，这一刀不该把状态抹掉。
    if (r.hit && next <= 0) {
      downed = already ?? kind;
      if (downed === 'dying') {
        // 战斗模式下倒计时按回合走；自由行动没有回合，改由急救机器人挂一个到场时间。
        dt.status = t.combat
          ? { label: downedLabel('dying'), roundsLeft: DYING_ROUNDS }
          : robotIncoming();
      } else { delete dt.status; dt.down = true; }
      // 按「状态文字真的变了」判断，而不是按 already：棋子本来带晕厥/中毒、down 也是 true 时，
      // 这一步会把 status 删掉，必须记下来（以前判 downed===already 会漏成「没变化」）。
      const newLabel = downedLabel(downed);
      // 本来就昏厥（down=true）又挂着别的状态：这一步是「那个状态被清掉」，不是「变成昏厥」。
      const toLabel = already === 'down' && downed === 'down' ? null : newLabel;
      if (oldLabel !== newLabel) deltas.push({ kind: 'status', id: dt.id, name: dt.name, from: oldLabel, to: toLabel });
    } else downed = already;
    // 命中但没掉血、只改了状态（打 hp0 的晕厥/中毒）：卡片不能只说「数值没有变化」。
    if (r.hit && deltas.length && !deltas.some((x) => x.kind === 'hp')) note = '这一下没有掉血，只改了状态';
    if (r.hit && !deltas.length) note = '这一下数值没有变化（目标已经在倒地状态，或没有可扣的血量）';
    record(d, note || undefined);
  });
  setTr({
    acted: { ...(t.acted ?? {}), [pl.tokenId]: true },
    // 锐器是「这一击的选择」：打完自动回默认钝器，下一击要重新勾。
    sharpAttack: { ...(t.sharpAttack ?? {}), [pl.tokenId]: false },
    msg: '',
    event: {
      kind: r.hit ? 'hit' : 'miss',
      attackerPcId: pl.pcId, attackerName: pl.name,
      targetPcId: target.pcId, targetName: target.name,
      roll: r.roll, crit: r.crit, dice: r.dice, damage: r.damage,
      hpBefore, hpAfter, hpMax, downed, note, at: Date.now(),
    },
  });
  return null;
}

/** 这一击实际扣掉多少血（没掉血就是 0）；卡片用它显示 −N，别把掷出的伤害当扣血。 */
export function damageLost(ev: { hpBefore: number | null; hpAfter: number | null }): number {
  return ev.hpBefore !== null && ev.hpAfter !== null && ev.hpAfter < ev.hpBefore ? ev.hpBefore - ev.hpAfter : 0;
}

/**
 * 这一击真的扣到血了吗：落空、打已经 0 血的人、打没血条的 NPC，都不算。
 * 卡片/玩家窗口用它决定要不要显示「−N 伤害」——账本不记的变化，卡片也不该报。
 */
export function damageLanded(ev: { damage: number; hpBefore: number | null; hpAfter: number | null }): boolean {
  return ev.damage > 0 && damageLost(ev) > 0;
}

/** 取消整个判定，并通知正在等这颗骰子的玩家窗口收掉骰盘（不然它会一直挂着，掷了也没人接）。 */
export interface JudgmentRollInput {
  rollId: string; sides: number; value: number; values?: number[];
  tens?: number | null; units?: number | null; material: string; seed: number;
}

/** 见证者确认这颗骰子：先落地（跳跃挪棋子 / 攻击扣血），再广播，最后把两边的等待状态一起收掉。 */
/** 广播这一棒的骰子；标题/裁定沿用这笔判定。 */
function publishPendingRoll(p: PendingJudgment, input: JudgmentRollInput, byStandIn: boolean): string | null {
  // 跳跃的优/劣势是同一项属性掷两次：正式判定也要留两颗，不能只留采信的那颗。
  const jumpDice = p.jump?.dice && p.jump.dice !== 'single' && (input.values?.length ?? 0) > 1 ? p.jump : null;
  const values = p.check ? (input.values ?? [input.value]) : jumpDice && p.jump?.attr ? input.values : undefined;
  const attrs = p.check
    ? p.check.attrs.map((a) => a.attr)
    : values && p.jump?.attr ? values.map(() => p.jump!.attr!) : undefined;
  return publishJudgment({
    title: p.title, ruling: p.ruling, recipients: getWorld().party.map((x) => x.id),
    roll: {
      id: input.rollId, sides: input.sides as never, value: input.value,
      ...(values ? { values, attrs } : {}),
      tens: input.tens ?? null, units: input.units ?? null,
      material: input.material as never, persona: byStandIn ? 'witness' : 'player', seed: input.seed,
    },
    subjectId: p.subjectId, place: p.place ?? null,
  }, p.context ?? worldContext());
}

export function settlePendingJudgment(input: JudgmentRollInput, byStandIn = false): string | null {
  const p = getUI().pendingJudgment;
  if (!p) return '没有待掷的判定';
  // 判定是在哪个工程/哪次试玩里开的，就只能在那儿结算：否则会静默写进另一个世界。
  if (p.context !== worldContext()) return '工程或试玩已切换，请重新掷骰';
  const diceValues = input.values?.length ? input.values : [input.value];
  if (p.door) { const e = settleDoorAttempt(p, input, byStandIn); if (e) return e; }
  // 第二棒：属性骰已经落过，这一颗是摔伤骰；结算时才挪棋子/扣血，最后一条总事件。
  if (p.fall) {
    const f = p.fall;
    // 先确认棋子还在，再广播第二颗；否则会出现“第二颗已发、总事件落不下去”。
    if (jumpPrecheck(f.req)) { closePendingJudgment(); return '找不到棋子'; }
    const err = publishPendingRoll(p, input, byStandIn);
    if (err) return err;
    const e = settleJump(f.req, f.check?.rolls ?? [], {
      injuryRoll: input.value,
      injuryBy: byStandIn ? 'witness' : 'player',
      checkBy: f.check?.rolledBy ?? 'host',
    });
    if (e) { closePendingJudgment(); return e; }
    closePendingJudgment();
    return null;
  }
  if (p.jump) {
    const req = p.jump;
    // 第一颗骰也不许先发再失败：先查棋子/地图。
    const target = jumpTarget(req);
    if (!target) { closePendingJudgment(); return '找不到跳跃对象'; }
    const pc = target.pc;
    const roll = req.attr ? judgeValue({ attr: req.attr, dice: req.dice ?? 'single', why: '' }, pc ?? ({ attributes: {} } as never), diceValues) : null;
    const landed = req.forcedFall ? false : roll === null || roll.success;
    const checkBy = byStandIn ? 'witness' as const : 'player' as const;
    const first = publishPendingRoll(p, input, byStandIn);
    if (first) return first;
    closePendingJudgment();
    if (!landed) {
      const tier = req.injury ?? injuryTier(req.fall);
      // 见证者代掷，或者玩家窗口已经关了：没有第二棒可等，见证者现掷并落账。
      if (byStandIn || !pc || !playerWindowFor(pc.id)) {
        const e = settleJump(req, diceValues, { injuryRoll: rollInjury(tier), injuryBy: 'witness', checkBy });
        return e || null;
      }
      const record = roll && req.attr ? jumpCheckRecord(req, roll, checkBy) : null;
      const e = openFallPending(req, record, p.place ?? null);
      if (e) {
        // 第二棒开不出来（窗口/对象刚好失效）：退回见证者现掷，至少保住一条总事件。
        const fallback = settleJump(req, diceValues, { injuryRoll: rollInjury(tier), injuryBy: 'witness', checkBy });
        return fallback || null;
      }
      return null;
    }
    const e = settleJump(req, diceValues, { checkBy });
    return e || null;
  }
  if (p.attack) {
    const e = settleAttack(p.attack.targetTokenId, input.value, { sharp: p.attack.sharp, rolledBy: byStandIn ? 'witness' : 'player' });
    if (e) return e;
  }
  const err = publishPendingRoll(p, input, byStandIn);
  if (err) return err;
  closePendingJudgment();
  return null;
}

export function cancelPendingJudgment(): string | null {
  const p = getUI().pendingJudgment;
  const msg = cancelJudgment();
  if (p?.subjectId) pushJudgeCancel(p.subjectId, p.id);
  return msg;
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
  // 新开一场战斗，点池和蓄力要重算；以前这里留着上一场的 300/414，第一回合直接「点数用完」。
  setTr({ combat: toCombat, moved: {}, turned: {}, acted: {}, runMode: {}, runTurns: {}, sharpAttack: {},
    movePoints: {}, charge: {}, turn: 1, msg: '' });
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
  // 一次枚举只建一次代价表：以前每个候选目标都重建一遍全图。
  const cache = sightCacheFor(w, m, eye);
  return attackTargets(w, m, attacker, (k) => visiblePoint(w, m, eye, tokenPosition(k), undefined, cache));
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
      // 借机攻击走攻击口径（作者已定）：000 特大成功 / 1–5 落空 / 95–99 大成功 / 其余命中。
      // 不是「纯幸运骰 51+」——那条是 resolveLuck 的口径，借机攻击不用它。
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
      const tag = r.dice > 1 ? `（${ATTACK_BAND_LABEL[r.band]}，${r.dice} 颗伤害骰）` : '';
      hits.push(`${e.name} 借机攻击 ${mv.name}：D100=${r.roll === 100 ? '00' : r.roll}${tag}${r.hit ? `，伤害 ${r.damage}` : '，落空'}${noted}`);
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
  if (actedOf(t, pl.tokenId)) return '这回合的行动点已经用掉了，按空格结束回合';
  const w = getWorld();
  const m = findMap(w, t.mapId);
  const rescuer = m?.tokens.find((x) => x.id === pl.tokenId);
  const target = m?.tokens.find((x) => x.id === targetTokenId);
  if (!m || !rescuer || !target) return '找不到角色或目标';
  const dist = Math.abs(rescuer.x - target.x) + Math.abs(rescuer.y - target.y);
  if (dist > ENGAGE_RANGE) return `救治要贴身（${dist} 格 > ${ENGAGE_RANGE}）`;
  if (target.corpse) return `${target.name} 已经死了，救不回来`; // 尸体不能治
  if (target.status?.label !== DYING_LABEL && !target.down && !target.status?.label.startsWith(ROBOT_LABEL)) return `${target.name} 不需要救治`;
  const pc = w.party.find((p) => p.id === pl.pcId);
  if (!canRescue(pc?.skills ?? [])) return '没有解锁急救 / 救治类技能，做不了急救（动作库 #119 救治）';
  const roll = opts.roll ?? 1 + Math.floor(Math.random() * 100);
  const r = rollRescue(roll);
  const actor = pc
    ? { kind: 'pc' as const, id: pc.id, name: rescuer.name }
    : { kind: 'npc' as const, id: rescuer.id, name: rescuer.name };
  const targetActor = target.pcId
    ? { kind: 'pc' as const, id: target.pcId, name: target.name }
    : { kind: 'npc' as const, id: target.id, name: target.name };
  const at = Date.now();
  if (!r.success) {
    update((d) => {
      appendEvent(d, newEvent(d, at, actor, { id: '119', name: '救治', source: '动作库' }, {
        target: targetActor,
        check: { kind: 'check', scale: 'd100', attrs: [], merge: 'single', total: roll, success: false, tier: null,
          outcome: '没救回来', rolledBy: 'host' },
        deltas: [],
        note: `救治失败（D100=${roll === 100 ? '000' : roll}）：${target.name} 还是没醒过来`,
      }));
    });
    setTr({ acted: { ...(t.acted ?? {}), [pl.tokenId]: true }, msg: `救治失败（D100=${roll === 100 ? '000' : roll}）：${target.name} 还是没醒过来` });
    return null;
  }
  let rescuedHp = RESCUED_HP;
  update((d) => {
    const dm = findMap(d, t.mapId)!;
    const dt = dm.tokens.find((x) => x.id === targetTokenId)!;
    const deltas: Delta[] = [];
    const oldLabel = dt.status?.label ?? (dt.down ? downedLabel('down') : null);
    let hpBefore = 0;
    let hpAfter = 1;
    if (dt.pcId) {
      const p = d.party.find((x) => x.id === dt.pcId);
      if (p) {
        hpBefore = p.hp ?? 0;
        hpAfter = Math.max(hpBefore, RESCUED_HP);
        p.hp = hpAfter;
      }
    } else {
      hpBefore = dt.hp ?? 0;
      hpAfter = Math.max(hpBefore, RESCUED_HP);
      dt.hp = hpAfter;
    }
    delete dt.status;
    delete dt.down;
    rescuedHp = hpAfter;
    if (hpBefore !== hpAfter) deltas.push({ kind: 'hp', id: dt.pcId ?? dt.id, name: dt.name, from: hpBefore, to: hpAfter });
    if (oldLabel !== null) deltas.push({ kind: 'status', id: dt.id, name: dt.name, from: oldLabel, to: null });
    appendEvent(d, newEvent(d, at, actor, { id: '119', name: '救治', source: '动作库' }, {
      target: targetActor,
      check: { kind: 'check', scale: 'd100', attrs: [], merge: 'single', total: roll, success: true, tier: r.crit ? 'crit' : null,
        outcome: r.crit ? '特大成功，救回来了' : '救回来了', rolledBy: 'host' },
      deltas,
      note: `救治成功（D100=${roll === 100 ? '000' : roll}${r.crit ? '，特大成功' : ''}）：${target.name} 被拉起来了，现在 ${hpAfter} HP`,
    }));
  });
  setTr({ acted: { ...(t.acted ?? {}), [pl.tokenId]: true }, msg: `救治成功（D100=${roll === 100 ? '000' : roll}${r.crit ? '，特大成功' : ''}）：${target.name} 被拉起来了，现在 ${rescuedHp} HP` });
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
  if (t.combat && actedOf(t, pl.tokenId)) return '这回合的行动点已经用掉了，按空格结束回合';
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

  setTr({ acted: t.combat ? { ...(t.acted ?? {}), [pl.tokenId]: true } : t.acted, sense: { kind, roll, hints: useful, at: Date.now() }, msg: describeSense(roll, pl.name) });
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
  if (mode === null) {
    setTr({ runMode: { ...(t.runMode ?? {}), [pl.tokenId]: null }, runTurns: { ...(t.runTurns ?? {}), [pl.tokenId]: 0 }, msg: '' });
    return null;
  }

  const spec = RUN_MODES[mode];
  // 作者口径：扣 ME 换跑法只能在本回合还没挪步的时候做，一旦动了这回合就只能走路。
  if ((t.moved?.[pl.tokenId] ?? 0) > 0) return '这回合已经动过了，只能走路';
  if (t.combat && spec.usesAction && actedOf(t, pl.tokenId)) return `【${spec.label}】要占行动点，这回合已经用掉了`;
  if (runMeShort(pc, spec)) return `ME 不够：【${spec.label}】要 ${spec.meCost} ME，现在只有 ${pc.me}`;

  if (spec.meCost > 0) {
    update((d) => { const p = d.party.find((x) => x.id === pl.pcId); if (p && p.me != null) p.me -= spec.meCost; });
  }
  setTr({
    runMode: { ...(t.runMode ?? {}), [pl.tokenId]: mode },
    runTurns: { ...(t.runTurns ?? {}), [pl.tokenId]: 0 },
    acted: t.combat && spec.usesAction ? { ...(t.acted ?? {}), [pl.tokenId]: true } : t.acted,
    msg: spec.usesAction ? `换【${spec.label}】` : '',
  });
  return null;
}

/**
 * 姿态：站、坐、蹲、躺、趴。
 *
 * 作者口径：
 * - 躺下基本丧失行动能力，要先用移动点翻身（躺→趴 75）或站起来（躺→站 150）
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
