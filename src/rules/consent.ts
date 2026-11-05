// 玩家窗口回传的同意/拒绝：主持人端只认自己的 cast，别的窗口来的不处理。
import { listen, type SyncMsg } from '../runtime/sync';
import { approveSkillCast, castOf } from './skillCast';

export function handlePlayerDecision(m: SyncMsg): boolean {
  if (m.type !== 'skill-decision') return false;
  const c = castOf();
  if (!c || c.step !== 'approval' || c.id !== m.castId) return false;
  approveSkillCast(m.ok);
  return true;
}

export function listenPlayerDecisions() {
  return listen((m) => { handlePlayerDecision(m); }, false);
}
