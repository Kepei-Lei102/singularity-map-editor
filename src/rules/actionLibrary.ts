// 公开动作库（src/rules/actions.json）的只读适配层：把动作库的原始列转成判定口径。
// 这里不补效果、不猜来源；效果由「动作 × 物件」的互动档案负责。
import raw from './actions.json';
import { ATTRS, EXTRA_ATTRS, type Attr, type CheckSpec } from './interaction';

export interface RawAction {
  id: string;
  name: string;
  category: string;
  attrs: string[];
  check: { mode: string; basis: string };
  desc: string;
}

export interface ActionCategory {
  name: string;
  definition: string;
}

interface RawFile {
  version: string;
  source: string;
  categories: ActionCategory[];
  actions: RawAction[];
  defaults: unknown[];
}

const file = raw as RawFile;

export const ACTION_VERSION = file.version;
export const ACTION_SOURCE = file.source;
export const ACTION_CATEGORIES: ActionCategory[] = file.categories;
export const ACTION_LIBRARY: RawAction[] = file.actions;

const BY_ID = new Map(ACTION_LIBRARY.map((a) => [a.id, a]));
export const actionById = (id: string): RawAction | undefined => BY_ID.get(id);

const ALL_ATTRS = new Set<string>([...ATTRS, ...EXTRA_ATTRS]);
const asAttrs = (list: string[]): Attr[] => list.filter((x): x is Attr => ALL_ATTRS.has(x));

/** 动作库的「判定口径」文字 → 代码里的 CheckSpec。v0.1 只接能直接掷的几档。 */
export function actionCheckSpec(action: RawAction): { spec: CheckSpec; label: string } | { error: string } {
  const mode = action.check?.mode ?? '';
  switch (mode) {
    case '多来源不同（视环境）':
      return { error: '多来源不同：要按角色的解锁来源取口径，v0.1 面板还接不了' };
    case '双方对照检定':
      return { error: '双方对照检定：要拿对方的属性拼点，v0.1 面板还接不了' };
    case '仅见证者裁决':
      return { error: '仅见证者裁决：不掷骰，先由见证者定档' };
    case '待补':
      return { error: '动作库这一条的判定口径还没补' };
    default:
      break;
  }
  const attrs = asAttrs(action.attrs);
  if (!attrs.length) return { error: '动作库这一条没有填判定属性' };
  switch (mode) {
    case '单属性':
      if (attrs.length !== 1) return { error: '动作库标了单属性，但填了多项属性' };
      return { spec: { attributes: attrs, mode: 'single' }, label: '单属性' };
    case '并集（或）':
      return { spec: { attributes: attrs, mode: 'or' }, label: '并集（或）：任一项过就算过' };
    case '交集（与）':
      return { spec: { attributes: attrs, mode: 'and' }, label: '交集（与）：每一项都要过' };
    case '交集（三检定叠加）':
      // 动作库只有【涉水】一条。作者口径是「三个检定分别过 DC 20，失败一个就算失败」，
      // 所以走 and，不是把三项总数加在一起过 DC 的 sum。
      return { spec: { attributes: attrs, mode: 'and' }, label: '三检定叠加（作者口径：逐项过，失败一个就算失败）' };
    default:
      return { error: `未知判定口径：${mode || '（空）'}` };
  }
}

/** 可在 v0.1 面板里直接掷的动作。 */
export const PANEL_ACTIONS = ACTION_LIBRARY.filter((a) => !('error' in actionCheckSpec(a)));
