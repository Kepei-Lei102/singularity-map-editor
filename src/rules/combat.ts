// 战斗：攻击结算、HP、濒死，以及战斗状态（流血/中毒/眩晕）。
//
// 规则出处（AI见证者知识库/02-核心规则.md）：
// - 攻击命中一律 D100；只要不是大失败（投 1）就命中；投 00（记作 100）＝特大成功，伤害 ×4。
// - 没有特殊说明的伤害 = 1D8。
// - HP 归零触发濒死结算，不直接死。
// - 1 回合 = 5 分钟；状态按回合倒计时，脱离战斗后换算成现实时间。
//
// 纯函数为主：结算不碰 store。真正改世界的只有 applyAttack / resolveRoundStart。

import { attrValue, ATTRS, tierOfRoll, type Attr } from './interaction';
import type { GameMap, Token, World } from '../core/types';

/** 默认伤害骰：没有特殊说明就是 1D8。 */
export const DEFAULT_DAMAGE_DIE = 8;
/** 默认攻击距离：周围 8 格（规则书「攻击距离为周围 8 格」）。 */
export const ATTACK_RANGE = 8;
/** 近战贴身距离：周围 4 格内一次移动只能走 1 格（这一条还没接进移动）。 */
export const CLOSE_RANGE = 4;
/** 濒死状态剩几回合不救就……现在只标状态，不推进死亡。 */
export const DYING_LABEL = '濒死';

/** 掷一颗骰（1..sides）。 */
export type Roller = (sides: number) => number;

/** 骰子落定后的结果。命中用 tierOfRoll({ attack: true })：只有 1 是大失败，100 是特大成功。 */
export interface AttackRoll {
  /** D100 点数，100 表示 00。 */
  roll: number;
  hit: boolean;
  /** 特大成功 = 伤害 ×4。 */
  crit: boolean;
  damageRoll: number;
  damage: number;
}

export function rollAttack(roll: number, damageDie = DEFAULT_DAMAGE_DIE, roller?: Roller): AttackRoll {
  const ext = tierOfRoll('d100', roll, undefined, { attack: true });
  const crit = ext.tier === 'crit';
  const hit = ext.tier !== 'fumble';
  const damageRoll = hit ? (roller ?? randomDie)(damageDie) : 0;
  return { roll, hit, crit, damageRoll, damage: hit ? damageRoll * (crit ? 4 : 1) : 0 };
}

/** 浏览器里的骰子：crypto 取随机。测试里传自己的 Roller。 */
export function randomDie(sides: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return 1 + (buf[0] % sides);
}

/** 攻击距离：按格距（4 向走格数）算，和移动同一套口径。 */
export function inAttackRange(a: { x: number; y: number }, b: { x: number; y: number }, range = ATTACK_RANGE): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= range;
}

/** 两个棋子之间隔着几格（曼哈顿距离）。 */
export function tokenDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** 区值：战斗判定用 D20 区（总属性 ÷5 向下取整）。 */
export function zoneOf(attributes: Record<string, number> | undefined, attr: Attr): number {
  return attrValue(attributes?.[attr] ?? 0, 'd20');
}

/** HP 上限：0.4×魅力 + 0.3×力量 + 0.2×敏捷 + 0.1×意志，六维用 D20 区值代入（规则书）。 */
export function hpMaxOf(attributes: Record<string, number> | undefined): number {
  if (!attributes) return 0;
  const z = (a: Attr) => zoneOf(attributes, a);
  return Math.max(1, Math.round(0.4 * z('魅力') + 0.3 * z('力量') + 0.2 * z('敏捷') + 0.1 * z('意志')));
}

/** 角色当前 HP：没填就按上限算满。 */
export function hpOf(pc: Pick<{ attributes?: Record<string, number>; hp?: number; hpMax?: number }, 'attributes' | 'hp' | 'hpMax'>): { hp: number; max: number } {
  const max = pc.hpMax ?? hpMaxOf(pc.attributes);
  return { hp: pc.hp ?? max, max };
}

/** 把伤害扣下去之后的新 HP：不低于 0，伤害取整、不为负。 */
export function applyDamage(current: number, damage: number): number {
  return Math.max(0, current - Math.max(0, Math.round(damage)));
}

/** 濒死判定：HP 归零就是濒死（作者：不自动死，标状态即可）。ME 归零走另一条（被驱逐），不在这里。 */
export function isDying(hp: number): boolean {
  return hp <= 0;
}

/** 战斗状态：流血 / 中毒 / 眩晕，各自在回合边界结算。 */
export type CombatCondition = '流血' | '中毒' | '眩晕';

/** 一个战斗状态的实例：挂在棋子身上，按回合倒计时。 */
export interface CombatEffect {
  label: CombatCondition;
  roundsLeft: number;
  /** 每回合的伤害（流血扣 HP、中毒扣 HP 或 ME，见 tickEffects）。 */
  perRound?: number;
  /** 中毒扣的是 ME 还是 HP。 */
  target?: 'hp' | 'me';
}

export interface RoundTick {
  tokenId: string;
  label: CombatCondition;
  amount: number;
  target: 'hp' | 'me';
  /** 这一跳之后状态是否结束。 */
  ends: boolean;
}

/** 回合边界结算：每个状态先扣一次，再把剩余回合减一。返回这一回合跳了多少。 */
export function tickEffects(effects: CombatEffect[]): { ticks: RoundTick[]; left: CombatEffect[] } {
  const ticks: RoundTick[] = [];
  const left: CombatEffect[] = [];
  for (const e of effects) {
    const amount = Math.max(0, Math.round(e.perRound ?? 0));
    ticks.push({ tokenId: '', label: e.label, amount, target: e.target ?? 'hp', ends: e.roundsLeft <= 1 });
    const next = e.roundsLeft - 1;
    if (next > 0) left.push({ ...e, roundsLeft: next });
  }
  return { ticks, left };
}

/** 状态在"回合"和"现实分钟"之间换算（1 回合 = 5 分钟，见 trial.ts 的 ROUND_MINUTES）。 */
export function effectsToMinutes(effects: CombatEffect[], roundMinutes: number): { label: CombatCondition; minutes: number; perRound?: number; target?: 'hp' | 'me' }[] {
  return effects.map((e) => ({ label: e.label, minutes: e.roundsLeft * roundMinutes, perRound: e.perRound, target: e.target }));
}

/** 结构化描述一次攻击，给骰子判定面板用（广播用）：命中与否、伤害多少。 */
export function describeAttack(actor: string, target: string, r: AttackRoll): string {
  if (!r.hit) return `${actor} 攻击 ${target}：D100=${fmt(r.roll)}，大失败，没打中。`;
  const dmg = r.crit ? `${r.damageRoll}×4=${r.damage}` : `${r.damage}`;
  return `${actor} 攻击 ${target}：D100=${fmt(r.roll)}${r.crit ? '（特大成功）' : ''}，伤害 ${dmg}。`;
}

/** 100 显示成 00（D100 的习惯写法）。 */
export function fmt(roll: number): string {
  return roll === 100 ? '00' : String(roll);
}

/** 一个棋子能不能被攻击：活着（没有濒死）、在攻击距离内、看得见（可选）。 */
export function canTarget(world: World, map: GameMap, attacker: Token, target: Token, visible: boolean, range = ATTACK_RANGE): { ok: boolean; reason?: string } {
  if (attacker.id === target.id) return { ok: false, reason: '不能打自己' };
  if (!world) return { ok: false, reason: '没有世界' };
  const hp = hpOfToken(world, target);
  if (hp <= 0) return { ok: false, reason: '目标已经濒死' };
  if (!inAttackRange(attacker, target, range)) return { ok: false, reason: `超出攻击距离（${tokenDistance(attacker, target)} 格 > ${range}）` };
  if (!visible) return { ok: false, reason: '看不见目标，不能攻击' };
  return { ok: true };
}

/** 棋子的 HP：绑在玩家角色身上的看角色，其余默认满血（NPC 默认不设上限，见规则书）。 */
export function hpOfToken(world: World, t: Token): number {
  if (!t.pcId) return Number.POSITIVE_INFINITY; // 敌人 HP 一般不设上限
  const pc = world.party.find((p) => p.id === t.pcId);
  return pc ? hpOf(pc).hp : Number.POSITIVE_INFINITY;
}

export { ATTRS };

/** 战斗面板要展示的一个可选目标。 */
export interface AttackTarget {
  tokenId: string;
  name: string;
  /** 是不是玩家队伍里的人（NPC 棋子 pcId 为空）。 */
  isPc: boolean;
  distance: number;
  hp: number | null; // null = 不设上限（NPC）
  inRange: boolean;
  visible: boolean;
  canHit: boolean;
  reason?: string;
}

/** 当前攻击者能看见、并且列出来的棋子：用于战斗面板的目标列表。 */
export function attackTargets(
  world: World,
  map: GameMap,
  attacker: Token,
  visibility: (t: Token) => boolean,
  opts: { range?: number } = {},
): AttackTarget[] {
  return map.tokens
    .filter((t) => t.id !== attacker.id)
    .map((t) => {
      const visible = visibility(t);
      const pc = t.pcId ? world.party.find((p) => p.id === t.pcId) : undefined;
      const hp = t.pcId ? (pc ? hpOf(pc).hp : null) : null;
      const dying = t.status?.label === '濒死';
      const check = dying ? { ok: false, reason: '目标已经濒死' } : canTarget(world, map, attacker, t, visible, opts.range);
      return {
        tokenId: t.id, name: t.name, isPc: !!t.pcId,
        distance: tokenDistance(attacker, t),
        hp, inRange: inAttackRange(attacker, t, opts.range ?? ATTACK_RANGE),
        visible, canHit: check.ok, reason: check.reason,
      };
    })
    .sort((a, b) => a.distance - b.distance);
}

// ---------- 借机攻击 ----------

/** 贴身范围：这个距离内往外挪会招来借机攻击（1–2 格）。 */
export const ENGAGE_RANGE = 2;
/** 一个棋子在别人回合里最多借机一次；轮到自己时重新亮起。 */
export function canOpportunityAttack(t: { opportunityUsed?: boolean }): boolean {
  return !t.opportunityUsed;
}

export interface OpportunityCheck {
  /** 从哪个位置往外挪。 */
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** 这一步之后距离变远了吗。 */
  leaving: boolean;
  /** 原本贴着的敌人 id。 */
  enemies: string[];
}

/**
 * 借机攻击的触发口径（作者 2026-11-07 澄清）：只认「贴身脱离」。
 * 已经贴在敌人身边（1–2 格），往外挪的那一步触发；在 8 格远端进出不管。
 * 规则书原文「进入敌方周围 8 格有逃避惩罚」不再按范围边界算。
 */
export function opportunityTriggers(from: { x: number; y: number }, to: { x: number; y: number }, enemies: { id: string; x: number; y: number }[]): OpportunityCheck {
  const before = enemies.filter((e) => tokenDistance(from, e) <= ENGAGE_RANGE);
  const staying = before.filter((e) => tokenDistance(to, e) <= ENGAGE_RANGE);
  return {
    from, to,
    leaving: before.length > 0 && staying.length < before.length,
    enemies: before.filter((e) => !staying.includes(e)).map((e) => e.id),
  };
}

/** 移动限制：在敌人周围 ENGAGE_RANGE 格内，一次只能挪 1 格。 */
export function stepLimitNear(from: { x: number; y: number }, enemies: { x: number; y: number }[]): number {
  return enemies.some((e) => tokenDistance(from, e) <= ENGAGE_RANGE) ? 1 : Number.POSITIVE_INFINITY;
}

// ---------- 救治 ----------

/** 救治是动作库 #119「救治」（医疗·调养，敏捷单属性），而不是任何技能都能用的。 */
export const RESCUE_ACTION = '救治';
/** 技能 / 动作里算是「急救或救治」的那几条：有其中之一才做得了救治。 */
export const RESCUE_GRANTS = ['011-9-102', '011-9-002', '011-9-201', '011-9-204', '009-9-104'] as const;

export interface RescueCheck {
  /** 这次救治成功了吗（敏捷 D100，大失败算失败）。 */
  roll: number;
  success: boolean;
  crit: boolean;
}

/**
 * 救治判定：敏捷 D100。规则书里没有专门的 DC（攻击以外不看 DC），
 * 所以照攻击口径走：投 1 是大失败（没救回来），投 00 是特大成功，其余算成功拉起。
 */
export function rollRescue(roll: number): RescueCheck {
  const ext = tierOfRoll('d100', roll, undefined, { attack: true });
  return { roll, success: ext.tier !== 'fumble', crit: ext.tier === 'crit' };
}

/** 这个人能不能救治别人：解锁了急救/救治相关技能才行。 */
export function canRescue(unlocked: readonly string[]): boolean {
  return RESCUE_GRANTS.some((id) => unlocked.includes(id));
}

/** 救治之后的人回到 1 HP，濒死/昏厥解除（"至少活过来"）。 */
export const RESCUED_HP = 1;

// ---------- 昏厥 / 濒死（钝器 vs 锐器） ----------

/**
 * HP 归零之后的走向（作者口径）：
 * - 钝器（拳头、棍子）：晕过去，躺在原地等战斗结束，不撕卡；
 * - 锐器：真的濒死，3 回合内没人救治就撕卡。
 */
export type Downed = 'down' | 'dying';

export function downedBy(sharp: boolean): Downed {
  return sharp ? 'dying' : 'down';
}

/** 锐器濒死给几回合抢救时间。 */
export const DYING_ROUNDS = 3;

/** HP 归零时的状态标签。 */
export function downedLabel(kind: Downed): string {
  return kind === 'dying' ? '濒死' : '昏厥';
}

/**
 * 攻击能不能勾「锐器」：攻击者身上带锐器才给这个选项。
 * 不带锐器的人默认用钝器，勾不了。
 */
export function canUseSharp(attacker: { sharp?: boolean } | null | undefined): boolean {
  return !!attacker?.sharp;
}
