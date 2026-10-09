import { update } from './store';
import type { Flow, FlowEdge, FlowNode, World } from './types';
import { NODE_H, NODE_W } from './flow';
import { cellName, rangeName, uid } from './util';

// AI 接口：交给 AI 的就是「地图 JSON + 预测分支 JSON + 一段说明」。
// 作者在 AI 那边直接说"我这里 xxx 要加一个这样的分支"，AI 交回改好的整份预测分支 JSON，粘回来合并。
// 浏览器里不存 API Key；以后官网有后端，可以把 buildAIContext / applyAIReply 直接接到接口上。

/** 交给 AI 的地图：去掉格子数组（地形、迷雾、记忆），只留物件、棋子、连接点。 */
function mapForAI(w: World) {
  return {
    maps: w.maps.map((m) => ({
      id: m.id, name: m.name, layer: m.layer, floor: m.floor, width: m.width, height: m.height, notes: m.notes,
      objects: m.objects.map((o) => ({
        id: o.id, kind: o.kind, name: o.name, room: m.rooms.find((r) => r.id === m.roomCells[o.y * m.width + o.x])?.name, cell: rangeName(o), x: o.x, y: o.y, w: o.w, h: o.h, height: o.height,
        states: o.states, state: o.state, notes: o.notes, hidden: o.hidden,
        secrets: o.secrets.map((s) => ({ label: s.label, kind: s.kind, range: s.range, check: s.check, tiers: s.tiers })),
      })),
      rooms: m.rooms.map((r) => ({ name: r.name, tags: r.tags, note: r.note || undefined, cells: m.roomCells.filter((c) => c === r.id).length })),
      tokens: m.tokens.map((t) => ({ name: t.name, cell: cellName(t.x, t.y), pc: !!t.pcId })),
    })),
    connections: w.connections.map((c) => ({ kind: c.kind, label: c.label, a: { mapId: c.a.mapId, cell: cellName(c.a.x, c.a.y) }, b: { mapId: c.b.mapId, cell: cellName(c.b.x, c.b.y) } })),
    party: w.party.map((p) => ({ name: p.name, pathways: p.tags })),
  };
}

/** 交给 AI 的预测分支：只留内容，不带位置和带团状态。 */
function flowForAI(f: Flow) {
  return {
    name: f.name,
    nodes: f.nodes.map((n) => ({ id: n.id, title: n.title, kind: n.kind, effect: n.effect })),
    edges: f.edges.map((e) => ({ from: e.from, to: e.to, label: e.label, condition: e.condition, chance: e.chance })),
  };
}

export function buildAIContext(w: World, f: Flow) {
  return `这是《奇点之后》跑团模组的地图和"预测分支"（事件流程图，类似《底特律：变人》）。我接下来会告诉你要加什么分支。

说明：
- 坐标用 Excel 式：列是字母（A 起，向右），行是数字（1 起，向下），例如 B8；cell 字段就是这个。x / y 是从 0 开始的内部坐标。
- nodes 是事件，kind 为 start（开场）/ event / ending（结局）。effect 表示这个事件发生时，某个物件变成第几个状态：{ "mapId", "objectId", "toState": 状态序号 }（也可以直接写状态名），没有就写 null。
- edges 是"玩家做了什么"。condition 是途径名（只有队伍里有这个途径的人，这条分支才会出现），谁都能做就写 ""。chance 是大概概率（整数 %），不确定写 null。
- 修改完以后，请交回【完整的】预测分支 JSON，格式和下面一样，放在一个 \`\`\`json 代码块里。已有事件保留原来的 id；新事件随便起一个不重复的 id。

## 地图（JSON）
\`\`\`json
${JSON.stringify(mapForAI(w), null, 2)}
\`\`\`

## 预测分支（JSON）
\`\`\`json
${JSON.stringify(flowForAI(f), null, 2)}
\`\`\`
`;
}

type AINode = { id: string; title?: string; kind?: string; effect?: { mapId?: string; objectId?: string; toState?: number | string } | null };
type AIEdge = { from: string; to: string; label?: string; condition?: string; chance?: number | null };

function extractJSON(text: string): { nodes?: AINode[]; edges?: AIEdge[] } {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  const body = blocks.length ? blocks[blocks.length - 1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(body);
}

/**
 * 合并 AI 交回的整份预测分支：
 * - 已有事件：更新文字/类型/物件变化，保留位置和带团状态；AI 漏掉的不删，提示一下。
 * - 新事件：标 ✨，摆在它的起点下面。
 * - 连线：以 AI 交回的为准（再补回连着"漏掉的事件"的旧连线）。
 */
export function applyAIReply(w: World, flowId: string, text: string): { added: number; changed: number; edges: number; warnings: string[] } {
  const f = w.flows.find((x) => x.id === flowId);
  if (!f) throw new Error('找不到流程图');
  let data: ReturnType<typeof extractJSON>;
  try { data = extractJSON(text); } catch { throw new Error('没读出 JSON。请粘贴 AI 回复里的 json 代码块。'); }
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('JSON 里需要有 nodes 和 edges 两个数组。');

  const warnings: string[] = [];
  const objects = new Map(w.maps.flatMap((m) => m.objects.map((o) => [o.id, { m, o }] as const)));
  const oldById = new Map(f.nodes.map((n) => [n.id, n]));
  const idMap = new Map<string, string>(); // AI 的 id → 真正的 id
  const nodes: FlowNode[] = [];
  let added = 0, changed = 0;

  const effectOf = (n: AINode): FlowNode['effect'] => {
    const e = n.effect;
    if (!e) return null;
    const hit = e.objectId ? objects.get(e.objectId) : undefined;
    const idx = !hit ? -1 : typeof e.toState === 'number' ? e.toState : hit.o.states.indexOf(String(e.toState));
    if (hit && idx >= 0 && idx < hit.o.states.length) return { mapId: hit.m.id, objectId: hit.o.id, toState: idx };
    warnings.push(`「${n.title}」的物件变化对不上，已忽略`);
    return null;
  };

  for (const n of data.nodes) {
    if (!n?.id) { warnings.push('跳过一个没有 id 的事件'); continue; }
    const kind = n.kind === 'start' || n.kind === 'ending' ? n.kind : 'event';
    const old = oldById.get(n.id);
    if (old) {
      idMap.set(n.id, old.id);
      const effect = effectOf(n);
      const title = n.title ?? old.title;
      if (title !== old.title || kind !== old.kind || JSON.stringify(effect) !== JSON.stringify(old.effect)) changed++;
      nodes.push({ ...old, title, kind, effect });
    } else {
      const id = uid();
      idMap.set(n.id, id);
      nodes.push({ id, title: n.title || '（AI 没写标题）', x: 0, y: 0, kind, effect: effectOf(n), origin: 'predicted', status: 'predicted', source: 'ai' });
      added++;
    }
  }
  const missing = f.nodes.filter((n) => !nodes.some((x) => x.id === n.id));
  if (missing.length) {
    warnings.push(`AI 没有交回这些事件，已保留：${missing.map((n) => n.title).join('、')}`);
    nodes.push(...missing);
  }

  const edges: FlowEdge[] = [];
  for (const e of data.edges) {
    const from = idMap.get(e?.from), to = idMap.get(e?.to);
    if (!from || !to) { warnings.push(`跳过连线 ${e?.from} → ${e?.to}：找不到事件`); continue; }
    const old = f.edges.find((x) => x.from === from && x.to === to);
    const chance = typeof e.chance === 'number' ? Math.max(0, Math.min(100, Math.round(e.chance))) : null;
    edges.push({ id: old?.id ?? uid(), from, to, label: e.label ?? '', condition: (e.condition ?? '').trim(), chance });
  }
  const missingIds = new Set(missing.map((n) => n.id));
  f.edges.filter((e) => (missingIds.has(e.from) || missingIds.has(e.to)) && !edges.some((x) => x.id === e.id)).forEach((e) => edges.push(e));

  // 新事件摆到某个已摆好的起点下面，同一个起点的往右排开；反复几轮直到摆不动
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const fresh = nodes.filter((n) => n.source === 'ai' && !oldById.has(n.id));
  const placed = new Set(nodes.filter((n) => !fresh.includes(n)).map((n) => n.id));
  const childCount = new Map<string, number>();
  f.edges.forEach((e) => childCount.set(e.from, (childCount.get(e.from) ?? 0) + 1));
  let pending = fresh;
  while (pending.length) {
    const rest = pending.filter((n) => {
      const pe = edges.find((e) => e.to === n.id && placed.has(e.from));
      if (!pe) return true;
      const parent = byId.get(pe.from)!;
      const k = childCount.get(parent.id) ?? 0;
      childCount.set(parent.id, k + 1);
      n.x = parent.x + k * (NODE_W + 30);
      n.y = parent.y + NODE_H + 60;
      placed.add(n.id);
      return false;
    });
    if (rest.length === pending.length) break;
    pending = rest;
  }
  let orphanX = Math.min(...f.nodes.map((n) => n.x), 40);
  const maxY = Math.max(...nodes.map((n) => n.y), 0);
  for (const n of pending) {
    warnings.push(`「${n.title}」没有从已有事件连过来，放在了最下面`);
    n.x = orphanX; n.y = maxY + NODE_H + 120; orphanX += NODE_W + 30;
  }

  update((d) => {
    const df = d.flows.find((x) => x.id === flowId)!;
    df.nodes = nodes;
    df.edges = edges;
  });
  return { added, changed, edges: edges.length, warnings };
}
