// 技能发动：玩家自己发起 / 见证者代发起，两条入口落在同一个状态上。
// 发动期间用统一的 focus 暂停别人（玩家窗口只能看不能动）。

import { getUI, getWorld, setUI, toast, update } from './store';
import { SKILL_LIBRARY, type SkillDef } from './skills';
import { ATTRS, resolve, type Attr } from './interaction';
import type { SkillCast } from './types';
export type { SkillCast } from './types';
import { uid } from './util';

export const APPROVAL_TIMEOUT_MS = 60_000;


export const skillById = (id: string): SkillDef | undefined => SKILL_LIBRARY.find((s) => s.id === id);
export const castOf = (): SkillCast | null => (getUI().cast as SkillCast | null) ?? null;

function pcName(pcId: string): string {
  return getWorld().party.find((p) => p.id === pcId)?.name ?? '某人';
}

function setCast(next: SkillCast | null) {
  setUI({ cast: next, focus: next ? { kind: 'skill', actorPcId: next.actorPcId, label: `${pcName(next.actorPcId)} 正在发动【${skillById(next.skillId)?.name ?? '技能'}】` } : null });
}

/** 发起。玩家发起直接进确认；见证者代发起先等玩家同意（60 秒）。 */
export function beginSkillCast(actorPcId: string, skillId: string, initiator: 'player' | 'gm'): string | null {
  if (!skillById(skillId)) return '没有这个技能';
  if (castOf()) return '已经有技能在发动中，先处理完';
  if (!getWorld().party.some((p) => p.id === actorPcId)) return '找不到这个角色';
  const cast: SkillCast = {
    id: uid(), actorPcId, skillId, initiator,
    step: initiator === 'gm' ? 'approval' : 'confirm',
    expiresAt: initiator === 'gm' ? Date.now() + APPROVAL_TIMEOUT_MS : undefined,
  };
  setCast(cast);
  return null;
}

/** 玩家点同意（或见证者代点）。超时后不能再同意。 */
export function approveSkillCast(ok = true): string | null {
  const c = castOf();
  if (!c) return '没有在等同意的技能';
  if (c.step !== 'approval') return '这个技能已经同意过了';
  if (c.expiresAt && c.expiresAt <= Date.now()) { cancelSkillCast('玩家没在时限内回应，视为休眠'); return '已超时'; }
  if (!ok) { cancelSkillCast('玩家不同意'); return null; }
  setCast({ ...c, step: 'confirm', expiresAt: undefined });
  return null;
}

/** 超时检查：主持人端每回合或定时调用。返回是否取消了。 */
export function timeoutSkillCast(now = Date.now()): boolean {
  const c = castOf();
  if (!c || c.step !== 'approval' || !c.expiresAt || c.expiresAt > now) return false;
  cancelSkillCast('同意超时，视为休眠');
  return true;
}

/** 确认目标和口径，然后掷骰。 */
export function resolveSkillCast(d20: number, target?: string): string | null {
  const c = castOf();
  if (!c) return '没有正在发动的技能';
  if (c.step !== 'confirm') return '还没到掷骰这一步';
  const skill = skillById(c.skillId)!;
  if (!getWorld().party.some((p) => p.id === c.actorPcId)) return '找不到这个角色';
  // 试点：角色卡上的六维还没进编辑器，先按 0 走，判定只反映骰面
  const attrs = Object.fromEntries(ATTRS.map((a) => [a, 0])) as Record<Attr, number>;
  // 试点阶段：技能还没接动作卡，先按 D20、默认 DC 20、智慧判定走一遍
  const result = resolve({
    check: skill.check ?? { attributes: ['智慧'], mode: 'single' },
    actor: attrs,
    d20s: [[d20]],
    scale: 'd20',
  });
  setCast({ ...c, step: 'result', target, roll: d20, total: result.rolls[0]?.total ?? d20, success: result.success, note: result.success ? '成功' : '失败' });
  return null;
}

/** 收尾：清掉 focus，玩家窗口恢复可操作。 */
export function closeSkillCast(note?: string): void {
  const c = castOf();
  setCast(null);
  if (c) update(() => {}, { history: false }); // 触发一次重渲染，把 focus 撤掉的效果同步给玩家窗口
  if (note) toast(note);
}

export function cancelSkillCast(reason = '取消'): void {
  setCast(null);
  toast(`技能发动取消：${reason}`);
}
