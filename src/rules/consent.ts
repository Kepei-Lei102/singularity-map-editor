// 玩家窗口回传的同意/拒绝：主持人端只认自己的 cast，别的窗口来的不处理。
import { listen, pcIdForBinding, type SyncMsg } from '../runtime/sync';
import { approveSkillCast, castOf } from './skillCast';

export function handlePlayerDecision(m: SyncMsg, actorPcId: string | null): boolean {
  if (m.type !== 'skill-decision') return false;
  const c = castOf();
  if (!c || c.step !== 'approval' || c.id !== m.castId) return false;
  // 同意/拒绝必须来自发动者自己绑定的窗口；别的玩家窗口知道 castId 也不能替他点。
  if (!actorPcId || actorPcId !== c.actorPcId) return false;
  approveSkillCast(m.ok);
  return true;
}

export function listenPlayerDecisions() {
  return listen((m, _source, from) => {
    // from 是传输层认出来的 binding，不是消息里自报的身份。
    handlePlayerDecision(m, from ? pcIdForBinding(from) : null);
  }, false);
}
