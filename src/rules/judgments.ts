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
    if (input.place.x < 0 || input.place.y < 0 || input.place.x > m.width || input.place.y > m.height) return '判定位置超出地图';
  }
  const r = input.roll;
  if (!r.id?.trim() || !['wood','plastic','metal','stone','rubber'].includes(r.material) || r.persona !== 'witness' || !Number.isSafeInteger(r.seed) || r.seed! < 0) return '骰子记录无效';
  if (![4,6,8,10,12,20,100].includes(r.sides) || !Number.isInteger(r.value) || r.value < 1 || r.value > r.sides) return '骰子结果无效';
  if (r.sides === 100 && (!Number.isInteger(r.tens) || !Number.isInteger(r.units) || r.tens! < 0 || r.tens! > 90 || r.tens! % 10 || r.units! < 0 || r.units! > 9 || (r.tens! + r.units! || 100) !== r.value)) return '百分骰结果不一致';
  if ((w.judgments ?? []).some(j => j.roll.id === r.id)) return '这次掷骰已经发布过';
  update(d => {
    // 没有私骰：正式判定一律广播给当前全队，忽略调用方传来的 recipients。
    const j: DiceJudgment = { ...input, title: input.title.trim(), recipients: d.party.map(p => p.id), id: uid(), at: Date.now(), session: d.session };
    (d.judgments ??= []).push(j);
    d.log.push({ id: uid(), at: j.at, session: d.session, kind: 'note', text: `正式判定「${j.title}」：D${r.sides}=${r.value === 100 ? '000' : r.value}；${j.ruling || '结果已送达，等待见证者裁定'}` });
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
    },
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
  setUI({ pendingJudgment: null });
  return null;
}

/** 见证者代掷：玩家不在电脑前或用的是实体骰。 */
export function standInForJudgment(): string | null {
  const p = getUI().pendingJudgment;
  if (!p) return '没有待掷的判定';
  setUI({ pendingJudgment: { ...p, standIn: true } });
  return null;
}
