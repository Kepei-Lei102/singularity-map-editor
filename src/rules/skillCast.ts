// 技能发动：玩家自己发起 / 见证者代发起，两条入口落在同一个状态上。
// 发动期间用统一的 focus 暂停别人（玩家窗口只能看不能动）。

import { getUI, getWorld, setUI, toast, update } from '../core/store';
import { pushFocus } from '../runtime/sync';
import { castCost, skillById } from './skills';
export { skillById };
import { ATTRS, resolve, type Attr } from './interaction';
import type { SkillCast } from '../core/types';
export type { SkillCast } from '../core/types';
import { uid } from '../core/util';

export const APPROVAL_TIMEOUT_MS = 60_000;


export const castOf = (): SkillCast | null => (getUI().cast as SkillCast | null) ?? null;

/** 发动即扣：扣 ME，并把当前途径换过去。取消时按 charged 退。 */
function charge(c: SkillCast) {
  const cost = c.meCost ?? 0;
  let deducted = 0;
  update((d) => {
    const pc = d.party.find((p) => p.id === c.actorPcId);
    if (!pc) return;
    if (cost > 0 && pc.me != null) { deducted = Math.min(pc.me, cost); pc.me -= deducted; }
    if (c.pathwayTo) pc.pathway = c.pathwayTo;
  });
  setCast({ ...c, charged: deducted }); // 只记真正扣掉的，强行发动扣到 0 时就退 0
}
function refund(c: SkillCast) {
  const back = c.charged ?? 0;
  if (!back) return;
  update((d) => {
    const pc = d.party.find((p) => p.id === c.actorPcId);
    if (!pc) return;
    if (pc.me != null) pc.me = Math.min(pc.meMax ?? Infinity, pc.me + back);
    if (c.pathwayFrom) pc.pathway = c.pathwayFrom; // 没发动成，途径也退回原来的
  });
}

function pcName(pcId: string): string {
  return getWorld().party.find((p) => p.id === pcId)?.name ?? '某人';
}

function setCast(next: SkillCast | null) {
  setUI({ cast: next, focus: next ? { kind: 'skill', actorPcId: next.actorPcId, label: `${pcName(next.actorPcId)} 正在发动【${skillById(next.skillId)?.name ?? '技能'}】` } : null });
  pushFocus(); // 立刻推给玩家窗口：发动期间别人只能看不能动
}

/** 发起。玩家发起直接进确认；见证者代发起先等玩家同意（60 秒）。 */
export function beginSkillCast(actorPcId: string, skillId: string, initiator: 'player' | 'gm', force = false): string | null {
  if (!skillById(skillId)) return '没有这个技能';
  if (castOf()) return '已经有技能在发动中，先处理完';
  const pc = getWorld().party.find((p) => p.id === actorPcId);
  if (!pc) return '找不到这个角色';
  const skill = skillById(skillId)!;
  if (pc.me == null) return '这个角色还没填 ME，先把 ME 填上再发动技能（在队伍面板）';
  const { cost, from } = castCost(pc, skill);
  const short = pc.me != null && pc.me < cost;
  if (short && !force) return `ME 不够：【${skill.name}】要 ${cost} ME，现在只有 ${pc.me}（可以强行发动，代价是晕厥）`;
  const cast: SkillCast = {
    id: uid(), actorPcId, skillId, initiator,
    step: initiator === 'gm' ? 'approval' : 'confirm',
    expiresAt: initiator === 'gm' ? Date.now() + APPROVAL_TIMEOUT_MS : undefined,
    meCost: cost, pathwayFrom: from ?? undefined, pathwayTo: skill.pathway, overdrawn: short || undefined,
  };
  setCast(cast);
  // 玩家自己发起：当场算发动，直接扣；见证者代发起要等玩家点头才扣。
  if (initiator === 'player') charge(cast);
  return null;
}

/** 玩家点同意（或见证者代点）。超时后不能再同意。 */
export function approveSkillCast(ok = true): string | null {
  const c = castOf();
  if (!c) return '没有在等同意的技能';
  if (c.step !== 'approval') return '这个技能已经同意过了';
  if (c.expiresAt && c.expiresAt <= Date.now()) { cancelSkillCast('玩家没在时限内回应，视为休眠'); return '已超时'; }
  if (!ok) { cancelSkillCast('玩家不同意'); return null; }
  const next: SkillCast = { ...c, step: 'confirm', expiresAt: undefined };
  setCast(next);
  charge(next); // 玩家点头了，才算发动，这时扣 ME
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
  const actor = getWorld().party.find((p) => p.id === c.actorPcId);
  if (!actor) return '找不到这个角色';
  // 六维读角色卡（编辑器里早就有 0–100 了）。以前这里写死 0，等于所有技能的成功率恒为 5%，
  // 跟角色属性无关——注释说的「六维还没进编辑器」已经过期。
  const attrs = Object.fromEntries(ATTRS.map((a) => [a, actor.attributes?.[a] ?? 0])) as Record<Attr, number>;
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
  if (!castOf()) return;
  setCast(null); // 里面会 pushFocus，玩家窗口立刻解冻
  if (note) toast(note);
}

export function cancelSkillCast(reason = '取消'): void {
  const c = castOf();
  if (c && c.step !== 'approval') refund(c); // 还没点头就取消的不退（没扣过）；点头后取消退回去
  setCast(null);
  toast(`技能发动取消：${reason}`);
}
