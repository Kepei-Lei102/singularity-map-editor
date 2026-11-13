export type Id = string;

/** 地形。visionCoef 是规则里的"每格视野衰减系数"（无障碍 0.1，草丛约 2），第一阶段只存不算。 */
export interface Terrain {
  id: Id;
  name: string;
  color: string;
  blocksMove: boolean;
  visionCoef: number;
  /**
   * 能不能跨过去。只有 blocksMove 为 true 才有意义。
   * 不填 = true（默认能跨）。
   * - 墙：false，跳也跳不过去
   * - 坑：true，挡路但能跳过去
   */
  crossable?: boolean;
}

/** 独立材质层。地形决定通行/视线，材质只决定表面（颜色，贴图/脚步声/摩擦先留字段）。 */
export interface Material {
  id: Id;
  name: string;
  color: string;
  texture?: string; // 贴图媒体 ID（预留）
  footstep?: string; // 脚步声媒体 ID（预留）
  friction?: number; // 摩擦（预留，0–10）
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
  revealed?: { tier: Tier; scope: 'party' | 'private'; to?: string; recipients?: Id[]; at: number };
  discoveries?: Record<Id, { tier: Tier; at: number }>; // 自动发现按当时的接收角色保存，不随换组转发
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
  /** 位置吸附到 1/3 格：0/1/2，表示锚点在大格里的第几个小格。尺寸仍按整格。 */
  anchor?: Point;
  height: number; // 米。2.5D：同层物件的高度
  color: string;
  icon: string;
  identity?: { party?: boolean; recipients?: Id[] }; // 名称/图标辨识，独立于视野共享
  states: string[];
  state: number;
  /** 只有这些状态挡路、挡视线（空列表＝永远不挡）。不写就按 height 算，兼容旧物件。 */
  blocksWhen?: number[];
  /** False removes the object from the scene without deleting its data. Omitted means enabled. */
  enabled?: boolean;
  /** Optional fine geometry. x/y/w/h are metadata bounds, never furniture collision. */
  geometry?: { kind: 'wall'; a: Point; b: Point; thickness: number; material: 'wall' | 'glass' };
  opening?: { wallId: Id; offset: number; width: number; openStates: number[] };
  physical?: { blocksMove?: boolean; blocksSight?: boolean };
  /**
   * 门上的锁。门本身的开合还是 states；锁是正交的第二位。
   * keyable=false = 锁芯卡死：门仍锁着，但配不出钥匙了，只能强行打开。
   */
  lock?: { kind: 'physical' | 'electronic'; locked: boolean; keyable: boolean; /** 电子锁的密码：作者在检查器里设；只给主持人，不进玩家载荷。 */ code?: string };
  /** 可推动：试玩时走过去会把整件东西向同方向推一格（推书架、推车）。 */
  pushable?: boolean;
  /** 沉重：要另一个棋子也贴着这件东西，才能推。做成需要两人合力。 */
  heavy?: boolean;
  stateRev?: number; // 状态改过几次（自动加一）：流程图撤销时用来判断之后有没有被别人改过
  notes: string; // 只有主持人看得到
  hidden: boolean; // 对玩家隐藏
  secrets: Secret[];
  media: MediaAttach[];
}

export interface RoomObjectSnapshot { id: Id; x: number; y: number; state: number; enabled?: boolean; anchor?: Point }
export interface RoomLayout { id: Id; name: string; description?: string; interactive?: boolean; objects: RoomObjectSnapshot[]; doors?: { id: Id; open: boolean }[] }

/** 房间：按格子刷出来的命名区域。tags 预留给十二宫、八门等对应关系。 */
export interface Room {
  id: Id;
  name: string;
  color: string;
  note: string;
  tags: string[];
  /** 分区复位：这个房间里物件的位置和状态。带团中途点「复位」就回到这里。 */
  reset?: { at: number; objects: RoomObjectSnapshot[]; doors?: { id: Id; open: boolean }[] };
  layouts?: RoomLayout[];
  activeLayoutId?: Id;
}

/** 暂时不能行动（晕厥、泡温泉……）：自由行动时按真实时间倒数，战斗中换算成回合（1 回合 = 5 分钟）。 */
export interface TokenStatus {
  /** 机制类状态（濒死、流血……）放在 combat.ts，这里仍然是给玩家看的文字状态。 */
  label: string;
  endsAt?: number; // 自由行动：真实时间（毫秒）
  roundsLeft?: number; // 战斗中：还剩几回合
}

export interface Point { x: number; y: number }
/** 全图子格网格顶点，1 单位 = 250mm；墙厚以中心线向两侧等分。 */
export interface Wall { id: Id; a: Point; b: Point; thickness: number; material: 'wall' | 'glass' }
export interface ArchitectureDoor { id: Id; wallId: Id; offset: number; width: number; open: boolean }
export interface Architecture { walls: Wall[]; doors: ArchitectureDoor[] }
/** 已裁切的可见几何，坐标单位为主格；不带原墙端点/隐藏门状态。 */
export interface ArchitectureFragment { x: number; y: number; w: number; h: number; material: 'wall' | 'glass' | 'door' | 'opening' }

export interface Token {
  id: Id;
  pcId: Id | null;
  name: string;
  color: string;
  x: number;
  y: number;
  subcell?: Point; // 绝对子格单元索引，其中心是人物位置；x/y 仍为所属主格
  status?: TokenStatus;
  facing?: Facing; // 不填＝全向
  /** 这个人死了，棋子在图上是一具尸体：不能行动、不能被治疗，但队友能搬。 */
  corpse?: boolean;
  stance?: Stance; // 不填＝站
  /** 这一轮已经借机攻击过；轮到它自己行动时重新亮起。 */
  opportunityUsed?: boolean;
  /** 棋子自己的 hp/hpMax（NPC 用；玩家角色的血在角色卡上）。 */
  hp?: number;
  hpMax?: number;
  /** 钝器把人打晕：昏厥中，不能行动。 */
  down?: boolean;
}

/** 抽象滑块棋盘：位置均为地图绝对格坐标；goal 对应目标块的左上角。只平移，不要求人物站到推动侧。 */
export interface SlidingPuzzle {
  id: Id;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  objectIds: Id[];
  targetId?: Id;
  goal?: { x: number; y: number };
  gateId?: Id; // 三项全无＝自由滑块区；全有＝目标到位开门（0=关闭、1=打开，blocksWhen=[0]）
}

export interface GameMap {
  id: Id;
  name: string;
  layer: string; // 现实 / 梦境 / 任意
  floor: number;
  width: number;
  height: number;
  /** 一大格多少厘米。默认 75；只影响尺度和贴墙精度，规则仍按格算。必须是 75 的整倍数或整因数。 */
  cellCm?: number;
  cells: string[]; // terrain id，'' = 空
  d100: number[]; // 1 = D100 区域
  /**
   * 每格相对本层地面的高度，单位是「格」（1 格 = 0.75 米）。
   * 不填就是 0（平地）。跳跃、攀爬、高度恐惧都按这个算。
   * 跟 cells 一样长，key = y * width + x。
   */
  heights?: number[];
  fog: number[]; // 0 = 没去过（黑），1 = 现在看得见，2 = 去过、现在看不见（灰，显示记忆）
  seen: Memory; // 玩家对这张图的记忆：上一次看见时的样子
  autoFog: boolean; // 自动视野：按玩家角色的视线算迷雾
  rooms: Room[];
  roomCells: string[]; // 每格属于哪个房间，'' = 不属于任何房间
  views: Record<Id, VisionLayer>; // 视野各自独立时，每个玩家角色（pcId）自己的一份迷雾和记忆
  spawn: { x: number; y: number } | null; // 试玩出生点（null = 自动：最北、最居中的门外）
  objects: MapObject[];
  /** 独立材质层：主格材质 id；没有就不覆写地形颜色。 */
  materialCells?: Record<number, Id>;
  /** 细分格的材质覆盖；key 和 subCells 一样。 */
  materialSubCells?: Record<number, Id>;
  subdivisions?: number[];
  /** 子格地形覆盖：key = sy3 * width*3 + sx3，仅对细分过的格子生效；没有的退回 cells。 */
  subCells?: Record<number, string>;
  architecture?: Architecture;
  architectureFragments?: ArchitectureFragment[]; // 仅玩家同步的实时可见片段
  subFog?: Record<number, number>; // key = sy*(width*3)+sx，仅明确细分处
  slidingPuzzles?: SlidingPuzzle[];
  tokens: Token[];
  notes: string;
  variantOf?: Id; // 从哪张图复制来的（为以后的"继承"预留）
}

/** 玩家记得的物件样子。回到灰区之前，物件怎么变玩家都不知道。 */
/** 发给玩家窗口的技能说明：只有公开的那部分，私有实现不进玩家端数据。 */
export interface PublicSkill { id: string; name: string; pathway: string; group: string; sequence: number; desc: string; me: number }

export interface SeenObject {
  id: Id;
  name: string;
  icon: string;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
  anchor?: Point;
  height: number;
  identity?: { party?: boolean; recipients?: Id[] };
  stateLabel: string | null; // 只有一个状态的物件不显示状态
}

/** 一份迷雾 + 记忆。全队共享时就是地图上的 fog / seen；各自独立时每个人一份。 */
export interface VisionLayer {
  subFog?: Record<number, number>;
  fog: number[];
  seen: Memory;
}

export interface Memory {
  cellRevs?: number[];
  subRevs?: Record<number, number>;
  architectureRevs?: Record<number, number>;
  observed?: Record<number, number>; // 子格空间的实际观察版本，空地同样是消失证据
  objectRevs?: Record<Id, number>;
  architecture?: ArchitectureFragment[];
  subCells?: Record<number, string>;
  materialCells?: Record<number, Id>;
  materialSubCells?: Record<number, Id>;
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

/** 性别：只影响默认身高（男 173、女 164）。 */
export type Sex = '男' | '女' | '其他';
/** 姿态：站、蹲、趴。蹲／趴的眼高锁死。 */
/** 躺下基本丧失行动能力：要先用行动点翻身变趴，或者站起来。 */
export type Stance = '站' | '坐' | '蹲' | '躺' | '趴';
/** 面向：4 向，不做斜向。 */
export type Facing = '北' | '东' | '南' | '西';

export interface PC {
  visionGroupId?: Id | null; // undefined = 公共组，null = 独立
  id: Id;
  name: string;
  tags: string[]; // 途径/职业，例如 工程师、歌唱家
  color: string;
  sex?: Sex; // 不填按「其他」算，默认身高 170
  heightCm?: number; // 不填按性别默认
  skills?: string[]; // 已解锁的技能 id（技能数据随编辑器走）
  /** 当前发动的途径。只能发动这个途径下的技能；换途径要付 1 ME。不填就按第一个已解锁技能的途径算。 */
  pathway?: string;
  /** 当前 ME。角色卡还没导入时留空：留空就不扣也不拦。 */
  me?: number;
  meMax?: number;
  /** 头像：编辑器里压成 96×96 的小图，data URL 存在工程里，跟着工程走。 */
  avatar?: string;
  /** 六维总属性（力量/敏捷/意志/观察/智慧/魅力）。判定按 ÷5 取区值；没填就不参与战斗结算。 */
  attributes?: Record<string, number>;
  /** 当前 / 上限 HP。不填就按公式算上限，当前视为满。 */
  hp?: number;
  hpMax?: number;
  /**
   * 带着锐器。只有勾了才对「锐器」攻击给出可选项；
   * 钝器把人打晕是「昏厥」，锐器才是「濒死」。
   */
  sharp?: boolean;
  /** 死了：卡留在队里但标成已死亡，棋子变成尸体留在原地。 */
  dead?: boolean;
  /** 死在哪：地图 id 和小格坐标。尸体被搬走时跟着改。 */
  deathPlace?: { mapId: Id; x: number; y: number } | null;
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
  via?: Id; // 发生时实际是从哪条连线过来的（记下来，不靠时间去猜）
  applied?: { mapId: Id; objectId: Id; from: number; to: number; rev?: number }; // 发生时真的改了哪个物件（撤销时改回去）；rev = 改完后的 stateRev
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
  /** 这条日志是从哪条物理事件渲染来的（events 只留 200 条，日志不截断，靠它对回结构） */
  eventId?: Id;
}

export interface MediaMeta {
  id: Id;
  name: string;
  mime: string;
  size: number;
  key?: string; // 浏览器里的存储名（v:内容哈希）。写进去就不改；没有就按 id 存（旧数据）
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
  audience?: Id[]; // 只在发给玩家窗口的世界里有：哪些角色看得到这个标记（在完整的世界里算好的）
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
  cast?: boolean; // 本场安排出场：备团时主持人按玩家已知的信息和今天的日期挑
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

/**
 * 开出来、等玩家自己掷的判定。见证者只宣告（名称 / 骰子 / 发生角色 / 预先写好的裁定），
 * 骰子由玩家在自己的窗口里掷；玩家不能拒掷，只有见证者能整个取消。
 */
/**
 * 一次跳跃的请求。判定掷完，见证者点「按结果执行」时按它结算。
 * 只在主持端用，推给玩家窗口时不带这个字段。
 */
export interface JumpRequest {
  tokenId: Id;
  /** 起跳方向。 */
  dx: number;
  dy: number;
  kind: 'across' | 'up' | 'down';
  /** 平行跳＝坑宽；往上/往下＝落差格数。 */
  cells: number;
  /** 失败会掉几格。 */
  fall: number;
  /** 检定属性；null = 不用掷。 */
  attr: '敏捷' | '力量' | '意志' | null;
  /** 这项属性的骰：一颗／优势骰／劣势骰。不写就是一颗。 */
  dice?: 'single' | 'advantage' | 'disadvantage';
  /** 落点：成功就把棋子挪到这。 */
  landing: { x: number; y: number };
  /** 落点在往前第几格（坑宽 + 1），用来算移动点。 */
  landingStep?: number;
  /** 起跳时的每格单价，结算时按它扣移动点。 */
  unitPrice?: number;
  /** 失败摔伤档；默认按 fall 算。 */
  injury: 'light' | 'medium' | 'heavy' | 'brutal' | null;
  /** 不用检定也必定摔下去（往下 6 格以上）。没有它，无属性检定会被当成“成功落地”。 */
  forcedFall?: boolean;
  /** 移动点单价倍数。 */
  moveMultiplier: number;
  /** 做完要不要占掉这回合的行动点（往上 2 格以上、没【攀爬】、以及 12 格以上都要占）。 */
  usesAction?: boolean;
}

/** 跳跃判定失败后，摔伤骰那一棒的记录。 */
export type FallInjury = 'light' | 'medium' | 'heavy' | 'brutal';

/** 已经掷完的属性检定，原样带进第二个判定和最终事件。 */
export interface JumpCheckRecord {
  attr: string;
  dice: 'single' | 'advantage' | 'disadvantage';
  rolls: number[];
  used: number;
  value: number;
  total: number;
  dc: number;
  success: boolean;
  tier: 'crit' | 'fumble' | null;
  outcome: string;
  rolledBy: 'player' | 'witness' | 'host';
}

/** 摔伤骰的待掷请求：第一颗属性骰已经掷完（或本来就不用掷），等第二颗。 */
export interface FallRequest {
  mapId: Id;
  tokenId: Id;
  req: JumpRequest;
  check: JumpCheckRecord | null;
  injury: FallInjury;
}

/** 玩家窗口里正在等玩家输入密码的那扇门。只给名字，不带作者密码。 */
export interface CodeRequest {
  id: Id;
  mapId: Id;
  objectId: Id;
  name: string;
  pcId: Id;
  at: number;
  /** 已经提交过密码：玩家刷新窗口后知道自己在等主持人反馈。 */
  submitted?: boolean;
}

/** 密码裁定：现在主持人填 text；verdict/hits/positions 留给以后的 AI，不逼主持人填。 */
export interface CodeFeedback {
  text: string;
  verdict?: 'correct' | 'partial' | 'wrong' | 'alarm' | 'custom';
  hits?: number;
  positions?: boolean[];
  pushToPlayer: boolean;
}

/** 主持人侧的一次密码尝试。code 是玩家输入原文，只存在 UI 里，落事件时不写。 */
export interface PendingCodeAttempt {
  id: Id;
  mapId: Id;
  objectId: Id;
  tokenId: Id;
  pcId: Id;
  name: string;
  expectedCode: string | null;
  code: string | null;
  at: number;
  /** 有玩家窗口就等窗口输入；没有就主持人在卡片上代输。 */
  fromWindow: boolean;
  /** 开这笔等待时的上下文；切换工程/试玩后不能结算到另一个世界。 */
  context: string;
}

/** 撞门大失败的反伤：第一颗力量骰已掷完，等 1D4。 */
export interface RamImpact {
  mapId: Id;
  objectId: Id;
  tokenId: Id;
  /** 第一颗的原始点数；第二颗落总事件时用它重建 check。 */
  checkValues: number[];
  checkBy: 'player' | 'witness' | 'host';
}

export interface PendingJudgment {
  id: Id;
  title: string;
  ruling: string;
  sides: 4 | 6 | 8 | 10 | 12 | 20 | 100;
  subjectId: Id;
  place?: { mapId: Id; x: number; y: number } | null;
  at: number;
  session: number;
  /** 见证者代掷：玩家不在电脑前，或者用的是实体骰时走这条。 */
  standIn?: boolean;
  /** 这一发判定是为一次跳跃开的：掷完要按结果真的挪棋子/扣血。 */
  jump?: JumpRequest | null;
  /** 第二棒：属性骰已经掷完，等玩家掷摔伤骰；结算时才挪棋子/扣血。 */
  fall?: FallRequest | null;
  /** 只告诉玩家这颗骰要掷几次（优/劣势）；不含落点、摔伤档等结算数据。 */
  dice?: 'single' | 'advantage' | 'disadvantage';
  /** 这一发判定是为一次攻击开的：掷完按攻击口径结算知会。 */
  attack?: { attackerTokenId: string; targetTokenId: string; sharp?: boolean } | null;
  /** 这一发判定是为一次撬锁/暴力开锁开的：掷完按门锁规则结算。 */
  door?: { mapId: Id; objectId: Id; method: 'pick' | 'force' | 'ram' } | null;
  /** 第二棒：撞门大失败后，等这颗 1D4 反伤。 */
  ramImpact?: RamImpact | null;
  /**
   * 多属性判定的口径。没写就是单骰的普通判定。
   * 撬锁用：智慧＋敏捷（巧力）/ 力量＋敏捷（暴力），都要过。
   */
  check?: {
    attrs: { attr: string; dice: 'single' | 'advantage' | 'disadvantage' }[];
    dc: number;
    merge: 'single' | 'any' | 'all';
  } | null;
  /** 开出这笔判定时的上下文（`worldContext()`）。结算前要比对：换工程/进出试玩后旧判定不能再结。 */
  context?: string;
}

/**
 * 试玩里发生的一次攻击，推给「跟他有关」的玩家看。
 * 只带结果，不带骰子内部：玩家看见的是「谁打谁、命中没、掉了多少血」。
 */
export interface CombatNotice {
  id: Id;
  at: number;
  kind: 'hit' | 'miss';
  attackerName: string;
  attackerPcId: string | null;
  targetName: string;
  targetPcId: string | null;
  roll: number;
  crit: boolean;
  /** 伤害骰颗数：普通 1、大成功 2、特大成功 4。旧卡片没有就当 1 颗。 */
  dice?: number;
  damage: number;
  hpBefore: number | null;
  hpAfter: number | null;
  hpMax: number | null;
  downed?: 'down' | 'dying' | null;
  note?: string;
  /** 我是打人的那个，还是挨打的那个。玩家端据此换措辞。 */
  role: 'attacker' | 'target' | 'bystander';
}

export interface DiceJudgment {
  id: Id;
  title: string;
  ruling: string;
  recipients: Id[]; // 正式判定一律广播给全队；这个字段保留给旧数据
  at: number;
  session: number;
  /** 判定落在哪个角色身上；用它棋子的位置做视野遮蔽的锚点。 */
  subjectId?: Id | null;
  /** 判定发生点（棋子坐标，实际值）；没有就不做遮蔽，全队看细节。 */
  place?: { mapId: Id; x: number; y: number } | null;
  roll: {
    id: string; sides: 4 | 6 | 8 | 10 | 12 | 20 | 100; value: number;
    /** 多属性判定（如智慧＋敏捷）：各属性各一颗，按 attrs 顺序；单属性不填。 */
    values?: number[]; attrs?: string[];
    tens?: number | null; units?: number | null;
    material: 'wood' | 'plastic' | 'metal' | 'stone' | 'rubber'; persona: 'witness' | 'player';
    algorithm?: string; seed: number; launch?: unknown;
  };
}

export interface JudgmentNotice { id: Id; at: number }
/** 一次物理事件的单一记账：A 对 B 发起动作 → 该过什么骰子 → 结果 → 谁什么从多少变成多少。 */
export type Delta =
  | { kind: 'hp'; id: Id; name: string; from: number; to: number }
  | { kind: 'me'; id: Id; name: string; from: number; to: number }
  | { kind: 'moved'; id: Id; name: string; from: { x: number; y: number }; to: { x: number; y: number } }
  | { kind: 'status'; id: Id; name: string; from: string | null; to: string | null }
  | { kind: 'points'; id: Id; name: string; pool: 'move'; from: number; to: number }
  | { kind: 'object'; id: Id; name: string; path: string; from: string | number | boolean | null; to: string | number | boolean | null };

export interface EventActor { kind: 'pc' | 'npc' | 'object' | 'terrain'; id: Id; name: string }

/**
 * 一条物理事件。句子是这条事件的**渲染结果**，不是输入：
 *   `<A> 对 <B> 发起了 <动作>，需要过 <属性>（优势/劣势）`
 *   `<动作> <成功/失败/大成功/大失败>，<谁> 的 <什么> 从 <X> 改为 <Y>`
 * 这样日志、判定记录、事件卡片都是它的视图，以后临场生成分支也从它读状态。
 */
export interface PhysicalEvent {
  id: Id;
  at: number;
  session: number;
  actor: EventActor;
  /** 对谁/对什么。可以没有：移动、感知不对某个人 */
  target?: EventActor;
  action: { id?: Id; name: string; source: '动作库' | '技能' | '临场' };
  /** 判定块。没掷骰就没有这一块 */
  check?: {
    /** check＝属性判定（有 DC）；attack＝攻击（没有 DC，只有档位） */
    kind?: 'check' | 'attack';
    /** 攻击档位（attack 才有） */
    band?: 'miss' | 'hit' | 'great' | 'super';
    scale: 'd20' | 'd100';
    attrs: {
      attr: string; dice: 'single' | 'advantage' | 'disadvantage';
      roll?: number; used?: number; value: number; total?: number;
      /** 逐属性成败；只有感知这类“多项各掷各的”实现才填，渲染日志时用。 */
      success?: boolean;
      /** 逐属性极值；没有极值就是 null。 */
      tier?: 'crit' | 'fumble' | null;
    }[];
    merge: 'single' | 'any' | 'all';
    /** 属性判定才有 DC；攻击没有门槛，别拿 0 当哨兵 */
    dc?: number;
    /** 单属性判定的总数；多属性（如智慧＋敏捷）时各项看 attrs[i].total，这里可以省。 */
    total?: number;
    success: boolean;
    tier: 'crit' | 'fumble' | null;
    /** 特大成功 / 特大失败；普通极值是 null */
    level?: '特大' | null;
    /** 人话的档位（落空/命中/大成功/特大成功）。有它就优先用它渲染，别再自己从 tier 猜。 */
    outcome?: string;
    /** 骰子是谁掷的：玩家自己、见证者代掷、还是主机给 NPC 现掷 */
    rolledBy?: 'player' | 'witness' | 'host';
    /** 优势/劣势的第二颗（谁掷的记清楚） */
    extra?: { roll: number; by: 'witness' | 'auto' };
  };
  deltas: Delta[];
  /** 摔伤骰：不是属性检定，单独记骰面和档位，账本和卡片都读它。 */
  damage?:
    | { kind: 'fall'; sides: 4 | 6 | 8 | 10 | 12 | 20; roll: number; by: 'player' | 'witness' | 'host'; tier: FallInjury }
    /** 撞门这类反伤：只记骰面和点数，不记伤档。 */
    | { kind: 'impact'; sides: 4; roll: number; by: 'player' | 'witness' | 'host' };
  /** A 得到的信息：不改变世界，只改变认知 */
  knowledge?: { subject: Id; label: string; tier: string }[];
  /** 见证者当场写的裁定 */
  ruling?: string;
  /** 不是状态变化的补充说明（比如「目标没有血条，伤害没落地」）。账本里也要能读到，不能只在 UI 卡片上。 */
  note?: string;
}

export interface World {
  judgments?: DiceJudgment[];
  /** 只在玩家载荷里：最新一次判定不在他视野内，只给这个通知。 */
  judgmentNotice?: JudgmentNotice | null;
  /** 只在玩家载荷里：落在自己身上、等自己掷的判定。别人的判定不会发过来。 */
  pendingJudgment?: PendingJudgment | null;
  /** 只在玩家载荷里：正在等自己输入密码的门。 */
  pendingCode?: CodeRequest | null;
  /** 只在玩家载荷里：最近一次跟他有关的攻击。 */
  combatNotice?: CombatNotice | null;
  /** 这一场这个角色说过的所有话，按时间正序。 */
  utterances?: Utterance[] | null;
  /** 只在玩家载荷里：试玩里这个窗口自己的处境——被暂停了？轮到他了吗？ */
  trialFlags?: { paused: boolean; isCurrent: boolean } | null;
  version: 1;
  name: string;
  terrains: Terrain[];
  materials?: Material[];
  maps: GameMap[];
  connections: Connection[];
  party: PC[];
  flows: Flow[];
  lines?: Line[]; // 旧版，迁移后删除
  log: LogEntry[];
  /** 最近发生过的物理事件（按时间正序，只留最近 EVENT_CAP 条）。 */
  events?: PhysicalEvent[];
  media: MediaMeta[];
  session: number;
  playerMapId: Id | null;
  visionMode: 'shared' | 'individual' | 'grouped';
  visionGroups?: { id: Id; name: string }[]; // 公共组隐含存在，不能删除
  observationSeq?: number;
  viewerId?: Id; // 仅定向玩家载荷，由主持人绑定
  marks: Mark[];
  npcs: Npc[];
  labels?: Record<Id, string>; // 只在发给玩家窗口的世界里有：删东西之前算好的编号，保证和主持人那边一致
  clues?: PlayerClue[]; // 只在发给玩家窗口的世界里有：全队公开过的线索（物件看不见了也不会忘）
}

/** 玩家窗口的线索列表里的一条（只带揭示到的那一档）。 */
export interface PlayerClue { id: Id; object: string; label: string; kind: 'auto' | 'roll'; check: string; tier: Tier; text: string; at: number }

/** 统一"暂停/焦点"：战斗中、技能发动、对话都可能暂停别人，暂停逻辑只读这个。 */
export type FocusKind = 'battle' | 'skill' | 'dialogue';
export interface Focus {
  kind: FocusKind;
  actorPcId?: string;
  label?: string;
}

/** 技能发动状态机。玩家发起和见证者代发起共用这一份状态。 */
export type CastStep = 'approval' | 'confirm' | 'result';
export interface SkillCast {
  /** 这次发动的 ME 消耗（含换途径的 1 点）。 */
  meCost?: number;
  /** 换途径：从哪个途径换到哪个。 */
  pathwayFrom?: string;
  pathwayTo?: string;
  /** 已经扣掉的 ME（取消时按这个数退）。 */
  charged?: number;
  /** 强行发动：ME 不够也发，代价是晕厥（由见证者定多长）。 */
  overdrawn?: boolean;
  id: string;
  actorPcId: string;
  skillId: string;
  initiator: 'player' | 'gm';
  step: CastStep;
  target?: string;
  expiresAt?: number;
  roll?: number;
  total?: number;
  success?: boolean | null;
  note?: string;
}

/**
 * 玩家说的一句话。
 *
 * 这里刻意不给「动作类型」下拉框：玩家想干什么就说什么（「我要去跟那傻子评评理」），
 * 由见证者（以后加上本地模型）去理解它对应哪个动作。限制在枚举上会先把想象力削掉。
 */
export interface Utterance {
  id: Id;
  pcId: Id;
  pcName: string;
  /** 玩家原话，不改一个字。 */
  text: string;
  /** 说给谁听；不填就是对着场上所有人。 */
  targetTokenId?: Id | null;
  targetName?: string | null;
  mapId: Id;
  at: number;
  session: number;
  /**
   * 见证者把它落成了什么动作。空着就是「还没接住」。
   * actionId 对应动作库编号；roll 是随后那次判定的骰点。
   */
  resolution?: {
    actionId?: string;
    label: string;
    roll?: number | null;
    outcome?: string | null;
    by: 'witness' | 'ai';
    at: number;
  } | null;
}
