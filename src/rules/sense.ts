// 感知动作（观察／搜索／嗅闻／倾听）的骨架，以及一条给建议的接口。
//
// 作者定的口径：
// - 这四个都要掷骰。【观察】【嗅闻】【倾听】掷观察；
//   【搜索】掷两次（敏捷一次、观察一次），两个都过才算成功。
// - 掷完之后给什么信息，现在由见证者现场写。
// - 以后 secrets 要计入因果图，那时可以自动给出候选。
//
// 所以这里把「给建议」抽成 SenseAdvisor 接口：
// 现在的实现是规则版（从物件的 secrets 里挑），
// 以后换成本地模型或者因果图，只换实现，调用方一行都不用改。
import type { GameMap, MapObject, PC, Secret, Tier } from '../core/types';
import { attrValue, resolveChecks, rollSpec, type JudgeSpec } from './interaction';

/** 感知动作的四种。 */
export type SenseKind = 'observe' | 'search' | 'smell' | 'listen';

export const SENSE_LABEL: Record<SenseKind, string> = {
  observe: '观察',
  search: '搜索',
  smell: '嗅闻',
  listen: '倾听',
};

/**
 * 每个感知动作要过什么。只写「哪项属性、怎么合并」，
 * 骰面优劣势挂在每项属性自己的 dice 上，判定口径在 interaction.resolveChecks()。
 */
export const SENSE_SPECS: Record<SenseKind, JudgeSpec> = {
  observe: { attrs: [{ attr: '观察' }] },
  // 搜索＝「与 2 项」：敏捷、观察各掷一颗，都要过。
  search: { attrs: [{ attr: '敏捷' }, { attr: '观察' }], merge: 'all' },
  smell: { attrs: [{ attr: '观察' }] },
  listen: { attrs: [{ attr: '观察' }] },
};

/** 默认骰：D20 区掷 1..20。 */
const defaultRoll = (sides: number) => 1 + Math.floor(Math.random() * sides);

/**
 * 一次感知判定的结果。
 * 每项属性各掷自己的骰；按「或／与」合并成一个成败。
 */
export interface SenseRoll {
  kind: SenseKind;
  rolls: { attr: string; value: number; zone: number; success: boolean; crit: boolean; fumble: boolean }[];
  success: boolean;
  /** 整体档位：全部大成功才 crit，任一失败就是 fail。 */
  tier: Tier;
}

/**
 * 属性值取区值：÷5 向下取整（D20 区）。
 * 判定口径：骰 D20 ＋ 区值 大于 DC 20 才算过；掷 20 大成功、掷 1 大失败。
 */
export function senseZone(value: number | undefined): number {
  return attrValue(typeof value === 'number' && Number.isFinite(value) ? value : 0, 'd20');
}

/** 掷一次。roll 可以指定（测试、桌面骰用）。 */
export function rollSense(kind: SenseKind, pc: PC, roll: (sides: number) => number = defaultRoll): SenseRoll {
  const spec = SENSE_SPECS[kind];
  // 这里只负责「这项感知过哪项属性」；判定口径在 interaction.resolveChecks()。
  const res = resolveChecks(spec, pc.attributes, rollSpec(spec, roll));
  const rolls = res.checks.map((c) => ({ attr: c.attr, value: c.used, zone: c.value, success: c.success, crit: c.tier === 'crit', fumble: c.tier === 'fumble' }));
  return { kind, rolls, success: res.success, tier: res.tier };
}

/** 把一次感知判定说成人话，写进日志用。 */
export function describeSense(r: SenseRoll, pcName: string): string {
  const parts = r.rolls.map((x) => `${x.attr} D20=${x.value}+区值${x.zone}${x.success ? '✓' : '✗'}`).join('，');
  return `${pcName} 的【${SENSE_LABEL[r.kind]}】：${parts} → ${r.success ? '成功' : '失败'}`;
}

// ---------- 给建议的接口 ----------

/** 一条建议：可能是某个物件上的一条线索，也可能是纯文字。 */
export interface SenseHint {
  /** 建议的内容。 */
  text: string;
  /** 来自哪个物件；见证者现场写的那种没有。 */
  objectId?: string;
  objectName?: string;
  secretId?: string;
  /** 建议的来路，方便调试和以后区分谁给的。 */
  from: 'rule' | 'model' | 'causal' | 'none';
}

/** 感知判定的上下文。 */
export interface SenseContext {
  pc: PC;
  pcName: string;
  map: GameMap;
  /** 玩家想感知的目标；没指定就是「周围一圈」。 */
  targetObjectId?: string | null;
  /** 玩家在第几格（小格坐标）。 */
  at: { x: number; y: number };
  roll: SenseRoll;
}

/**
 * 给建议的接口。
 *
 * 现在它只是「把可能相关的线索摆出来，让见证者挑」，不替见证者做决定。
 * 以后接因果图或者模型，换掉实现就行——调用方拿到的始终是 SenseHint[]。
 */
export interface SenseAdvisor {
  readonly name: string;
  suggest(ctx: SenseContext): SenseHint[];
}

/**
 * 规则版：从物件的 secrets 里挑出跟这次感知相关的条目。
 *
 * 三条限制，都是为了不把答案一股脑倒出来：
 * 1. 只挑 check 跟这次动作对得上的（观察挑观察，倾听挑倾听）。
 * 2. 只看范围里的：距离要在 secret.range 以内。
 * 3. 玩家指定了目标就只挑那个物件；没指定才看周围。
 */
export const ruleSenseAdvisor: SenseAdvisor = {
  name: 'rule',
  suggest(ctx) {
    const { map, roll, targetObjectId, at } = ctx;
    if (!roll.success) return []; // 失败就什么都不给，见下面 note

    const dist = (o: MapObject) => Math.max(0, Math.floor(Math.max(
      Math.abs(o.x + o.w / 2 - (at.x + 0.5)), Math.abs(o.y + o.h / 2 - (at.y + 0.5)))));
    const want = SENSE_LABEL[roll.kind];
    const pool: { o: MapObject; s: Secret; d: number }[] = [];
    for (const o of map.objects) {
      if (o.kind !== 'object') continue;
      if (targetObjectId && o.id !== targetObjectId) continue;
      const d = dist(o);
      for (const s of o.secrets ?? []) {
        // 检定名要对得上：secret.check 里含这次动作的名字
        if (!s.check || !s.check.includes(want)) continue;
        if (d > s.range) continue;
        pool.push({ o, s, d });
      }
    }
    // 近的靠前；一样近就按物件名字排，输出稳定。
    pool.sort((a, b) => a.d - b.d || a.o.name.localeCompare(b.o.name));
    return pool.map(({ o, s }) => ({
      text: s.tiers[roll.tier] || s.tiers.success,
      objectId: o.id,
      objectName: o.name,
      secretId: s.id,
      from: 'rule' as const,
    }));
  },
};

/** 当前用哪个建议实现。以后接模型就换这里。 */
let advisor: SenseAdvisor = ruleSenseAdvisor;
export function setSenseAdvisor(next: SenseAdvisor): void { advisor = next; }
export function currentSenseAdvisor(): SenseAdvisor { return advisor; }

/** 跑一次建议。见证者拿到的是候选，不是已经发生的事实。 */
export function senseHints(ctx: SenseContext): SenseHint[] {
  const hints = advisor.suggest(ctx);
  // 一条建议都没有时也留个记号：见证者知道该自己写。
  return hints.length ? hints : [{ text: '', from: 'none' }];
}
