import type { TokenStatus, World } from './types';
import { log, setObjectState } from './actions';
import { isPlayerEntry } from './deployment';
import { getWorld, projectContext, targetRevision, update, worldContext } from './store';

export type AIProtocol = 'responses' | 'chat-completions';
export interface AdvisorSettings { protocol: AIProtocol; baseURL: string; model: string }
export interface AdvisorTurn { role: 'user' | 'assistant'; content: string }
export type AdvisorChange =
  | { kind: 'object-state'; mapId: string; objectId: string; fromState: number; toState: number; reason: string }
  | { kind: 'token-status'; mapId: string; tokenId: string; fromStatus: TokenStatus | null; status: TokenStatus | null; reason: string };
export interface AdvisorReply { message: string; changes: AdvisorChange[] }
export const CONTEXT_LIMIT = 200_000;
export const HISTORY_LIMIT = 32_000;
export const TURN_LIMIT = 8_000;
export const REPLY_LIMIT = 24_000;

/** Host context only. Deliberately excludes fog grids, binary media, browser storage and credentials. */
export function buildSessionAIContext(w: World, activeMapId?: string): string {
  const judgments = (w as World & { judgments?: unknown }).judgments;
  return JSON.stringify({
    campaign: w.name, session: w.session, activeMapId, playerMapId: w.playerMapId,
    party: w.party, visionMode: w.visionMode, visionGroups: w.visionGroups,
    maps: w.maps.map(m => ({
      id: m.id, name: m.name, layer: m.layer, floor: m.floor, width: m.width, height: m.height, notes: m.notes,
      rooms: m.rooms.map(r => ({ id: r.id, name: r.name, note: r.note, tags: r.tags, activeLayoutId: r.activeLayoutId })),
      objects: m.objects.map(o => ({
        id: o.id, kind: o.kind, name: o.name, x: o.x, y: o.y, w: o.w, h: o.h, height: o.height,
        states: o.states, state: o.state, stateRev: o.stateRev ?? 0, enabled: o.enabled !== false,
        notes: o.notes, hidden: o.hidden, identity: o.identity ?? null, secrets: o.secrets,
        blocksWhen: o.blocksWhen, opening: o.opening, physical: o.physical, geometry: o.geometry,
      })),
      tokens: m.tokens.map(t => ({ ...t, status: t.status ?? null })),
      architecture: m.architecture, slidingPuzzles: m.slidingPuzzles,
    })),
    connections: w.connections,
    flows: w.flows.map(f => ({ id: f.id, name: f.name, mapId: f.mapId,
      nodes: f.nodes.map(n => ({ id: n.id, title: n.title, kind: n.kind, origin: n.origin, status: n.status,
        at: n.at, session: n.session, via: n.via, effect: n.effect, applied: n.applied })), edges: f.edges })),
    log: w.log, npcs: w.npcs, ...(judgments !== undefined ? { judgments } : {}),
  });
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(value, k)); }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && !!value.trim() && value.length <= max; }
function status(value: unknown): value is TokenStatus | null {
  if (value === null) return true;
  if (!record(value) || !text(value.label, 120) || Object.keys(value).some(k => !['label', 'endsAt', 'roundsLeft'].includes(k))) return false;
  if (value.endsAt !== undefined && (typeof value.endsAt !== 'number' || !Number.isSafeInteger(value.endsAt) || value.endsAt < 0)) return false;
  if (value.roundsLeft !== undefined && (typeof value.roundsLeft !== 'number' || !Number.isInteger(value.roundsLeft) || value.roundsLeft < 1 || value.roundsLeft > 10000)) return false;
  return value.endsAt === undefined || value.roundsLeft === undefined;
}

/** Untrusted model output is data. Unknown fields/actions and duplicate targets reject the whole reply. */
export function parseSessionAIReply(raw: string): AdvisorReply {
  if (raw.length > REPLY_LIMIT) throw new Error('AI 回复超过 24,000 字符上限');
  const body = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new Error('AI 没有返回有效的建议 JSON；世界未改动'); }
  if (!record(value) || !exact(value, ['message', 'changes']) || !text(value.message, 12000) || !Array.isArray(value.changes) || value.changes.length > 30) throw new Error('AI 回复需要 message 和 changes（最多 30 条）');
  const targets = new Set<string>();
  for (const c of value.changes) {
    if (!record(c) || !text(c.mapId, 200) || !text(c.reason, 2000)) throw new Error('AI 建议的地图或理由无效');
    let id: unknown;
    if (c.kind === 'object-state' && exact(c, ['kind', 'mapId', 'objectId', 'fromState', 'toState', 'reason'])) {
      id = c.objectId;
      if (![c.fromState, c.toState].every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0) || c.fromState === c.toState) throw new Error('AI 物件建议的状态序号无效');
    } else if (c.kind === 'token-status' && exact(c, ['kind', 'mapId', 'tokenId', 'fromStatus', 'status', 'reason'])) {
      id = c.tokenId;
      if (!status(c.fromStatus) || !status(c.status) || same(c.fromStatus, c.status)) throw new Error('AI 人物建议的状态无效');
    } else throw new Error('AI 建议包含不支持的变更');
    if (!text(id, 200)) throw new Error('AI 建议缺少稳定 ID');
    const key = JSON.stringify([c.kind, c.mapId, id]);
    if (targets.has(key)) throw new Error('AI 重复建议同一目标，请重新提问');
    targets.add(key);
  }
  return value as unknown as AdvisorReply;
}
function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
const sameStatus = (a: TokenStatus | null | undefined, b: TokenStatus | null | undefined) =>
  (a?.label ?? null) === (b?.label ?? null) && a?.endsAt === b?.endsAt && a?.roundsLeft === b?.roundsLeft;

export interface AdvisorSnapshot { world: World; project: number; context: string; revisions: WeakMap<object, number> }
export function captureAdvisorSnapshot(): AdvisorSnapshot {
  const world = getWorld(), revisions = new WeakMap<object, number>();
  for (const map of world.maps) for (const target of [...map.objects, ...map.tokens]) revisions.set(target, targetRevision(target));
  return { world, project: projectContext(), context: worldContext(), revisions };
}

export function advisorChangeError(c: AdvisorChange, snapshot: AdvisorSnapshot): string | null {
  if (isPlayerEntry()) return '玩家端不能应用主持人建议';
  if (snapshot.project !== projectContext() || snapshot.context !== worldContext()) return '工程或试玩上下文已切换，请重新提问';
  const oldMap = snapshot.world.maps.find(m => m.id === c.mapId), map = getWorld().maps.find(m => m.id === c.mapId);
  if (!oldMap || !map) return '地图已不存在';
  if (c.kind === 'object-state') {
    const old = oldMap.objects.find(o => o.id === c.objectId), current = map.objects.find(o => o.id === c.objectId);
    if (!old || !current || old !== current || snapshot.revisions.get(old) !== targetRevision(old)) return '物件已改动，请重新提问';
    if (old.state !== c.fromState || old.states[c.toState] === undefined) return '建议与请求时的物件状态不符';
    if (old.enabled === false) return '物件已停用';
  } else {
    const old = oldMap.tokens.find(t => t.id === c.tokenId), current = map.tokens.find(t => t.id === c.tokenId);
    if (!old || !current || old !== current || snapshot.revisions.get(old) !== targetRevision(old)) return '人物已改动，请重新提问';
    if (!sameStatus(old.status, c.fromStatus)) return '建议与请求时的人物状态不符';
  }
  return null;
}

/** One explicit host click, one existing undoable update. Never applies a reply automatically. */
export function applyAdvisorChange(c: AdvisorChange, snapshot: AdvisorSnapshot): string | null {
  // Validate even direct callers, not only the network parser.
  try { parseSessionAIReply(JSON.stringify({ message: 'review', changes: [c] })); } catch { return '建议格式无效'; }
  const error = advisorChangeError(c, snapshot);
  if (error) return error;
  if (c.kind === 'object-state') {
    const failure = setObjectState(c.mapId, c.objectId, c.toState);
    if (failure) return failure;
    return getWorld().maps.find(m => m.id === c.mapId)?.objects.find(o => o.id === c.objectId)?.state === c.toState ? null : '已有碰撞规则阻止了这次变更';
  }
  update(d => {
    const t = d.maps.find(m => m.id === c.mapId)!.tokens.find(t => t.id === c.tokenId)!;
    if (c.status === null) delete t.status; else t.status = { ...c.status };
    log(d, 'note', `主持人采用 AI 建议：${t.name} → ${c.status?.label ?? '解除状态'}（${c.reason}）`, c.mapId);
  });
  return null;
}

export async function requestSessionAI(settings: AdvisorSettings, context: string, messages: AdvisorTurn[], apiKey: string, signal: AbortSignal): Promise<AdvisorReply> {
  if (isPlayerEntry()) throw new Error('仅主持人可使用 AI 顾问');
  if (context.length > CONTEXT_LIMIT || JSON.stringify(messages).length > HISTORY_LIMIT || messages.some(m => m.content.length > REPLY_LIMIT)) throw new Error('上下文或对话超过预算，请缩小工程或清空对话');
  let bootstrap: Response;
  try { bootstrap = await fetch('/__ai-session', { cache: 'no-store', credentials: 'same-origin', signal }); }
  catch { throw new Error('无法连接 AI 网关，请使用主持人启动器'); }
  if (!bootstrap.ok) throw new Error('AI 网关未启用，请使用主持人启动器');
  const { token } = await bootstrap.json();
  if (typeof token !== 'string' || !token) throw new Error('AI 网关会话无效');
  const res = await fetch('/__ai', { method: 'POST', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json', 'X-AI-Token': token },
    body: JSON.stringify({ ...settings, context, messages, apiKey }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'AI 网关请求失败');
  if (typeof data.text !== 'string') throw new Error('AI 网关没有返回文本');
  return parseSessionAIReply(data.text);
}
