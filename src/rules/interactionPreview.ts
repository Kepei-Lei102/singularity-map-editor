// 「发起互动」预览的输入快照：任何一项变了，旧预览就不能再确认。
// 放在 rules 层是为了让面板逻辑能被 node --test 直接测，不用引 React/jsdom。
import type { Advantage } from './interaction';

export interface InteractionPreviewSnapshot {
  mapId: string;
  objectId: string;
  actorId: string;
  actionId: string;
  advantage: Advantage;
  /** 骰点输入框的原文，按属性顺序拼起来；原文变了就重新预览。 */
  rollKey: string;
  /** 预览时物件的当前状态序号。 */
  state: number;
  /** 角色六维的序列化值；外部改属性会让旧预览失效。 */
  actorKey: string;
  /** 物件互动档案的序列化值；改映射会让旧预览失效。 */
  interactionKey: string;
  /** 物件状态名列表的序列化值；改状态名会让旧预览失效。 */
  statesKey: string;
}

/** 快照里的每一项都和当前输入一致，才允许确认。 */
export function interactionPreviewValid(a: InteractionPreviewSnapshot, b: InteractionPreviewSnapshot): boolean {
  return a.mapId === b.mapId
    && a.objectId === b.objectId
    && a.actorId === b.actorId
    && a.actionId === b.actionId
    && a.advantage === b.advantage
    && a.rollKey === b.rollKey
    && a.state === b.state
    && a.actorKey === b.actorKey
    && a.interactionKey === b.interactionKey
    && a.statesKey === b.statesKey;
}

export interface InteractionPreviewSource {
  mapId: string;
  objectId: string;
  actorId: string;
  actionId: string;
  advantage: Advantage;
  rollKey: string;
  state: number;
  actorAttributes: unknown;
  interaction: unknown;
  states: string[];
}

/** 从当前输入造快照；组件不要自己拼字段，免得漏一项。 */
export function makeInteractionPreviewSnapshot(source: InteractionPreviewSource): InteractionPreviewSnapshot {
  return {
    mapId: source.mapId,
    objectId: source.objectId,
    actorId: source.actorId,
    actionId: source.actionId,
    advantage: source.advantage,
    rollKey: source.rollKey,
    state: source.state,
    actorKey: JSON.stringify(source.actorAttributes ?? null),
    interactionKey: JSON.stringify(source.interaction ?? null),
    statesKey: JSON.stringify(source.states),
  };
}
