// 物理互动：把「动作 → 检定 → 状态转移 → 派生约束」串成一条记录。
//
// 三层，各管一件事：
//   声明层：ActionDef（动作卡，数据；对应《动作库 V2.1.1》的 186 个动作）
//   结算层：resolve()（纯函数，只吃 骰点/属性/模式，吐 成败与档位）
//   施加层：applyTransitions()（只写 object.state，不写逻辑）
// 派生层不在这里：挡路/挡视线已经由 perception.blocksMovement() 从 state 现算，
// 所以"门关了就走不过去"这句不需要任何代码——改完 state，通行自己变。

import type { GameMap, Tier } from '../core/types';

/**
 * 六维＋【幸运】。动作库里有动作的判定依据用到【幸运】（【教唆】【隐匿】），
 * 但六维表里没有它，所以单列出来，落卡时要么补第七项来源，要么给映射规则。
 */
export type Attr = '力量' | '敏捷' | '意志' | '观察' | '智慧' | '魅力' | '幸运';
export const ATTRS: Attr[] = ['力量', '敏捷', '意志', '观察', '智慧', '魅力'];
/** 六维之外的判定属性。 */
export const EXTRA_ATTRS: Attr[] = ['幸运'];

/**
 * 判定模式。与动作库的「判定口径」一一对应：
 *   single   单属性
 *   or       并集（或）——任一项过就算过
 *   and      交集（与）——每项都得过
 *   sum      交集（三检定叠加）——各项加值合计过 DC（如【涉水】）
 *   contest  双方对照检定——拼点（如【决斗】魅力拼对方意志）
 *   situational 视环境（与或并存）——见证者当场选走"或"还是"与"
 *   gm       仅见证者裁决——不掷骰，由见证者定
 */
export type CheckMode = 'single' | 'or' | 'and' | 'sum' | 'situational' | 'contest' | 'gm';

export interface CheckSpec {
  attributes: Attr[];            // 发起方属性
  mode: CheckMode;
  opponentAttributes?: Attr[];   // mode=contest 时，对方拿哪几项拼
}

/** 优势／劣势检定：掷两次取高／取低。《规则书》【优势检定】【劣势检定】。 */
export type Advantage = 'normal' | 'advantage' | 'disadvantage';

/** 检定尺。D20 区：总属性÷5 向下取整；D100 区：直接用总属性。 */
export type Scale = 'd20' | 'd100';

/** 默认 DC：D20 区 20，D100 区 100（规则书【判定难度】）。 */
export const DEFAULT_DC: Record<Scale, number> = { d20: 20, d100: 100 };

export function attrValue(total: number, scale: Scale = 'd20'): number {
  return scale === 'd100' ? Math.floor(total) : Math.floor(total / 5);
}

/**
 * 最终 DC。《规则书》【判定难度】：默认 20（D100 区 100）；
 * 与智慧个体交互时，最终 DC = 默认 DC −（A 的对应属性 − B 的对应属性），两边都用区值。
 * 例：A 魅力 13、B 魅力 12 → DC 19，A 需骰点 ≥ 6。
 */
export function finalDC(opts: { base?: number; actorValue: number; targetValue?: number; opposed?: boolean; scale?: Scale }): number {
  const base = opts.base ?? DEFAULT_DC[opts.scale ?? 'd20'];
  if (!opts.opposed || opts.targetValue === undefined) return base;
  return base - (opts.actorValue - opts.targetValue);
}

/** 优势阈值：D20 属性差 ≥4、D100 属性差 ≥20 时，优势方拿【优势检定】、劣势方拿【劣势检定】。 */
export function advantageThreshold(scale: Scale): number {
  return scale === 'd100' ? 20 : 4;
}

/** 按属性差给两边分优势／劣势。差不到阈值就都掷一颗。 */
export function sideAdvantage(scale: Scale, actorValue: number, targetValue: number): { actor: Advantage; target: Advantage } {
  const diff = actorValue - targetValue;
  const t = advantageThreshold(scale);
  if (diff >= t) return { actor: 'advantage', target: 'disadvantage' };
  if (diff <= -t) return { actor: 'disadvantage', target: 'advantage' };
  return { actor: 'normal', target: 'normal' };
}

/**
 * 【幸运】检定：纯骰，不套 DC、不加属性、不加调整值，也不触发 000 特殊链。
 * D20：1–10 失败，11–20 成功。D100：1–50 失败，51–000 成功。
 */
export function luckThreshold(scale: Scale): number {
  return scale === 'd100' ? 51 : 11;
}

export function resolveLuck(roll: number, scale: Scale = 'd20'): { success: boolean } {
  return { success: roll >= luckThreshold(scale) };
}

/** 优势取高、劣势取低。normal 时给一颗。 */
export function pickRoll(rolls: number[], advantage: Advantage = 'normal'): number {
  if (advantage === 'advantage') return Math.max(...rolls);
  if (advantage === 'disadvantage') return Math.min(...rolls);
  return rolls[0];
}

/**
 * 一次检定的结果。判定口径只有这一套，所有模块都走它：
 * 骰点 ＋ 属性值 达到 DC（≥）就算过。D20 区：值 = 属性÷5、骰 D20、DC 20；
 * D100 区：值 = 属性、骰 D100、DC 100。优势取高、劣势取低。
 * 极值覆盖总数：D20 掷 20 必过、掷 1 必不过（D100 区走 000 补投链）。
 */
export interface AttributeCheck {
  scale: Scale;
  attr: string;
  /** 采信的点数（优势/劣势已经挑好）。 */
  rolls: number[];
  used: number;
  /** 属性值（D20 区是区值）＋主动调整值。 */
  value: number;
  /** 主动调整值（临时加值），默认 0。 */
  adjust: number;
  dc: number;
  total: number;
  success: boolean;
  /** 骰面极值定的档；null = 不是极值，按总数判。 */
  tier: Tier | null;
  level: CritLevel;
  mode: Advantage;
}

/**
 * 一次属性判定的唯一入口。各模块只管「过哪颗骰、哪项属性」，不算自己的门槛。
 */
export function resolveCheck(opts: {
  attributes?: Record<string, number>;
  attr: string;
  rolls: number[];
  scale?: Scale;
  dc?: number;
  mode?: Advantage;
  /** 主动调整值：见证者当场给的临时加值，默认 0。 */
  adjust?: number;
  /** 攻击那套：000 特大成功、1–5 落空、95–99 大成功。 */
  attack?: boolean;
}): AttributeCheck {
  const scale = opts.scale ?? 'd20';
  const sides = scale === 'd20' ? 20 : 100;
  const rolls = opts.rolls.length ? opts.rolls.map((v) => Math.max(1, Math.min(sides, Math.round(v)))) : [1];
  const mode = opts.mode ?? 'normal';
  const used = pickRoll(rolls, mode);
  const adjust = opts.adjust ?? 0;
  const value = attrValue(opts.attributes?.[opts.attr] ?? 0, scale) + adjust;
  const dc = opts.dc ?? DEFAULT_DC[scale];
  const total = value + used;
  const ext = tierOfRoll(scale, used, undefined, opts.attack ? { attack: true } : undefined);
  // 极值只作用于自己那一项：掷 20 直接算过，掷 1 直接算不过，其余按总数对 DC。
  const success = ext.tier === 'crit' ? true : ext.tier === 'fumble' ? false : total >= dc;
  return { scale, attr: opts.attr, rolls, used, value, adjust, dc, total, success, tier: ext.tier, level: ext.level, mode };
}

/** 骰面优劣势：只决定「骰两次取高／取低」，跟多属性合并没关系。 */
export type DiceMode = 'single' | 'advantage' | 'disadvantage';

/** 多属性合并：或 = 过一个就好；与／和 = 都要过。单项就写 single。 */
export type MergeMode = 'single' | 'any' | 'all';

/** 一项属性：过哪项，以及它自己那颗骰有没有优劣势。 */
export interface AttrSpec {
  attr: string;
  /**
   * 这项自己的骰。作者口径：优劣势是按属性挂的——
   * 「一段时间内魅力检定有优势」要过魅力＋智慧时，魅力掷两次取高，智慧只掷一次。
   */
  dice?: DiceMode;
}

/** 一次判定的完整描述。各模块只拼这个，不算自己的门槛。 */
export interface JudgeSpec {
  attrs: AttrSpec[];
  scale?: Scale;
  /** 不写就按属性项数：1 项 single，多项 all。 */
  merge?: MergeMode;
  dc?: number;
  adjust?: number;
}

export function mergeModeOf(spec: JudgeSpec): MergeMode {
  return spec.merge ?? (spec.attrs.length > 1 ? 'all' : 'single');
}

/** 这项属性要掷几颗骰。 */
export function diceCountOf(a: AttrSpec): number {
  return a.dice && a.dice !== 'single' ? 2 : 1;
}

/** 按 spec 掷骰，返回和 attrs 对齐的点数组。 */
export function rollSpec(spec: JudgeSpec, roller: (sides: number) => number): number[][] {
  const sides = (spec.scale ?? 'd20') === 'd20' ? 20 : 100;
  return spec.attrs.map((a) => Array.from({ length: diceCountOf(a) }, () => roller(sides)));
}

/**
 * 按「或／与」把多项属性合成一个成败。
 * 极值只作用于自己那一项：一项掷 1 只判死自己，另一项过了，「或」照样算过。
 */
export function resolveChecks(
  spec: JudgeSpec,
  attributes: Record<string, number> | undefined,
  rolls: number[][],
): { checks: AttributeCheck[]; success: boolean; tier: Tier } {
  const scale = spec.scale ?? 'd20';
  const dc = spec.dc ?? DEFAULT_DC[scale];
  const merge = mergeModeOf(spec);
  const checks = spec.attrs.map((a, i) => resolveCheck({
    attributes, attr: a.attr, rolls: rolls[i] ?? [], scale, dc,
    mode: a.dice === 'advantage' || a.dice === 'disadvantage' ? a.dice : 'normal',
    adjust: spec.adjust,
  }));
  const success = checks.length === 0 ? false
    : merge === 'any' ? checks.some((c) => c.success)
      : merge === 'all' ? checks.every((c) => c.success)
        : checks[0].success;
  const tier: Tier = !success
    ? (checks.some((c) => c.tier === 'fumble') ? 'fumble' : 'fail')
    : (checks.every((c) => c.tier === 'crit') ? 'crit' : 'success');
  return { checks, success, tier };
}

export type CritLevel = 'normal' | '特大' | null;

/**
 * 骰面极值定档。
 *   D20 区：只有 20 是大成功、1 是大失败，没有补投。
 *   D100 区：只有 000 触发补投 D20——1 特大失败，2–10 大失败，11–19 大成功，20 特大成功。
 * 返回 tier=null 表示"不是极值，按总数判"。
 */
export function tierOfRoll(
  scale: Scale,
  roll: number,
  critRoll?: number,
  opts?: { attack?: boolean },
): { tier: Tier | null; level: CritLevel } {
  // 攻击一律 D100：000 特大成功、1–5 落空、95–99 大成功、其余命中。
  if (opts?.attack) {
    if (roll === 100) return { tier: 'crit', level: '特大' };
    if (roll <= 5) return { tier: 'fumble', level: 'normal' };
    if (roll >= 95) return { tier: 'crit', level: 'normal' };
    return { tier: null, level: null };
  }
  if (scale === 'd20') {
    if (roll === 20) return { tier: 'crit', level: 'normal' };
    if (roll === 1) return { tier: 'fumble', level: 'normal' };
    return { tier: null, level: null };
  }
  // D100：000 记作 100
  if (roll !== 100) return { tier: null, level: null };
  if (critRoll === undefined) return { tier: null, level: null };
  if (critRoll === 1) return { tier: 'fumble', level: '特大' };
  if (critRoll <= 10) return { tier: 'fumble', level: 'normal' };
  if (critRoll >= 11 && critRoll < 20) return { tier: 'crit', level: 'normal' };
  if (critRoll === 20) return { tier: 'crit', level: '特大' };
  return { tier: null, level: null };
}

export interface AttrRoll {
  attr: Attr;
  value: number;  // 该属性区值
  target?: number; // 对手同属性区值（对抗时才有）
  rolls: number[]; // 掷了几颗（优势/劣势两颗）
  roll: number;   // 采用的那颗
  dc: number;
  total: number;  // value + roll + adjust
  pass: boolean;
}

export interface ResolveInput {
  check: CheckSpec;
  /** mode=situational 时见证者当场选的那一种，默认 'or'。 */
  situationalMode?: 'or' | 'and';
  actor: Record<Attr, number>;
  /** 与智慧个体交互时给目标的六维：DC 按 20−（A−B）修正，并按属性差分优势／劣势。 */
  target?: Record<Attr, number>;
  /** 攻击命中：掷 00 即特大成功。 */
  attack?: boolean;
  /**
   * 这个角色用过这个动作几次（从 0 起算）：前 N 次劣势，超过 N2 次之后加值。
   * 计数**绑在角色身上**，不是动作全局——同一个动作，A 用得多不影响 B。
   */
  uses?: number;
  usage?: ActionUsage;
  d20s?: number[][];     // 每个属性一组骰点；优势/劣势给两颗
  advantage?: Advantage;
  adjust?: number;       // 主动调整值＝临时加值，默认 0（见证者慎用）
  scale?: Scale;
  baseDC?: number;
}

export interface CheckResult {
  rolls: AttrRoll[];
  /** null = 交给见证者裁决（mode=gm）。 */
  success: boolean | null;
  tier: Tier | null;
  level: CritLevel;
  adjust: number;
}

/** 结算。纯函数：不碰 store，不改世界。 */
export function resolve(input: ResolveInput): CheckResult {
  const scale = input.scale ?? 'd20';
  const uses = input.uses ?? 0;
  const usage = input.usage;
  // 带计数的动作：前 N 次强制劣势；用够次数之后给固定加值（D20 +2／D100 +10，以规则书原话为准）。
  const usageAdjust = usage && uses >= usage.bonusAfter.uses
    ? (scale === 'd100' ? usage.bonusAfter.d100 : usage.bonusAfter.d20)
    : 0;
  const forcedDisadvantage = !!usage && uses < usage.disadvantageFirst;
  const adjust = (input.adjust ?? 0) + usageAdjust;
  const baseDC = input.baseDC ?? DEFAULT_DC[scale];
  const opposed = input.target !== undefined;

  if (input.check.mode === 'gm') return { rolls: [], success: null, tier: null, level: null, adjust };

  const critRoll = input.d20s?.[0]?.[1];
  const rolls: AttrRoll[] = input.check.attributes.map((attr, i) => {
    const value = attrValue(input.actor[attr], scale);
    const targetValue = opposed ? attrValue(input.target![attr], scale) : undefined;
    const dc = finalDC({ base: baseDC, actorValue: value, targetValue, opposed, scale });
    // 【幸运】不套 DC：只看骰面。属性、调整值都不参与。
    if (attr === '幸运') {
      const thrownLuck = input.d20s?.[i] ?? [];
      const luckRoll = pickRoll(thrownLuck, input.advantage ?? 'normal');
      return { attr, value, target: targetValue, rolls: thrownLuck, roll: luckRoll, dc: luckThreshold(scale), total: luckRoll, pass: luckRoll >= luckThreshold(scale) };
    }
    // 对抗时按属性差给优势／劣势；非对抗时沿用调用方给的 advantage
    const adv = forcedDisadvantage
      ? 'disadvantage'
      : opposed ? sideAdvantage(scale, value, targetValue!).actor : (input.advantage ?? 'normal');
    const thrown = input.d20s?.[i] ?? [];
    const roll = pickRoll(thrown, adv);
    const total = value + roll + adjust;
    const ext = tierOfRoll(scale, roll, critRoll, { attack: input.attack });
    // 极值只作用于它自己那一项：20 直接算过，1 直接算不过；其余按总数对 DC
    const pass = ext.tier === 'crit' ? true : ext.tier === 'fumble' ? false : total >= dc;
    return { attr, value, target: targetValue, rolls: thrown, roll, dc, total, pass };
  });

  // 【幸运】不参与极值判定：掷 20／000 都不产生大成功，掷 1 也不产生大失败。
  const judged = rolls.filter((r) => r.attr !== '幸运');
  const crit = judged.find((r) => tierOfRoll(scale, r.roll, critRoll, { attack: input.attack }).tier === 'crit');
  const fumbles = judged.filter((r) => tierOfRoll(scale, r.roll, critRoll, { attack: input.attack }).tier === 'fumble');

  let success: boolean;
  switch (input.check.mode) {
    case 'single': success = rolls[0].pass; break;
    case 'or': success = rolls.some((r) => r.pass); break;
    case 'and': success = rolls.every((r) => r.pass); break;
    case 'situational': success = (input.situationalMode ?? 'or') === 'and'
      ? rolls.every((r) => r.pass)
      : rolls.some((r) => r.pass); break;
    // 「和」：各项加值合计过 DC（规则书 C）。作者对【涉水】的口径是"分别过 20、失败一个就失败"，用 and。
    case 'sum': success = rolls.reduce((s, r) => s + r.total, 0) >= baseDC; break;
    default: success = false;
  }
  if (crit) success = true;

  let tier: Tier;
  let level: CritLevel = null;
  if (crit) { tier = 'crit'; level = tierOfRoll(scale, crit.roll, critRoll, { attack: input.attack }).level; }
  else if (!success && fumbles.length) { tier = 'fumble'; level = tierOfRoll(scale, fumbles[0].roll, critRoll, { attack: input.attack }).level; }
  else tier = success ? 'success' : 'fail';

  return { rolls, success, tier, level, adjust };
}

// —— 拼点（双方对照检定）——

export interface ContestInput {
  actorValue: number;
  actorRoll: number;
  targetValue: number;
  targetRoll: number;
  adjust?: number;
}

export interface ContestResult {
  actorTotal: number;
  targetTotal: number;
  success: boolean | null;  // null = 平手，动作不成立（守方守住）
}

/** 智慧个体之间不套 DC，直接拼点：区值＋骰点，高者赢。平手算没做成。 */
export function resolveContest(input: ContestInput): ContestResult {
  const adjust = input.adjust ?? 0;
  const actorTotal = input.actorValue + input.actorRoll + adjust;
  const targetTotal = input.targetValue + input.targetRoll;
  if (actorTotal === targetTotal) return { actorTotal, targetTotal, success: null };
  return { actorTotal, targetTotal, success: actorTotal > targetTotal };
}

/** 按来源技能取判定口径；没给来源就用动作卡自己的 check。 */
export function checkForSource(def: ActionDef, skillId?: string): CheckSpec {
  const hit = skillId ? def.sources?.find((s) => s.skillId === skillId) : undefined;
  return hit ? { attributes: hit.attributes, mode: hit.mode } : def.check;
}

// —— 状态转移 ——

export interface StateTransition {
  mapId: string;
  objectId: string;
  from: number;
  to: number;
  rev: number;
}

/** 效果模板：只允许指向"目标"物件，不允许写条件。 */
export interface EffectTemplate {
  ref: 'target' | 'cell';
  toState: number;
}

/** 动作卡。四档各给一组状态转移，代码里没有 if。 */
/** ME 消耗的写法。《技能表》里出现过六种形态，必须编码，不能当数字读。 */
export type MeCost =
  | number
  | { perTurn: number }
  | { increment: number }
  | { also: string; amount: number }
  | { offline: true }
  | 'passive'
  | 'none';

/**
 * 动作成本。《规则书》：每回合 1 行动点；【攻击】【主动技能使用】【严肃交流】各吃 1 点；
 * 带【无行动点消耗】标签的不吃；【每回合限X】【回合外发动】是标签不是成本。
 * 《动作库》：原始动作（白卡默认）不使用 ME；技能携带的动作默认 1 点 ME。
 */
export interface ActionCost {
  me?: MeCost;
  actions?: number;
  tags?: string[];
}

/** 多来源不同：同一个动作，不同来源技能给不同属性／口径，运行时按角色已解锁来源取。 */
export interface ActionSource {
  skillId: string;
  attributes: Attr[];
  mode: CheckMode;
}

/**
 * 带计数的判定。动作库原文：前 3 次使用为劣势检定；正常使用 7 次后 +2（D20）／+10（D100）。
 * 不是静态口径，必须记使用次数。
 */
export interface ActionUsage {
  disadvantageFirst: number;
  bonusAfter: { uses: number; d20: number; d100: number };
}

export interface ActionDef {
  id: string;
  name: string;
  category: string;
  check: CheckSpec;
  /** 多来源不同时给来源表；取哪一条由角色已解锁技能决定。 */
  sources?: ActionSource[];
  /** 原始动作＝白卡默认（0 ME）；技能动作＝默认 1 ME。 */
  source?: 'primitive' | 'skill';
  /** 检定尺。战斗命中类一律 D100，其余按区域走。 */
  scale?: Scale;
  /** 攻击命中：D100 掷到 00 直接特大成功、伤害×4，不走补投链。 */
  attack?: boolean;
  cost?: ActionCost;
  usage?: ActionUsage;
  preconditions?: Precondition[];
  range?: ActionRange;
  outcomes: Partial<Record<Tier, EffectTemplate[]>>;
  /** 状态表达不了的动作，挂执行器；不写就只走状态表。 */
  executor?: 'push' | 'climb' | 'drag' | 'throw';
}

/** ME 的实际扣法：原始动作 0；动作卡写了就按卡的；否则按技能表，技能表没写就 1。 */
export function meCost(def: ActionDef, skillME?: MeCost): MeCost {
  if (def.source === 'primitive') return 0;
  if (def.cost?.me !== undefined) return def.cost.me;
  return skillME ?? 1;
}

/** 按档位取效果。没给这一档就是"什么都没发生"。 */
export function planEffects(def: ActionDef, tier: Tier): EffectTemplate[] {
  return def.outcomes[tier] ?? [];
}

/** 施加。只改 state 与 stateRev——联动交给派生层现算。 */
// ---- 三种效果面（C 方案）：物理改世界、信息改「谁知道什么」、心理留形状 ----
//
// 分层不是「动作归类」，而是「效果往哪里写」：同一个动作可以同时产出物理和信息效果
// （摸墙：触感是信息，推它是物理）。心理层只留类型，不实现。

export type EffectKind = 'state' | 'knowledge' | 'attitude';

/** 信息效果：不碰地图状态，只写「谁发现了哪个秘密」。 */
export interface KnowledgeEffect {
  kind: 'knowledge';
  mapId: string;
  objectId: string;
  secretId: string;
  to: string[]; // 接收角色 id
  tier: Tier;
  at?: number;
}

/** 心理效果：预留给态度/情绪，现在不实现。 */
export interface AttitudeEffect {
  kind: 'attitude';
  npcId: string;
  from?: number;
  to: number;
  label?: string;
}

export type AnyEffect = StateTransition | KnowledgeEffect | AttitudeEffect;

export const effectKind = (e: AnyEffect): EffectKind => (e as { kind?: EffectKind }).kind ?? 'state';

/** 信息效果：把发现记到物件的秘密上（按角色存，不随换组转发）。返回写了几条。 */
export function applyKnowledge(map: GameMap, effects: AnyEffect[]): number {
  let n = 0;
  for (const e of effects) {
    if (effectKind(e) !== 'knowledge') continue;
    const k = e as KnowledgeEffect;
    if (k.mapId !== map.id) continue;
    const o = map.objects.find((x) => x.id === k.objectId);
    const secret = o?.secrets.find((x) => x.id === k.secretId);
    if (!secret) continue;
    secret.discoveries ??= {};
    for (const id of k.to) secret.discoveries[id] = { tier: k.tier, at: k.at ?? Date.now() };
    n++;
  }
  return n;
}

/** 施加层：只处理物理效果；信息效果走 applyKnowledge()，心理效果暂不处理。 */
export function applyTransitions(map: GameMap, transitions: AnyEffect[]): void {
  for (const t of transitions) {
    if (effectKind(t) !== 'state') continue;
    const st = t as StateTransition;
    if (st.mapId !== map.id) continue;
    {
      const o = map.objects.find((x) => x.id === st.objectId);
      if (!o) continue;
      o.state = st.to;
      o.stateRev = (o.stateRev ?? 0) + 1;
      st.rev = o.stateRev;
    }
  }
}


/** 从模板算出具体转移（读当前 state 得到 from）。 */
export function materialize(map: GameMap, templates: EffectTemplate[], targetObjectId: string): StateTransition[] {
  const out: StateTransition[] = [];
  for (const t of templates) {
    const id = t.ref === 'target' ? targetObjectId : undefined;
    if (!id) continue;
    const o = map.objects.find((x) => x.id === id);
    if (!o) continue;
    out.push({ mapId: map.id, objectId: id, from: o.state, to: t.toState, rev: o.stateRev ?? 0 });
  }
  return out;
}

// —— 动作 × 模组内物件：效果映射 ——
//
// 同一条【砸】，落在橡皮泥和非牛顿流体上不是一回事。所以效果分两级：
//   动作卡给默认表（动作库）→ 物件档案可以整档替换（模组自己写）
// 覆盖是"整档替换"，不是合并：换就要换清楚，别指望叠加。

export interface ObjectProfile {
  id: string;
  name: string;
  material?: string;   // 玻璃 / 木头 / 橡皮泥 / 非牛顿流体 …
  tags?: string[];     // 自定义标签：可破坏、可点燃、精密 …
}

export interface OutcomeOverride {
  actionId: string;
  match: { material?: string; tag?: string };
  outcomes: Partial<Record<Tier, EffectTemplate[]>>;
}

/** 取效果：先看物件档案有没有整档覆盖，没有就用动作卡默认表。 */
export function resolveOutcomes(
  def: ActionDef,
  tier: Tier,
  profile?: ObjectProfile,
  overrides: OutcomeOverride[] = [],
): EffectTemplate[] {
  if (profile) {
    const hit = overrides.find((o) =>
      o.actionId === def.id &&
      ((o.match.material !== undefined && o.match.material === profile.material) ||
        (o.match.tag !== undefined && (profile.tags ?? []).includes(o.match.tag))),
    );
    if (hit) return hit.outcomes[tier] ?? [];
  }
  return def.outcomes[tier] ?? [];
}

// —— 现挂：见证者当场加的效果 ——
//
// 大失败该罚多重要看情境，预置表覆盖不到。这时通过 AI 对话生成的是**受限效果**，不是代码：
// 只允许改状态、挪位置、开关物件、给人挂状态。全部走同一条审核通道（Host 看过才生效），
// 因为要能撤销（from/to）、能回放（log）、能同步给玩家窗口。

export type AdHocEffect =
  | { kind: 'object-state'; mapId: string; objectId: string; toState: number; reason: string }
  | { kind: 'object-move'; mapId: string; objectId: string; x: number; y: number; reason: string }
  | { kind: 'object-enable'; mapId: string; objectId: string; enabled: boolean; reason: string }
  | { kind: 'token-status'; mapId: string; tokenId: string; label: string; reason: string };

const ADHOC_KEYS: Record<AdHocEffect['kind'], string[]> = {
  'object-state': ['kind', 'mapId', 'objectId', 'toState', 'reason'],
  'object-move': ['kind', 'mapId', 'objectId', 'x', 'y', 'reason'],
  'object-enable': ['kind', 'mapId', 'objectId', 'enabled', 'reason'],
  'token-status': ['kind', 'mapId', 'tokenId', 'label', 'reason'],
};

/** 白名单校验。不合规返回 null——宁可不生效，也不执行没见过的字段。 */
export function parseAdHoc(raw: unknown): AdHocEffect | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind as AdHocEffect['kind'];
  const keys = ADHOC_KEYS[kind];
  if (!keys) return null;
  if (Object.keys(r).length !== keys.length || !keys.every((k) => k in r)) return null;
  const str = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200;
  if (!str(r.mapId) || !str(r.reason)) return null;
  if (kind === 'object-state') {
    if (!str(r.objectId) || !Number.isInteger(r.toState) || (r.toState as number) < 0) return null;
    return { kind, mapId: r.mapId, objectId: r.objectId, toState: r.toState as number, reason: r.reason };
  }
  if (kind === 'object-move') {
    if (!str(r.objectId) || !Number.isInteger(r.x) || !Number.isInteger(r.y)) return null;
    return { kind, mapId: r.mapId, objectId: r.objectId, x: r.x as number, y: r.y as number, reason: r.reason };
  }
  if (kind === 'object-enable') {
    if (!str(r.objectId) || typeof r.enabled !== 'boolean') return null;
    return { kind, mapId: r.mapId, objectId: r.objectId, enabled: r.enabled, reason: r.reason };
  }
  if (!str(r.tokenId) || !str(r.label)) return null;
  return { kind, mapId: r.mapId, tokenId: r.tokenId, label: r.label, reason: r.reason };
}

/** 施加现挂效果。状态改动同样自增 stateRev，撤销与回放沿用现有机制。 */
export function applyAdHoc(map: GameMap, effects: AdHocEffect[]): void {
  for (const e of effects) {
    if (e.mapId !== map.id) continue;
    if (e.kind === 'token-status') {
      const t = map.tokens.find((x) => x.id === e.tokenId);
      if (t) t.status = { label: e.label };
      continue;
    }
    const o = map.objects.find((x) => x.id === e.objectId);
    if (!o) continue;
    if (e.kind === 'object-state') { o.state = e.toState; o.stateRev = (o.stateRev ?? 0) + 1; }
    else if (e.kind === 'object-move') { o.x = e.x; o.y = e.y; }
    else o.enabled = e.enabled;
  }
}

// —— 前置条件与范围 ——
//
// 动作库只有「动作释义」，没有前置条件栏。但【点火】原文就带前提（目标满足易燃物属性、
// 默认拥有者带安全打火机），【撬锁】【开锁】也各有锁具前提。所以卡上单列，不让见证者现记。

export type Precondition =
  | { kind: 'targetHasProp'; prop: string }           // 易燃物、物理锁具、电子锁具 …
  | { kind: 'targetStateIn'; states: number[] }       // 只在某些状态成立
  | { kind: 'targetEnabled' }                         // 物件没有被禁用
  | { kind: 'withinRange'; cells: number }            // 目标在几格内
  | { kind: 'actorHas'; tag: string };                // 有打火机之类

export interface ActionRange {
  cells: number;
  shape: 'self' | 'single' | 'line' | 'cone' | 'area';
  targetLimit?: number;                               // 最多几个目标
}

export interface PreconditionContext {
  /** 目标的属性标签（易燃物、物理锁具…）。 */
  targetProps?: string[];
  targetState?: number;
  targetEnabled?: boolean;
  /** 发起者到目标的格数（圆形距离）。 */
  distance?: number;
  actorTags?: string[];
}

export interface PreconditionResult {
  ok: boolean;
  unmet: Precondition[];
}

/** 纯校验：只报哪些前提没满足，不改世界、不掷骰。 */
export function checkPreconditions(def: ActionDef, ctx: PreconditionContext): PreconditionResult {
  const unmet: Precondition[] = [];
  for (const p of def.preconditions ?? []) {
    const has = (() => {
      switch (p.kind) {
        case 'targetHasProp': return (ctx.targetProps ?? []).includes(p.prop);
        case 'targetStateIn': return ctx.targetState !== undefined && p.states.includes(ctx.targetState);
        case 'targetEnabled': return ctx.targetEnabled !== false;
        case 'withinRange': return ctx.distance !== undefined && ctx.distance <= p.cells;
        case 'actorHas': return (ctx.actorTags ?? []).includes(p.tag);
      }
    })();
    if (!has) unmet.push(p);
  }
  return { ok: unmet.length === 0, unmet };
}

/** 一句话描述没满足的前提，给见证者看。 */
export function describeUnmet(unmet: Precondition[]): string {
  return unmet.map((p) => {
    switch (p.kind) {
      case 'targetHasProp': return `目标不是「${p.prop}」`;
      case 'targetStateIn': return `目标不在这些状态：${p.states.join('、')}`;
      case 'targetEnabled': return '目标已被关掉';
      case 'withinRange': return `目标不在 ${p.cells} 格内`;
      case 'actorHas': return `发起者没有「${p.tag}」`;
    }
  }).join('；');
}
