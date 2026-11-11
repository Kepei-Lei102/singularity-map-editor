import type { DiceJudgment } from '../core/types';
import { getUI, getWorld, setUI, update, worldContext } from '../core/store';
import { uid } from '../core/util';

export function publishJudgment(input: Omit<DiceJudgment, 'id' | 'at' | 'session'>, context: string): string | null {
  const w = getWorld();
  if (context !== worldContext()) return '工程或试玩已切换，请重新掷骰';
  if (!input.title.trim()) return '请填写判定名称';
  if (!w.party.length) return '还没有角色，判定无法广播';
  if (input.subjectId && !w.party.some(p => p.id === input.subjectId)) return '判定角色无效';
  if (input.place) {
    const m = w.maps.find(x => x.id === input.place!.mapId);
    if (!m) return '判定位置的地图不存在';
    // 跟 visiblePoint 的边界口径对齐：x==width / y==height 已经在图外，不能当锚点。
    if (input.place.x < 0 || input.place.y < 0 || input.place.x >= m.width || input.place.y >= m.height) return '判定位置超出地图';
  }
  const r = input.roll;
  // persona 是「这颗骰子谁掷的」：玩家自己掷（player）和见证者代掷（witness）都是正式判定，都得能广播。
  if (!r.id?.trim() || !['wood','plastic','metal','stone','rubber'].includes(r.material) || (r.persona !== 'witness' && r.persona !== 'player') || !Number.isSafeInteger(r.seed) || r.seed! < 0) return '骰子记录无效';
  if (![4,6,8,10,12,20,100].includes(r.sides) || !Number.isInteger(r.value) || r.value < 1 || r.value > r.sides) return '骰子结果无效';
  if (r.sides === 100 && (!Number.isInteger(r.tens) || !Number.isInteger(r.units) || r.tens! < 0 || r.tens! > 90 || r.tens! % 10 || r.units! < 0 || r.units! > 9 || (r.tens! + r.units! || 100) !== r.value)) return '百分骰结果不一致';
  // 多属性判定：values 和 attrs 必须一一对应，且采信值要在自己的骰子里。
  if (r.values !== undefined) {
    if (!Array.isArray(r.values) || r.values.length < 2 || r.values.length > 8 || r.values.some((v) => !Number.isInteger(v) || v < 1 || v > r.sides)) return '骰子结果无效';
    if (!r.values.includes(r.value)) return '骰子结果无效';
    if (!Array.isArray(r.attrs) || r.attrs.length !== r.values.length || r.attrs.some((a) => typeof a !== 'string' || !a.trim())) return '骰子记录无效';
  } else if (r.attrs !== undefined) return '骰子记录无效';
  if ((w.judgments ?? []).some(j => j.roll.id === r.id)) return '这次掷骰已经发布过';
  update(d => {
    // 没有私骰：正式判定一律广播给当前全队，忽略调用方传来的 recipients。
    const j: DiceJudgment = { ...input, title: input.title.trim(), recipients: d.party.map(p => p.id), id: uid(), at: Date.now(), session: d.session };
    (d.judgments ??= []).push(j);
    const fmt = (v: number) => (v === 100 ? '000' : String(v));
    // 多属性判定：每颗都进这次正式判定的记录和日志，不能只留第一颗。
    const dice = r.values && r.attrs && r.values.length === r.attrs.length
      ? r.attrs.map((a, i) => `${a} D${r.sides}=${fmt(r.values![i])}`).join(' / ')
      : `D${r.sides}=${fmt(r.value)}`;
    d.log.push({ id: uid(), at: j.at, session: d.session, kind: 'note', text: `正式判定「${j.title}」：${dice}；${j.ruling || '结果已送达，等待见证者裁定'}` });
  });
  return null;
}

import type { PendingJudgment } from '../core/types';

/**
 * 见证者开一个判定：只宣告，不掷。骰子交给玩家。
 * 裁定可以现在写好并锁住，玩家掷完不能再改口。
 */
export function openJudgment(input: {
  title: string; ruling: string; sides: PendingJudgment['sides']; subjectId: string;
  place?: { mapId: string; x: number; y: number } | null;
  jump?: import('../core/types').JumpRequest | null;
  fall?: import('../core/types').FallRequest | null;
  attack?: { attackerTokenId: string; targetTokenId: string; sharp?: boolean } | null;
  door?: { mapId: string; objectId: string; method: 'pick' | 'force' } | null;
  check?: { attrs: { attr: string; dice: 'single' | 'advantage' | 'disadvantage' }[]; dc: number; merge: 'single' | 'any' | 'all' } | null;
}): string | null {
  const w = getWorld();
  if (!input.title.trim()) return '请填写判定名称';
  if (!w.party.length) return '还没有角色，判定无法开出';
  if (!w.party.some((p) => p.id === input.subjectId)) return '判定的角色无效';
  if (getUI().pendingJudgment) return '已经有一个判定在等玩家掷骰，先结算或取消它';
  update((d) => {
    d.log.push({ id: uid(), at: Date.now(), session: d.session, kind: 'note', text: `开出判定「${input.title.trim()}」：D${input.sides}，等玩家掷骰` });
  });
  setUI({
    pendingJudgment: {
      id: uid(), title: input.title.trim(), ruling: input.ruling, sides: input.sides,
      subjectId: input.subjectId, place: input.place ?? null, at: Date.now(), session: getWorld().session,
      jump: input.jump ?? null,
      fall: input.fall ?? null,
      attack: input.attack ?? null,
      door: input.door ?? null,
      check: input.check ?? null,
      context: worldContext(),
    },
    judgmentResult: null, // 新判定不能带着上一笔的骰子
  });
  return null;
}

/** 见证者取消整个判定（玩家不能拒掷，只有这里能撤销）。 */
export function cancelJudgment(): string | null {
  const p = getUI().pendingJudgment;
  if (!p) return '没有待掷的判定';
  update((d) => {
    d.log.push({ id: uid(), at: Date.now(), session: d.session, kind: 'note', text: `取消判定「${p.title}」` });
  });
  setUI({ pendingJudgment: null, judgmentResult: null });
  return null;
}

/** 见证者代掷：玩家不在电脑前或用的是实体骰。 */
export function standInForJudgment(): string | null {
  const p = getUI().pendingJudgment;
  if (!p) return '没有待掷的判定';
  setUI({ pendingJudgment: { ...p, standIn: true } });
  return null;
}
