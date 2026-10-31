import type { DiceJudgment } from './types';
import { getWorld, update, worldContext } from './store';
import { uid } from './util';

export function publishJudgment(input: Omit<DiceJudgment, 'id' | 'at' | 'session'>, context: string): string | null {
  const w = getWorld();
  if (context !== worldContext()) return '工程或试玩已切换，请重新掷骰';
  if (!input.title.trim()) return '请填写判定名称';
  if (!input.recipients.length || input.recipients.some(id => !w.party.some(p => p.id === id))) return '请指定有效的接收角色';
  const r = input.roll;
  if (!r.id?.trim() || !['wood','plastic','metal','stone','rubber'].includes(r.material) || r.persona !== 'witness' || !Number.isSafeInteger(r.seed) || r.seed! < 0) return '骰子记录无效';
  if (![4,6,8,10,12,20,100].includes(r.sides) || !Number.isInteger(r.value) || r.value < 1 || r.value > r.sides) return '骰子结果无效';
  if (r.sides === 100 && (!Number.isInteger(r.tens) || !Number.isInteger(r.units) || r.tens! < 0 || r.tens! > 90 || r.tens! % 10 || r.units! < 0 || r.units! > 9 || (r.tens! + r.units! || 100) !== r.value)) return '百分骰结果不一致';
  if ((w.judgments ?? []).some(j => j.roll.id === r.id)) return '这次掷骰已经发布过';
  update(d => {
    const j: DiceJudgment = { ...input, title: input.title.trim(), recipients: [...new Set(input.recipients)], id: uid(), at: Date.now(), session: d.session };
    (d.judgments ??= []).push(j);
    d.log.push({ id: uid(), at: j.at, session: d.session, kind: 'note', text: `正式判定「${j.title}」：D${r.sides}=${r.value === 100 ? '000' : r.value}；${j.ruling || '结果已送达，等待见证者裁定'}` });
  });
  return null;
}
