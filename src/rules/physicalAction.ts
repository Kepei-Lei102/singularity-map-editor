// 物理互动基座：把「谁能对哪个物件发起动作」收成一处。
//
// 这里只判条件，不掷骰、不改世界。预览和确认落账都调用同一份 physicalActionError()，
// 免得面板拦一套、落账又按另一套结算。
//
// 基座 v0.2 只接通用条件：
// - 发起者还活着、没昏厥、状态不挡行动、这回合还没结束
// - 试玩里只能由当前行动角色发起
// - 战斗里通用互动占 1 行动点
// - 物件没被禁用；试玩里要看得见
// - 默认贴身 1 格内（按物件占位矩形算，不是棋子中心到棋子中心）
// 动作 × 物件的范围/前置条件见 v0.3；ME、技能来源仍未接。
import type { GameMap, MapObject, PC, Precondition, World } from '../core/types';
import { objectEnabled } from '../core/objectData.js';
import { architectureGeometry, architectureObjectBounds, isArchitectureObject, objectRect, tokenPosition } from '../scene/architecture';
import { viewerOf, visiblePoint } from '../scene/sight';
import { statusBlocksAction } from './combat';
import { checkPreconditions, describeUnmet } from './interaction';

/** 试玩里判断行动归属需要的那几项；不依赖 UIState 的其余字段。 */
export interface PhysicalTrialView {
  mapId: string;
  players: { tokenId: string; pcId: string; name: string }[];
  current: number;
  combat: boolean;
  acted?: Record<string, boolean>;
  ended?: Record<string, boolean>;
}

export interface PhysicalActionInput {
  world: World;
  map: GameMap;
  object: MapObject;
  actor: PC;
  /** 不在试玩里就传 null：没有棋子位置，只查物件启用状态。 */
  trial?: PhysicalTrialView | null;
  /** 动作 id：用来取这个动作在这件物件上的 range / preconditions。 */
  actionId?: string;
  /** 显式范围；不传就用 override 的 range，最后回落贴身 1 格。 */
  range?: number;
}

export const PHYSICAL_REACH = 1;

const cellText = (n: number) => {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

const objectBounds = (map: GameMap, object: MapObject) =>
  isArchitectureObject(object) ? architectureObjectBounds(map, object) : objectRect(object);

/** 棋子到物件占位矩形的最近距离（格）。同门那套：矩形外才算距离，贴身就是 0。 */
export function physicalActionDistance(map: GameMap, object: MapObject, token: { x: number; y: number; subcell?: { x: number; y: number } }): number {
  const at = tokenPosition(token);
  const b = objectBounds(map, object);
  return Math.max(
    b.x - at.x, 0, at.x - (b.x + b.w),
    b.y - at.y, 0, at.y - (b.y + b.h),
  );
}

/** 返回不能发起的原因；能发起就返回 null。 */
export function physicalActionError(input: PhysicalActionInput): string | null {
  const { world, map, object, actor, trial } = input;
  if (!objectEnabled(map, object)) return '物件已经被禁用，不能互动';

  const override = input.actionId
    ? object.interaction?.overrides.find((x) => x.actionId === input.actionId)
    : undefined;
  const range = Math.max(0, input.range ?? override?.range ?? PHYSICAL_REACH);
  const preconditions = override?.preconditions ?? [];

  // 目标的属性标签：作者在物件互动档案里写的标签，加上锁具类型。
  const targetProps = [...(object.interaction?.tags ?? [])];
  if (object.lock) targetProps.push(object.lock.kind === 'physical' ? '物理锁具' : '电子锁具');
  const checkCtx = {
    targetProps,
    targetState: object.state,
    targetEnabled: true,
    distance: trial ? physicalActionDistance(map, object, map.tokens.find((t) => t.id === trial.players[trial.current]?.tokenId) ?? { x: 0, y: 0 }) : undefined,
    actorTags: actor.tags ?? [],
  };
  const checkPre = (list: typeof preconditions) => checkPreconditions({ preconditions: list }, checkCtx);
  const describeConditions = (unmet: Precondition[]) => unmet.map((p) =>
    p.kind === 'targetStateIn'
      ? `目标状态不是：${p.states.map((i) => object.states[i] ?? String(i)).join('、')}`
      : describeUnmet([p]),
  ).join('；');

  // 不在试玩里：没有棋子位置，距离/视线/行动点不算；但目标标签/状态、发起者标签照查。
  if (!trial) {
    const pre = checkPre(preconditions.filter((p) => p.kind !== 'withinRange'));
    if (!pre.ok) return describeConditions(pre.unmet);
    return null;
  }

  if (trial.mapId !== map.id) return '试玩不在当前地图';
  const current = trial.players[trial.current];
  if (!current) return '没有当前行动角色';
  if (current.pcId !== actor.id) return `现在轮到 ${current.name}，不能由 ${actor.name} 发起`;

  const token = map.tokens.find((t) => t.id === current.tokenId);
  if (!token) return `找不到 ${actor.name} 的棋子`;

  if (token.corpse) return `${token.name}已经死了`;
  if (token.down) return `${token.name}昏厥中，暂时不能行动`;
  if (trial.combat && trial.ended?.[token.id]) return `${token.name}这个回合已经结束了，等下一轮`;
  if (statusBlocksAction(token.status)) return `${token.name}${token.status!.label}中，暂时不能行动`;
  if (trial.combat && trial.acted?.[token.id]) return '这回合的行动点已经用掉了，按空格结束回合';

  if (object.hidden) return '看不见这个物件';

  const distance = physicalActionDistance(map, object, token);
  checkCtx.distance = distance;
  if (distance > range) {
    return range === PHYSICAL_REACH
      ? `要贴身才能操作（${cellText(distance)} 格 > ${range} 格）`
      : `目标不在 ${range} 格内（${cellText(distance)} 格 > ${range} 格）`;
  }

  const b = objectBounds(map, object);
  // 门开门时排除目标自己的构件；物件也一样，别让物件自己挡自己的视线。
  // 光过滤建筑几何不够：高家具自己的格子也会进 cellSightCost，所以视线用的地图副本要把它摘掉。
  const geometry = architectureGeometry(map).filter((r) => r.objectId !== object.id);
  const sightMap = { ...map, objects: map.objects.filter((x) => x.id !== object.id) };
  const eye = { ...viewerOf(token, { sex: actor.sex, heightCm: actor.heightCm }), facing: undefined };
  if (!visiblePoint(world, sightMap, eye, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, geometry)) return '看不见这个物件';

  if (preconditions.length) {
    const pre = checkPre(preconditions);
    if (!pre.ok) return describeConditions(pre.unmet);
  }
  return null;
}
