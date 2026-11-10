// 工具栏的数据和快捷键规则。单独一个文件，不碰 React、不碰 store，
// 所以能单独测；Sidebar 只负责把它画出来。
import type { Mode, Tool } from '../core/store';

/** 工具按「你在改什么」分组，不是按功能分类。加新工具往对应组里塞就行。 */
export type ToolGroup = 'view' | 'terrain' | 'arch' | 'height' | 'content' | 'fog';

export const GROUP_LABEL: Record<ToolGroup, string> = {
  view: '视图', terrain: '地形', arch: '建筑', height: '高度', content: '内容', fog: '迷雾',
};

export const GROUP_ORDER: ToolGroup[] = ['view', 'terrain', 'arch', 'height', 'content', 'fog'];

/** 每个工具的 [工具, 标签, 快捷键]。 */
export const ALL_TOOLS: [Tool, string, string, ToolGroup][] = [
  ['select', '选择/移动', 'V', 'view'],
  ['pan', '平移地图', 'P', 'view'],
  ['paint', '画笔', 'B', 'terrain'],
  ['fill', '矩形填充', 'R', 'terrain'],
  ['erase', '橡皮', 'E', 'terrain'],
  ['room', '房间', 'M', 'terrain'],
  ['d100', 'D100 区域', 'D', 'terrain'],
  ['subdivide', '细分为3×3', '', 'terrain'],
  ['unsubdivide', '取消细分', '', 'terrain'],
  ['wall', '薄墙', '', 'arch'],
  ['glass', '玻璃墙', '', 'arch'],
  ['archDoor', '建筑门', '', 'arch'],
  ['archErase', '擦除建筑', '', 'arch'],
  ['heightBrush', '抬高 / 压低', 'U', 'height'],
  ['heightRect', '框选抬高', 'U', 'height'],
  ['object', '物件', 'O', 'content'],
  ['zone', '触发区', 'Z', 'content'],
  ['conn', '连接点', 'C', 'content'],
  ['token', '棋子', 'T', 'content'],
  ['fogReveal', '迷雾：看得见', 'F', 'fog'],
  ['fogHide', '迷雾：变灰', 'G', 'fog'],
  ['fogBlack', '迷雾：抹黑', 'H', 'fog'],
];

/** 字母 → 这个字母下的工具。单工具就是 [t]，双工具就是 [t1, t2]。 */
export const KEY_TOOLS: Record<string, Tool[]> = (() => {
  const m: Record<string, Tool[]> = {};
  for (const [t, , k] of ALL_TOOLS) if (k) (m[k.toLowerCase()] ??= []).push(t);
  return m;
})();

/** 一个字母带多个工具的，就是双按切换的那几个。 */
export const SHARED_KEYS: Record<string, Tool[]> =
  Object.fromEntries(Object.entries(KEY_TOOLS).filter(([, v]) => v.length > 1));

/** 单工具的字母表，老的调用方照旧能用。 */
export const TOOL_KEYS = Object.fromEntries(ALL_TOOLS.map(([t, , k]) => [k.toLowerCase(), t])) as Record<string, Tool>;

const TOOL_LABEL = new Map(ALL_TOOLS.map(([t, label]) => [t, label]));
export const toolLabel = (t: Tool): string => TOOL_LABEL.get(t) ?? t;

/** 编辑地图 = 形状；备团 = 内容；带团 = 跑。 */
export const MODE_TOOLS: Record<Mode, Tool[]> = {
  edit: ['pan', 'subdivide', 'unsubdivide', 'wall', 'glass', 'archDoor', 'archErase', 'select',
    'paint', 'fill', 'erase', 'object', 'zone', 'conn', 'room', 'd100', 'heightBrush', 'heightRect'],
  prep: ['select', 'pan', 'token', 'fogReveal', 'fogHide', 'fogBlack'],
  run: ['select', 'pan', 'token', 'fogReveal', 'fogHide', 'fogBlack'],
};

/** 当前能用的工具：解锁时把「编辑地图」的工具也加进来。 */
export const toolsFor = (s: { unlock?: boolean; mode: Mode }): Tool[] =>
  s.unlock && s.mode !== 'edit'
    ? [...new Set([...MODE_TOOLS[s.mode], ...MODE_TOOLS.edit])]
    : MODE_TOOLS[s.mode];

/** 每个字母上次用过的工具，双按切换靠它。 */
const lastOf = new Map<string, Tool>();

/**
 * 按一下这个字母该切到哪个工具。
 * - 组里只有一个：直接用它，没有提示
 * - 组里有两个：上次用的优先；当前已经在组里就切到另一个，并给一句提示
 */
export function pickToolForKey(key: string, current: Tool): { tool: Tool; hint: string } | null {
  const group = KEY_TOOLS[key];
  if (!group) return null;
  if (group.length === 1) return { tool: group[0], hint: '' };
  const idx = group.indexOf(current);
  const next = idx >= 0 ? group[(idx + 1) % group.length] : (lastOf.get(key) ?? group[0]);
  lastOf.set(key, next);
  const other = group.find((t) => t !== next)!;
  return { tool: next, hint: `再按一次 ${key.toUpperCase()} 切换到「${toolLabel(other)}」` };
}
