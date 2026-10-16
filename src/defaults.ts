import type { Effect, FlowNode, GameMap, MapObject, Terrain, World } from './types';
import { uid } from './util';

export const DEFAULT_TERRAINS: Terrain[] = [
  { id: 'floor', name: '地板', color: '#d9cbb0', blocksMove: false, visionCoef: 0.1 },
  { id: 'wall', name: '墙', color: '#4a4036', blocksMove: true, visionCoef: 99 },
  { id: 'window', name: '窗', color: '#9cc9e0', blocksMove: true, visionCoef: 0.5 },
  { id: 'grass', name: '草丛', color: '#7fa65a', blocksMove: false, visionCoef: 2 },
  { id: 'rug', name: '地毯', color: '#a8505a', blocksMove: false, visionCoef: 0.1 },
  { id: 'water', name: '水', color: '#5a8fc0', blocksMove: false, visionCoef: 0.1 },
  { id: 'hole', name: '洞', color: '#1a1420', blocksMove: false, visionCoef: 0.1 },
];

export function newMap(name: string, layer: string, floor: number, w: number, h: number, fill = 'floor', walls = true): GameMap {
  const cells: string[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      cells.push(walls && (x === 0 || y === 0 || x === w - 1 || y === h - 1) ? 'wall' : fill);
  return {
    id: uid(), name, layer, floor, width: w, height: h, cells,
    d100: new Array(w * h).fill(0), fog: new Array(w * h).fill(0),
    seen: { cells: new Array(w * h).fill(''), objects: [] }, autoFog: true,
    rooms: [], roomCells: new Array(w * h).fill(''), views: {}, spawn: null,
    objects: [], tokens: [], notes: '',
  };
}

export function newObject(kind: 'object' | 'zone', x: number, y: number, w: number, h: number): MapObject {
  return {
    id: uid(), kind, x, y, w, h,
    name: kind === 'zone' ? '触发区' : '新物件',
    height: kind === 'zone' ? 0 : 1,
    color: kind === 'zone' ? '#7aa2f7' : '#b08968',
    icon: '', states: ['默认'], state: 0, notes: '', hidden: false, secrets: [], media: [],
  };
}

export function emptyWorld(): World {
  const m = newMap('一楼', '现实', 1, 24, 16);
  return {
    version: 1, name: '未命名世界', terrains: structuredClone(DEFAULT_TERRAINS),
    maps: [m], connections: [], party: [], log: [], media: [],
    flows: [{ id: uid(), name: '主线', mapId: null, edges: [], nodes: [{ id: uid(), title: '开场', x: 40, y: 40, kind: 'start', effect: null, origin: 'predicted', status: 'predicted' }] }],
    session: 1, playerMapId: null, visionMode: 'shared', marks: [], npcs: [],
  };
}

/** 示例数据：只是占位，展示各功能怎么用，不是模组内容。 */
export function demoWorld(): World {
  const w = emptyWorld();
  w.name = '爱丽丝模组（示例数据）';

  const study = newMap('书房', '现实', 1, 20, 14);
  study.notes = '现实层的书房。一切正常。';
  for (let x = 4; x <= 7; x++) study.cells[x] = 'window';
  for (let y = 6; y <= 8; y++) for (let x = 8; x <= 11; x++) study.cells[y * 20 + x] = 'rug';
  for (let y = 1; y <= 6; y++) for (let x = 1; x <= 8; x++) study.fog[y * 20 + x] = 1;

  const shelf = {
    ...newObject('object', 1, 1, 5, 1), name: '高书架', icon: '📚', height: 2.4, color: '#6b4f3a', states: ['整齐', '被翻乱'],
    secrets: [{
      id: uid(), label: '倒放的书', check: '', kind: 'auto' as const, range: 5,
      tiers: { crit: '', success: '书架最顶层有一本书是倒着放的。', fail: '', fumble: '' },
    }],
  };
  const door = {
    ...newObject('object', 18, 9, 1, 1), name: '小门', icon: '🚪', height: 0.4, color: '#c9a227', states: ['锁着', '打开'],
    secrets: [{
      id: uid(), label: '门缝', check: '观察', kind: 'roll' as const, range: 1,
      tiers: {
        crit: '门缝里塞着一把金色小钥匙，钥匙柄上刻着一行小字。',
        success: '门缝里好像有东西在反光。',
        fail: '只是一扇很小的门。',
        fumble: '你凑得太近，门缝里吹出一阵风，你打了个大喷嚏，惊动了什么。',
      },
    }],
  };
  const table = {
    ...newObject('object', 12, 3, 2, 2), name: '玻璃桌', icon: '🍶', height: 0.9, color: '#a7c4c2', states: ['瓶子在桌上', '瓶子被拿走'],
    secrets: [{
      id: uid(), label: '瓶子的标签', check: '观察', kind: 'roll' as const, range: 1,
      tiers: {
        crit: '标签上写着"喝我"，背面还有一行更小的字。',
        success: '标签上写着"喝我"。',
        fail: '瓶子里装着某种液体。',
        fumble: '你碰歪了瓶子，洒出来几滴，地板上冒起一缕烟。',
      },
    }],
  };
  const hole = { ...newObject('zone', 9, 7, 2, 1), name: '地毯下的洞', notes: '走上来触发坠落。' };
  study.objects = [shelf, door, table, hole];

  const dream = structuredClone(study);
  dream.id = uid();
  dream.layer = '梦境';
  dream.variantOf = study.id;
  dream.fog = dream.fog.map(() => 0);
  dream.seen = { cells: dream.cells.map(() => ''), objects: [] };
  dream.notes = '梦境层的书房：同一个地方，但坏掉了。';
  dream.objects = dream.objects.map((o) => ({ ...o, id: uid() }));
  for (let y = 5; y <= 9; y++) for (let x = 7; x <= 12; x++) { dream.cells[y * 20 + x] = 'hole'; dream.d100[y * 20 + x] = 1; }
  dream.objects[0] = { ...dream.objects[0], height: 9, name: '无限高的书架' };

  const upstairs = newMap('阁楼', '现实', 2, 12, 10);

  w.maps = [study, upstairs, dream];
  w.connections = [
    { id: uid(), kind: 'stairs', label: '通往阁楼', a: { mapId: study.id, x: 17, y: 1 }, b: { mapId: upstairs.id, x: 1, y: 1 }, hidden: false },
    { id: uid(), kind: 'portal', label: '梦境入口', a: { mapId: study.id, x: 10, y: 7 }, b: { mapId: dream.id, x: 10, y: 7 }, hidden: true },
  ];
  const eng = { id: uid(), name: '示例·工程师', tags: ['工程师'], color: '#e07a5f' };
  const singer = { id: uid(), name: '示例·歌唱家', tags: ['歌唱家'], color: '#81b29a' };
  w.party = [eng, singer];
  study.tokens = [
    { id: uid(), pcId: eng.id, name: eng.name, color: eng.color, x: 3, y: 4 },
    { id: uid(), pcId: singer.id, name: singer.name, color: singer.color, x: 5, y: 4 },
  ];
  // 示例流程图：一般人走上面几条，有工程师/歌唱家多出分支，琴师那条因为队里没人而锁住
  const pos = (row: number, i: number, n: number) => ({ x: 40 + ((3 - n) * 210) / 2 + i * 210, y: 40 + row * 122 });
  const node = (title: string, p: { x: number; y: number }, kind: FlowNode['kind'] = 'event', effect: Effect | null = null): FlowNode =>
    ({ id: uid(), title, ...p, kind, effect, origin: 'predicted', status: 'predicted' });
  const S = node('开场：走进书房', pos(0, 1, 3), 'start');
  const E = node('书架共振，书掉了一地', pos(1, 0, 3), 'event', { mapId: study.id, objectId: shelf.id, toState: 1 });
  const C = node('拿起玻璃桌上的瓶子', pos(1, 1, 3), 'event', { mapId: study.id, objectId: table.id, toState: 1 });
  const G = node('地毯浮了起来', pos(1, 2, 3));
  const A = node('发现门缝里的钥匙', pos(2, 0, 1));
  const B = node('小门打开了', pos(3, 0, 1), 'event', { mapId: study.id, objectId: door.id, toState: 1 });
  const F = node('进入梦境', pos(4, 0, 1), 'ending');
  const edge = (from: FlowNode, to: FlowNode, label: string, condition = '', chance: number | null = null) =>
    ({ id: uid(), from: from.id, to: to.id, label, condition, chance });
  w.flows = [{
    id: uid(), name: '书房', mapId: study.id, nodes: [S, E, C, G, A, B, F],
    edges: [
      edge(S, A, '观察小门', '', 40), edge(S, B, '直接拆锁', '工程师', 20), edge(S, C, '拿起瓶子', '', 30),
      edge(S, E, '唱歌', '歌唱家', 10), edge(S, G, '弹琴', '琴师'),
      edge(E, A, '掉下的书里夹着钥匙'), edge(A, B, '用钥匙开门'),
      edge(B, F, '钻过小门'), edge(C, F, '喝下去，变小'), edge(G, F, '踩上地毯'),
    ],
  }];
  w.playerMapId = study.id;
  return w;
}

/** 车卡资料里出现过的途径/职业，只用作输入提示。 */
export const PATHWAY_SUGGESTIONS = [
  '工程师', '歌唱家', '琴师', '游戏鉴赏家', '游戏主播', '算法工程师', '穿搭博主', '攻心', '美少女战士',
  '控场', '传说', '玩家', '童话', '骑士', '连接', '未解之谜研究者', '天眼', '侍者', '阿尼玛', '阿尼姆斯',
  '户外博主', '自由裁缝', '学习家',
];
