// 物件自己的互动效果：动作 id × 档位 → 目标 state。只查物件档案，不碰公共动作库。
import type { MapObject, Tier } from '../core/types';

/** 某物件上，这个动作在这一档改到哪个 state；没配就是 null。 */
export function objectOutcome(o: MapObject, actionId: string, tier: Tier): number | null {
  const hit = o.interaction?.overrides.find((x) => x.actionId === actionId);
  const to = hit?.outcomes[tier];
  if (to === undefined) return null;
  if (!Number.isInteger(to) || to < 0 || to >= o.states.length) return null;
  return to;
}

/** 给面板预览用：from/to 都是 state 下标，名字由调用方配。 */
export function objectOutcomePlan(o: MapObject, actionId: string, tier: Tier): { from: number; to: number } | null {
  const to = objectOutcome(o, actionId, tier);
  if (to === null) return null;
  return { from: o.state, to };
}
