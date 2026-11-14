// 物理事件的唯一记账。
//
// 作者的范式：
//   <A> 对 <B> 发起了 <动作>，需要过 <属性> <优势/劣势>
//   <动作> <成功/失败/大成功/大失败>，<谁> 的 <什么> 从 <X> 改为 <Y>
//
// 这里的原则：句子是事件的渲染结果，不是输入。日志、判定记录、事件卡片都读同一份事件，
// 以后临场生成分支也从它读状态，而不是从自然语言反推。
import type { Delta, LogEntry, PhysicalEvent, World } from '../core/types';
import { uid } from '../core/util';

/** 只留最近这么多条，别让存档被日志撑爆。 */
export const EVENT_CAP = 200;

/** 能接事件的东西：正式世界，或者 update() 里的 Immer draft。 */
interface EventSink {
  log: LogEntry[];
  events?: PhysicalEvent[];
}

/** 记一条事件，并顺手把它的渲染结果写进日志。 */
export function appendEvent(d: EventSink, ev: PhysicalEvent): void {
  (d.events ??= []).push(ev);
  if (d.events.length > EVENT_CAP) d.events.splice(0, d.events.length - EVENT_CAP);
  d.log.push({ id: `${ev.id}-log`, at: ev.at, session: ev.session, kind: 'note', text: eventText(ev), eventId: ev.id });
}

const DICE_TEXT: Record<string, string> = {
  single: '',
  advantage: '（优势骰，掷两次取高）',
  disadvantage: '（劣势骰，掷两次取低）',
};

const MERGE_TEXT: Record<string, string> = {
  single: '',
  any: '，过一个就够',
  all: '，都要过',
};

/** 宣告那一句：「A 对 B 发起了【动作】，要过 X（优势骰），DC n」。 */
export function declareText(ev: PhysicalEvent): string {
  const who = ev.target ? `${ev.actor.name} 对 ${ev.target.name}` : ev.actor.name;
  const c = ev.check;
  if (!c) return `${who} 发起了【${ev.action.name}】`;
  const attrs = c.attrs.map((a) => `${a.attr}${DICE_TEXT[a.dice] ?? ''}`).join('＋');
  const rolled = c.scale === 'd20' ? 'D20' : 'D100';
  // dc 是可选的（攻击没有门槛）；有 DC 才写，别渲染出「DC undefined」。
  const hasDc = typeof c.dc === 'number';
  const target = attrs
    ? `要过 ${attrs}${MERGE_TEXT[c.merge] ?? ''}${hasDc ? `，DC ${c.dc}` : ''}`
    : `掷 ${rolled}`;
  return `${who} 发起了【${ev.action.name}】，${target}`;
}

/** 档位怎么说：特大成功和大成功分开，别混成一个词。 */
export function tierText(c: NonNullable<PhysicalEvent['check']>): string {
  // 攻击的档位是「落空/命中/大成功/特大成功」，跟判定档位不是一套词；有 outcome 就别再翻译 tier。
  if (c.outcome) return c.outcome;
  if (c.tier === 'crit') return c.level === '特大' ? '特大成功' : '大成功';
  if (c.tier === 'fumble') return c.level === '特大' ? '特大失败' : '大失败';
  return c.success ? '成功' : '失败';
}

/** 格坐标：整数不带小数点，带小数就写一位——别和 1/3 子格坐标混在一起看。 */
const fmtAt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** 渲染一处变化；值没变就返回 null，绝不写「从 6 改为 6」。 */
function deltaText(d: Delta): string | null {
  const same = (a: unknown, b: unknown) => a === b;
  switch (d.kind) {
    case 'hp': return same(d.from, d.to) ? null : `${d.name} 的 HP 从 ${d.from} 改为 ${d.to}`;
    case 'me': return same(d.from, d.to) ? null : `${d.name} 的 ME 从 ${d.from} 改为 ${d.to}`;
    case 'moved':
      if (d.from.x === d.to.x && d.from.y === d.to.y) return null;
      return `${d.name} 从格坐标 (${fmtAt(d.from.x)}, ${fmtAt(d.from.y)}) 挪到 (${fmtAt(d.to.x)}, ${fmtAt(d.to.y)})`;
    case 'status': return same(d.from, d.to) ? null : `${d.name} 的状态从 ${d.from ?? '无'} 改为 ${d.to ?? '无'}`;
    case 'points': return same(d.from, d.to) ? null : `${d.name} 的移动点从 ${d.from} 改为 ${d.to}`;
    case 'object': return same(d.from, d.to) ? null : `${d.name} 的 ${d.path} 从 ${d.from ?? '无'} 改为 ${d.to ?? '无'}`;
  }
}

/** 结果那一句：「【动作】失败：B 的 HP 从 8 改为 3；A 得知 …」。 */
export function resultText(ev: PhysicalEvent): string {
  // 没有属性骰但记了摔伤骰的事件（必摔的往下跳）不是“完成”，是失败。
  const verdict = ev.check ? tierText(ev.check) : ev.damage?.kind === 'fall' ? '失败' : '完成';
  const head = `【${ev.action.name}】${verdict}`;
  const parts = ev.deltas.map(deltaText).filter((x): x is string => !!x);
  const know = ev.knowledge?.length
    ? `${ev.actor.name} 得知 ${ev.knowledge.map((k) => k.label).join('、')}`
    : '';
  if (know) parts.push(know);
  // 逐属性有成败的（目前是感知）：补上每一项的骰点/区值/✓✗，不然多属性失败看不出是哪项挂的。
  const attrDetails = ev.check?.attrs
    .filter((a) => typeof a.success === 'boolean')
    .map((a) => {
      const roll = a.used ?? a.roll;
      const shown = a.rolls && a.rolls.length > 1 ? `${a.rolls.join('/')}→取${roll}` : `${roll}`;
      const rollText = roll === undefined ? '' : ` ${shown}+区值${a.value}`;
      const tier = a.tier === 'crit' ? '（大成功）' : a.tier === 'fumble' ? '（大失败）' : '';
      return `${a.attr}${rollText}${a.success ? '✓' : '✗'}${tier}`;
    });
  if (attrDetails?.length) parts.push(attrDetails.join('，'));
  if (ev.note) parts.push(ev.note);
  return parts.length ? `${head}：${parts.join('；')}` : head;
}

/** 一句到底：宣告 + 结果。日志和 AI 叙述都用这个。 */
export function eventText(ev: PhysicalEvent): string {
  return `${declareText(ev)} → ${resultText(ev)}`;
}

/** 造一条事件的壳，调用方只填空的字段。 */
export function newEvent(
  d: World, at: number, actor: PhysicalEvent['actor'], action: PhysicalEvent['action'],
  extra: Partial<PhysicalEvent> = {},
): PhysicalEvent {
  return { id: uid(), at, session: d.session, actor, action, deltas: [], ...extra };
}
