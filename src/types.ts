export type Id = string;

/** 地形。visionCoef 是规则里的"每格视野衰减系数"（无障碍 0.1，草丛约 2），第一阶段只存不算。 */
export interface Terrain {
  id: Id;
  name: string;
  color: string;
  blocksMove: boolean;
  visionCoef: number;
}

export interface SecretTiers {
  crit: string;
  success: string;
  fail: string;
  fumble: string;
}
export type Tier = keyof SecretTiers;
export const TIER_LABEL: Record<Tier, string> = {
  crit: '大成功',
  success: '成功',
  fail: '失败',
  fumble: '大失败',
};
export const TIERS: Tier[] = ['crit', 'success', 'fail', 'fumble'];

/** 挂在物件上、靠检定揭示的信息。 */
export interface Secret {
  id: Id;
  label: string;
  check: string; // 例如 "观察"
  kind: 'auto' | 'roll'; // auto = 走进范围自动浮现（文字放在 tiers.success）；roll = 走进范围后可以投骰
  range: number; // 需要靠近到几格以内（圆形距离，向下取整）
  tiers: SecretTiers;
  revealed?: { tier: Tier; scope: 'party' | 'private'; to?: string; at: number };
}

export interface MediaAttach {
  id: Id;
  mediaId: Id;
  label: string;
  trigger: 'manual' | 'enter';
  broadcast: boolean; // 是否同步到玩家窗口
  once: boolean;
  fired?: boolean;
}

/** kind=zone 是不可见的触发区：玩家看不到，用来挂"走进来就播"的媒体或隐藏信息。 */
export interface MapObject {
  id: Id;
  kind: 'object' | 'zone';
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  height: number; // 米。2.5D：同层物件的高度
  color: string;
  icon: string;
  states: string[];
  state: number;
  notes: string; // 只有主持人看得到
  hidden: boolean; // 对玩家隐藏
  secrets: Secret[];
  media: MediaAttach[];
}

/** 房间：按格子刷出来的命名区域。tags 预留给十二宫、八门等对应关系。 */
export interface Room {
  id: Id;
  name: string;
  color: string;
  note: string;
  tags: string[];
}

/** 暂时不能行动（晕厥、泡温泉……）：自由行动时按真实时间倒数，战斗中换算成回合（1 回合 = 5 分钟）。 */
export interface TokenStatus {
  label: string;
  endsAt?: number; // 自由行动：真实时间（毫秒）
  roundsLeft?: number; // 战斗中：还剩几回合
}

export interface Token {
  id: Id;
  pcId: Id | null;
  name: string;
  color: string;
  x: number;
  y: number;
  status?: TokenStatus;
}

export interface GameMap {
  id: Id;
  name: string;
  layer: string; // 现实 / 梦境 / 任意
  floor: number;
  width: number;
  height: number;
  cells: string[]; // terrain id，'' = 空
  d100: number[]; // 1 = D100 区域
  fog: number[]; // 0 = 没去过（黑），1 = 现在看得见，2 = 去过、现在看不见（灰，显示记忆）
  seen: Memory; // 玩家对这张图的记忆：上一次看见时的样子
  autoFog: boolean; // 自动视野：按玩家角色的视线算迷雾
  rooms: Room[];
  roomCells: string[]; // 每格属于哪个房间，'' = 不属于任何房间
  views: Record<Id, VisionLayer>; // 视野各自独立时，每个玩家角色（pcId）自己的一份迷雾和记忆
  spawn: { x: number; y: number } | null; // 试玩出生点（null = 自动：最北、最居中的门外）
  objects: MapObject[];
  tokens: Token[];
  notes: string;
  variantOf?: Id; // 从哪张图复制来的（为以后的"继承"预留）
}

/** 玩家记得的物件样子。回到灰区之前，物件怎么变玩家都不知道。 */
export interface SeenObject {
  id: Id;
  name: string;
  icon: string;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
  height: number;
  stateLabel: string | null; // 只有一个状态的物件不显示状态
}

/** 一份迷雾 + 记忆。全队共享时就是地图上的 fog / seen；各自独立时每个人一份。 */
export interface VisionLayer {
  fog: number[];
  seen: Memory;
}

export interface Memory {
  cells: string[]; // 记得的地形，'' = 不记得
  objects: SeenObject[];
}

export interface Endpoint {
  mapId: Id;
  x: number;
  y: number;
}

export type ConnKind = 'stairs' | 'portal' | 'door' | 'other';
export const CONN_LABEL: Record<ConnKind, string> = {
  stairs: '楼梯',
  portal: '传送/梦境入口',
  door: '门',
  other: '其他',
};
export const CONN_ICON: Record<ConnKind, string> = {
  stairs: '⇅',
  portal: '◎',
  door: '⊓',
  other: '✦',
};

export interface Connection {
  id: Id;
  kind: ConnKind;
  label: string;
  a: Endpoint;
  b: Endpoint;
  hidden: boolean;
}

export interface PC {
  id: Id;
  name: string;
  tags: string[]; // 途径/职业，例如 工程师、歌唱家
  color: string;
}

export interface Effect {
  mapId: Id;
  objectId: Id;
  toState: number;
}

/** 旧版的列表式预测线，只用于迁移旧存档。 */
export interface Step {
  id: Id;
  text: string;
  effect: Effect | null;
  status: 'predicted' | 'happened' | 'skipped';
  at?: number;
  session?: number;
}

export interface Line {
  id: Id;
  name: string;
  condition: string; // '' = 一般线（谁都会走）；否则为途径标签，队伍里有人带这个标签才生效
  description: string;
  origin: 'predicted' | 'record'; // record = 跑团时冒出来的意外分支
  steps: Step[];
}

/**
 * 预测 = 事件流程图（类似《底特律：变人》的流程图）。
 * 节点 = 事件，连线 = 谁做了什么（可带途径条件、大概概率）。
 * 预测与记录同构：predicted 是虚线，happened 是实线。
 */
export interface FlowNode {
  id: Id;
  title: string;
  x: number;
  y: number;
  kind: 'start' | 'event' | 'ending';
  effect: Effect | null; // 发生时改变某个物件的状态
  origin: 'predicted' | 'record'; // record = 带团时冒出来的意外分支
  source?: 'ai'; // AI 生成的，等作者审过可以去掉标记
  status: 'predicted' | 'happened';
  at?: number;
  session?: number;
}

export interface FlowEdge {
  id: Id;
  from: Id;
  to: Id;
  label: string; // 玩家做了什么
  condition: string; // 途径标签，'' = 谁都可以
  chance: number | null; // 大概概率（%），可不填
}

export interface Flow {
  id: Id;
  name: string;
  mapId: Id | null; // 关联的地图：切到这张图时自动显示这张流程图
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface LogEntry {
  id: Id;
  at: number;
  session: number;
  kind: 'state' | 'reveal' | 'media' | 'step' | 'note' | 'enter';
  text: string;
  mapId?: Id;
}

export interface MediaMeta {
  id: Id;
  name: string;
  mime: string;
  size: number;
}

/** 玩家在地图上做的标记：随时间淡去；别人要站得离做标记的人很近才看得到。 */
export interface Mark {
  id: Id;
  mapId: Id;
  x: number;
  y: number;
  author: Id; // pcId
  symbol: string;
  text: string;
  createdAt: number; // 真实时间（毫秒）。奇点之后的时间和现实绑定，直接读真实时钟
  life: number; // 能留多少分钟
}

/**
 * 普通人 NPC（非凡者以外的街坊、路人、委托人）。通用：任何模组都能用。
 * 奇点之后的游戏时间和现实时间绑定，所以"什么时候出现""多久以后回来"都按现实日期算：
 * 只在某几个月出现；玩家出完主意，NPC 真的去办，过几天（现实时间）才回来说结果。没到日子，连着开团也不出现。
 */
export interface NpcTopic {
  id: Id;
  ask: string; // 玩家问到什么
  answer: string; // TA 才说什么
}
export interface NpcOutcome {
  id: Id;
  label: string; // 例如 好结果 / 漂亮解 / 坏结果
  text: string; // 回访时讲的后来
  reward: string; // 这一档给什么
}
/** 结果出来之前的一拍近况（不给奖励），出完主意后至少 afterDays 天才会出现。 */
export interface NpcBeat {
  id: Id;
  afterDays: number;
  text: string;
}
export interface NpcProgress {
  status: 'waiting' | 'met' | 'advised' | 'done';
  metAt?: number; // 真实时间（毫秒）
  advisedAt?: number;
  advice?: string; // 玩家出的主意
  outcomeId?: Id;
  beatsDone: Id[];
  doneAt?: number;
}
export interface Npc {
  id: Id;
  name: string;
  summary: string; // 一句话：谁，要做什么
  icon: string;
  color: string;
  months: number[]; // 只在这几个月出现（1–12）；空 = 任何时候
  place: Endpoint | null; // 一般在地图哪里出现（可不填）
  persona: string; // 人设（主持人看）
  request: string; // 开场：带着什么事来
  topics: NpcTopic[]; // 被问到才说的
  notes: string; // 主持人备注：坑、书里查得到的、好答案
  beats: NpcBeat[];
  returnAfterDays: number; // 出完主意后至少几天才回来说结果
  extra: string; // 回访时顺口说的（比如认识的人的一件小事）
  outcomes: NpcOutcome[];
  progress: NpcProgress;
}

export interface World {
  version: 1;
  name: string;
  terrains: Terrain[];
  maps: GameMap[];
  connections: Connection[];
  party: PC[];
  flows: Flow[];
  lines?: Line[]; // 旧版，迁移后删除
  log: LogEntry[];
  media: MediaMeta[];
  session: number;
  playerMapId: Id | null;
  visionMode: 'shared' | 'individual'; // 视野：全队共享 / 各自独立（A 看到的，B 默认看不到）
  marks: Mark[];
  npcs: Npc[];
}
