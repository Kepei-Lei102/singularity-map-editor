import type { Flow, FlowNode, Line } from './types';
import { uid } from './util';

// 流程图的纯函数部分（不依赖 store，避免循环引用）。

export const NODE_W = 180;
export const NODE_H = 62;

/** 能走到的事件：从开场出发，只走条件满足的连线。走不到的显示为锁住。 */
export function reachable(f: Flow, tags: Set<string>) {
  const incoming = new Set(f.edges.map((e) => e.to));
  const seen = new Set(f.nodes.filter((n) => n.kind === 'start' || !incoming.has(n.id)).map((n) => n.id));
  const queue = [...seen];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of f.edges)
      if (e.from === id && (!e.condition || tags.has(e.condition)) && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
  }
  return seen;
}

/** 旧版列表式预测线 → 流程图。 */
export function linesToFlow(lines: Line[]): Flow {
  const start: FlowNode = { id: uid(), title: '开场', x: 40, y: 40, kind: 'start', effect: null, origin: 'predicted', status: 'predicted' };
  const f: Flow = { id: uid(), name: '预测', mapId: null, nodes: [start], edges: [] };
  lines.forEach((l, i) => {
    let prev = start.id;
    l.steps.forEach((st, j) => {
      const id = uid();
      f.nodes.push({
        id, title: st.text || l.name, x: 40 + i * (NODE_W + 30), y: 40 + (j + 1) * (NODE_H + 60), kind: 'event', effect: st.effect,
        origin: l.origin, status: st.status === 'happened' ? 'happened' : 'predicted', at: st.at, session: st.session,
      });
      f.edges.push({ id: uid(), from: prev, to: id, label: j === 0 ? l.name : '', condition: j === 0 ? l.condition : '', chance: null });
      prev = id;
    });
  });
  return f;
}

