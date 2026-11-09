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

/** 感知动作的四种。 */
export type SenseKind = 'observe' | 'search' | 'smell' | 'listen';

export const SENSE_LABEL: Record<SenseKind, string> = {
  observe: '观察',
  search: '搜索',
  smell: '嗅闻',
  listen: '倾听',
};

/** 每个感知动作要掷什么骰。 */
export type SenseCheck = {
  /** 属性名，跟 PC.attributes 的键一致。 */
  attr: string;
  /** 这一项是「都要过」里的一个：搜索是两项都过，其它都是一项。 */
  required: boolean;
};

export const SENSE_CHECKS: Record<SenseKind, SenseCheck[]> = {
  observe: [{ attr: '观察', required: true }],
  // 双属性劣势由作者定义成「都要过」：敏捷掷一次、观察掷一次，两个都成功才算成功。
  search: [{ attr: '敏捷', required: true }, { attr: '观察', required: true }],
  smell: [{ attr: '观察', required: true }],
  listen: [{ attr: '观察', required: true }],
};

/** 默认骰：1..100，100 表示 00。 */
const defaultRoll = () => 1 + Math.floor(Math.random() * 100);

/**
 * 一次感知判定的结果。
 * 每个属性一次骰；全部 required 的都成功，才算整体成功。
 */
export interface SenseRoll {
  kind: SenseKind;
  rolls: { attr: string; value: number; zone: number; success: boolean; crit: boolean; fumble: boolean }[];
  success: boolean;
  /** 整体档位：全部大成功才 crit，任一失败就是 fail。 */
  tier: Tier;
}

/**
 * 属性值取区值：÷5 向下取整。
 * D100 判定口径跟武器攻击一致：投 1 大失败，投 100（00）特大成功，其余 ≤ 区值×10 算成功。
 */
export function senseZone(value: number | undefined): number {
  return Math.floor((value ?? 0) / 5);
}

/** 掷一次。roll 可以指定（测试、桌面骰用）。 */
export function rollSense(kind: SenseKind, pc: PC, roll: (sides: number) => number = defaultRoll): SenseRoll {
  const checks = SENSE_CHECKS[kind];
  const rolls = checks.map((c) => {
    const zone = senseZone(pc.attributes?.[c.attr]);
    const value = roll(100);
    const fumble = value === 1;
    const crit = value === 100;
    // 区值 0 表示这项完全没有：掷出什么都不过。
    const success = crit || (!fumble && zone > 0 && value <= zone * 10);
    return { attr: c.attr, value, zone, success, crit, fumble };
  });
  const success = rolls.every((r) => r.success);
  const tier: Tier = !success
    ? (rolls.some((r) => r.fumble) ? 'fumble' : 'fail')
    : (rolls.every((r) => r.crit) ? 'crit' : 'success');
  return { kind, rolls, success, tier };
}

/** 把一次感知判定说成人话，写进日志用。 */
export function describeSense(r: SenseRoll, pcName: string): string {
  const d = (v: number) => (v === 100 ? '00' : String(v));
  const parts = r.rolls.map((x) => `${x.attr} D100=${d(x.value)}${x.success ? '✓' : '✗'}`).join('，');
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
