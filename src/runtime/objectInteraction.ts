// 把「动作 × 物件」的一次确认结算落成世界变化 + 一条 PhysicalEvent。
import { appendEvent, newEvent } from '../rules/events';
import { tierOfRoll, type Advantage, type CheckResult, type Scale } from '../rules/interaction';
import { objectOutcome } from '../rules/objectInteraction';
import { objectStateError } from '../scene/architecture';
import { findMap } from './actions';
import { getWorld, update } from '../core/store';

export interface CommitInteractionInput {
  mapId: string;
  objectId: string;
  actorId: string;
  actionId: string;
  actionName: string;
  result: CheckResult;
  merge: 'single' | 'any' | 'all';
  scale: Scale;
  /** 面板选的骰势；落账要如实写 advantage/disadvantage，不能一律记 single。 */
  advantage?: Advantage;
}

/** 确认才调用：改 state、记 stateRev、追加一条事件。失败返回原因，世界不动。 */
export function commitObjectInteraction(input: CommitInteractionInput): string | null {
  const w = getWorld();
  const map = findMap(w, input.mapId);
  if (!map) return '找不到地图';
  const o = map.objects.find((x) => x.id === input.objectId);
  if (!o) return '找不到物件';
  const actor = w.party.find((p) => p.id === input.actorId);
  if (!actor) return '找不到发起角色';
  const tier = input.result.tier;
  if (!tier) return '这次判定没有档位';
  const to = objectOutcome(o, input.actionId, tier);
  if (to === null) return '这一档没有预置效果';
  const stateError = objectStateError(map, input.objectId, to);
  if (stateError) return stateError;
  const from = o.state;
  const fromName = o.states[from] ?? String(from);
  const toName = o.states[to] ?? String(to);

  const dice: 'single' | 'advantage' | 'disadvantage' = input.advantage === 'advantage' || input.advantage === 'disadvantage' ? input.advantage : 'single';
  const attrs = input.result.rolls.map((r) => {
    const t = tierOfRoll(input.scale, r.roll).tier;
    return {
      attr: r.attr, dice, roll: r.roll, used: r.roll, rolls: [...r.rolls],
      value: r.value, total: r.total, success: r.pass,
      tier: t === 'crit' || t === 'fumble' ? t : null,
    };
  });

  update((d) => {
    const dm = findMap(d, input.mapId);
    const dobj = dm?.objects.find((x) => x.id === input.objectId);
    if (!dm || !dobj) return;
    if (from !== to) {
      dobj.state = to;
      dobj.stateRev = (dobj.stateRev ?? 0) + 1;
    }
    const deltas = from === to
      ? []
      : [{ kind: 'object' as const, id: dobj.id, name: dobj.name, path: '状态', from: fromName, to: toName }];
    appendEvent(d, newEvent(d, Date.now(),
      { kind: 'pc', id: actor.id, name: actor.name },
      { id: input.actionId, name: input.actionName, source: '动作库' },
      {
        target: { kind: 'object', id: dobj.id, name: dobj.name },
        check: {
          kind: 'check', scale: input.scale, merge: input.merge,
          dc: input.result.rolls[0]?.dc,
          attrs,
          success: input.result.success ?? false,
          tier: input.result.tier === 'crit' || input.result.tier === 'fumble' ? input.result.tier : null,
          level: input.result.level === '特大' ? '特大' : null,
          rolledBy: 'host',
          ...(input.merge === 'single' && attrs.length === 1 ? { total: input.result.rolls[0]?.total } : {}),
        },
        deltas,
      },
    ));
  });
  return null;
}
