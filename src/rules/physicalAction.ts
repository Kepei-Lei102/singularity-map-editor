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
// 动作级前置条件、ME、技能来源仍未接。
import type { GameMap, MapObject, PC, World } from '../core/types';
import { objectEnabled } from '../core/objectData.js';
import { architectureGeometry, architectureObjectBounds, isArchitectureObject, objectRect, tokenPosition } from '../scene/architecture';
import { viewerOf, visiblePoint } from '../scene/sight';
import { statusBlocksAction } from './combat';

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
  /** 默认贴身 1 格；以后动作卡有范围再从这里传。 */
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

  // 不在试玩里：没有棋子，距离/视线/行动点都无从算；保留原来的备团/试排行为。
  if (!trial) return null;

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

  const range = input.range ?? PHYSICAL_REACH;
  const distance = physicalActionDistance(map, object, token);
  if (distance > range) return `要贴身才能操作（${cellText(distance)} 格 > ${range} 格）`;

  const b = objectBounds(map, object);
  // 门开门时排除目标自己的构件；物件也一样，别让物件自己挡自己的视线。
  // 光过滤建筑几何不够：高家具自己的格子也会进 cellSightCost，所以视线用的地图副本要把它摘掉。
  const geometry = architectureGeometry(map).filter((r) => r.objectId !== object.id);
  const sightMap = { ...map, objects: map.objects.filter((x) => x.id !== object.id) };
  const eye = { ...viewerOf(token, { sex: actor.sex, heightCm: actor.heightCm }), facing: undefined };
  if (!visiblePoint(world, sightMap, eye, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, geometry)) return '看不见这个物件';
  return null;
}
