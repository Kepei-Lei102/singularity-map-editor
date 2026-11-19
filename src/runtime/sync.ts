import { playerWindowBase, isPlayerEntry } from '../core/deployment';
import { identityKnown, playerSeen, UNKNOWN_OBJECT } from '../scene/identity';
import { objectEnabled } from '../core/objectData.js';
import { isArchitectureObject, clipArchitecture, fogAt, tokenPosition } from '../scene/architecture';
import { anyVisible } from '../scene/memory';
import type { CellGroup, CodeRequest, CombatNotice, DiceJudgment, Endpoint, GameMap, PendingJudgment, PlayerClue, VisionLayer, World } from '../core/types';
import { say, utterancesFor } from '../rules/dialogue';
import { visibleMarks } from '../scene/perception';
import { viewerOf, visiblePoint } from '../scene/sight';
import { currentPathwayOf, publicSkillsOf } from '../rules/skills';
import { numbering } from '../scene/render';
import { getRealWorld, getWorld, getUI, setUI, saveNow, worldContext, toast } from '../core/store';
import { SESSION, rand, renewSession } from '../core/session';
import { createLocalTransport } from './transportLocal';
import { createSwitchTransport, type Transport } from './transport';
import type { AssetBody, SyncBody, SyncMsg, TrialMoveSignal } from './messages';
import { ASSET_FLOW_IDLE_TIMEOUT_MS, ASSET_QUEUE_TIMEOUT_MS, serveAssetRequest, assetKeyOf, type ServeAssetOptions } from './assets';
import { getRaw } from './media';
import { ASSET_MAX_FLOWS, AssetSession } from './assetSessions';
export type { SyncBody, SyncMsg, TrialMoveSignal } from './messages';
import { groupBounds } from '../core/grid';
import { effectiveLayer, emptyVision } from '../scene/vision';
import { onProjectReplaced, projectContext } from '../core/store';

// 主持人窗口 ↔ 玩家窗口。线上入口还没接，现在本地窗口走 LocalTransport。
// world / 播放只经 Transport 发给已绑定窗口；广播只传会话占用与存活，不传 world、角色或绑定凭据。

export { SESSION };
const INST = rand(); // 这个页面实例（刷新就是新的实例，但会话标识不变）
const BORN = Date.now();
const transport = createSwitchTransport(createLocalTransport(isPlayerEntry() ? 'player' : 'host'));

// Binding is held only by the host; the URL carries an opaque reconnect capability, never a selectable pcId.
const players = new Map<string, { pcId: string; context: number; trialContext?: string }>();
// 每个玩家窗口只允许拉它自己那份 world 里用到的媒体存储名；请求别的一律 forbidden。
// 世界一推就换一份，玩家换视角/换图后旧 key 也跟着收走。
const assetAllow = new Map<string, Map<string, { mime: string; size: number }>>();
/** 正在广播的媒体；只在这个 binding 的 world 之外额外允许这一个 key。 */
let broadcastAsset: { key: string; mime: string; size: number } | null = null;
/** 每条绑定的在途 asset 账本；重连/清空换新实例，旧 serve 还不到新账上。 */
const assetSessions = new Map<string, AssetSession>();
const assetRequestLog = new Map<string, number[]>();
/** 主持端 dock 用的聚合数：几个玩家、几条 serve、已发/总量/排队/均速。 */
export type AssetTransferBinding = { binding: string; pcId?: string; name?: string; bytes: number; totalBytes: number; queued: number; inFlight: number; rate: number };
export type AssetTransferStats = {
  players: number;
  requests: number;
  bytes: number;
  totalBytes: number;
  queued: number;
  inFlight: number;
  rate: number;
  bindings: AssetTransferBinding[];
};
type AssetFlow = {
  requestId: string;
  totalFiles: number;
  startedFiles: number;
  endedFiles: number;
  failedFiles: number;
  failedStartedFiles: number;
  totalBytes: number;
  bytes: number;
  startedAt: number;
  samples: { at: number; bytes: number }[];
  files: Map<string, { sent: number; total?: number }>;
  plannedKeys: Set<string>;
  endedKeys: Set<string>;
  failedKeys: Set<string>;
};
/** 每条 binding 的每个在途 request 一份；结束/断线/换工程就删。 */
const assetFlows = new Map<string, Map<string, AssetFlow>>();
/** 每条 binding 的超额请求先排队，等前一条结束再发；直接 forbidden 会让 33–64 个 media 的世界漏图。 */
const ASSET_MAX_QUEUED_REQUESTS = 8;
type QueuedAssetRequest = {
  m: Extract<AssetBody, { type: 'asset-request' }>;
  load: ServeAssetOptions['load'];
  meta: ServeAssetOptions['meta'];
  timer?: ReturnType<typeof setTimeout>;
};
const assetRequestQueues = new Map<string, QueuedAssetRequest[]>();
/** 速率只算最近 2 秒；长时间没新块就回 0，不拿累计平均冒充实时。 */
export const ASSET_RATE_WINDOW_MS = 2_000;
const ASSET_RATE_TICK_MS = 500;
const assetBindingNames = new Map<string, string>();
let assetTransferSnapshot: AssetTransferStats = { players: 0, requests: 0, bytes: 0, totalBytes: 0, queued: 0, inFlight: 0, rate: 0, bindings: [] };
const assetTransferListeners = new Set<() => void>();
/** base64 里真正解出来的字节数；不要用 data.length，服务端消息会多算 pad。 */
function base64Size(data: string): number {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - pad);
}
function requestKeys(keys: unknown): string[] {
  return [...new Set((Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && k.length > 0))].slice(0, 32);
}
function beginAssetFlow(binding: string, requestId: string, keys: unknown): void {
  const unique = requestKeys(keys);
  let flows = assetFlows.get(binding);
  if (!flows) { flows = new Map(); assetFlows.set(binding, flows); }
  flows.set(requestId, { requestId, totalFiles: unique.length, startedFiles: 0, endedFiles: 0, failedFiles: 0, failedStartedFiles: 0, totalBytes: 0, bytes: 0, startedAt: Date.now(), samples: [], files: new Map(), plannedKeys: new Set(unique), endedKeys: new Set(), failedKeys: new Set() });
  refreshAssetTransferStats();
  scheduleAssetRateTick();
}
/** 玩家 cancel 后，账本立刻反映：整个请求删掉，单 key 从排队/在途里拿掉。 */
function cancelAssetFlow(binding: string, requestId: string, key?: string): void {
  const flow = assetFlows.get(binding)?.get(requestId);
  if (!flow) return;
  if (typeof key !== 'string' || !key) { endAssetFlow(binding, requestId); return; }
  if (!flow.plannedKeys.has(key) || flow.failedKeys.has(key) || flow.endedKeys.has(key)) return;
  flow.failedKeys.add(key);
  if (flow.files.has(key)) { flow.files.delete(key); flow.failedStartedFiles++; }
  else flow.failedFiles++;
  refreshAssetTransferStats();
}

function stopAssetRateTickIfIdle(): void {
  if (assetFlows.size || assetRateTimer === undefined) return;
  clearTimeout(assetRateTimer);
  assetRateTimer = undefined;
}
function endAssetFlow(binding: string, requestId: string): void {
  const flows = assetFlows.get(binding);
  if (!flows) return;
  flows.delete(requestId);
  if (!flows.size) assetFlows.delete(binding);
  stopAssetRateTickIfIdle();
  refreshAssetTransferStats();
}
function noteFlowSample(flow: AssetFlow): void {
  const now = Date.now();
  const last = flow.samples[flow.samples.length - 1];
  if (last && last.at === now) { last.bytes = flow.bytes; return; }
  flow.samples.push({ at: now, bytes: flow.bytes });
  const cutoff = now - ASSET_RATE_WINDOW_MS;
  while (flow.samples.length > 2 && flow.samples[1].at < cutoff) flow.samples.shift();
}

/** 纯函数：按最近 2 秒窗口算平均速率；超过 2 秒没新采样就回 0。
 *  分母取 max(窗口起点, 采样起点) 到现在的秒数，避免“两次采样只隔 1 秒”被当成 1 秒速率。 */
export function rateFromSamples(samples: { at: number; bytes: number }[], now: number): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  if (now - last.at > ASSET_RATE_WINDOW_MS) return 0;
  const cutoff = now - ASSET_RATE_WINDOW_MS;
  let base = samples[0];
  for (const sample of samples) { if (sample.at > cutoff) break; base = sample; }
  const seconds = Math.min(ASSET_RATE_WINDOW_MS / 1000, Math.max(0, (now - base.at) / 1000));
  return seconds > 0 ? Math.max(0, (last.bytes - base.bytes) / seconds) : 0;
}

function flowRate(flow: AssetFlow, now: number): number {
  return rateFromSamples(flow.samples, now);
}

function noteAssetBody(binding: string, requestId: string, body: AssetBody): void {
  const flow = assetFlows.get(binding)?.get(requestId);
  if (!flow) return;
  if (body.type === 'asset-start') {
    if (!flow.plannedKeys.has(body.key) || flow.files.has(body.key)) return;
    flow.startedFiles++;
    const total = typeof body.bytes === 'number' && Number.isFinite(body.bytes) && body.bytes >= 0 ? body.bytes : undefined;
    flow.files.set(body.key, { sent: 0, total });
    if (total !== undefined) flow.totalBytes += total;
    noteFlowSample(flow);
  } else if (body.type === 'asset-chunk') {
    const file = flow.files.get(body.key);
    if (!file) return;
    const n = base64Size(body.data);
    file.sent += n;
    flow.bytes += n;
    noteFlowSample(flow);
  } else if (body.type === 'asset-end') {
    const file = flow.files.get(body.key);
    if (!file || flow.endedKeys.has(body.key)) return;
    const actual = typeof body.bytes === 'number' && body.bytes >= 0 ? body.bytes : file.sent;
    flow.bytes += actual - file.sent;
    if (file.total === undefined) flow.totalBytes += actual;
    file.sent = actual;
    file.total = actual;
    flow.endedKeys.add(body.key);
    flow.endedFiles++;
    noteFlowSample(flow);
  } else if (body.type === 'asset-fail') {
    if (!flow.plannedKeys.has(body.key) || flow.failedKeys.has(body.key)) return;
    flow.failedKeys.add(body.key);
    if (flow.files.has(body.key)) flow.failedStartedFiles++;
    else flow.failedFiles++;
  }
  refreshAssetTransferStats();
}
let assetRateTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleAssetRateTick(): void {
  if (assetRateTimer !== undefined || !assetFlows.size) return;
  assetRateTimer = setTimeout(() => {
    assetRateTimer = undefined;
    if (!assetFlows.size) return;
    refreshAssetTransferStats();
    scheduleAssetRateTick();
  }, ASSET_RATE_TICK_MS);
  (assetRateTimer as unknown as { unref?: () => void }).unref?.();
}

function refreshAssetTransferStats(): void {
  const now = Date.now();
  const bindings: AssetTransferBinding[] = [];
  let playerCount = 0;
  let requests = 0;
  let bytes = 0;
  let totalBytes = 0;
  let queued = 0;
  let inFlight = 0;
  let rate = 0;
  for (const [binding, flows] of assetFlows) {
    if (!flows.size) continue;
    let bBytes = 0;
    let bTotal = 0;
    let bQueued = 0;
    let bInFlight = 0;
    let bRate = 0;
    for (const flow of flows.values()) {
      bBytes += flow.bytes;
      bTotal += flow.totalBytes;
      bQueued += Math.max(0, flow.totalFiles - flow.startedFiles - flow.failedFiles);
      bInFlight += Math.max(0, flow.startedFiles - flow.endedFiles - flow.failedStartedFiles);
      bRate += flowRate(flow, now);
    }
    playerCount++;
    requests += flows.size;
    bytes += bBytes;
    totalBytes += bTotal;
    queued += bQueued;
    inFlight += bInFlight;
    rate += bRate;
    const pcId = players.get(binding)?.pcId;
    bindings.push({ binding, pcId, name: assetBindingNames.get(binding), bytes: bBytes, totalBytes: bTotal, queued: bQueued, inFlight: bInFlight, rate: bRate });
  }
  const prev = assetTransferSnapshot;
  const same = prev.players === playerCount && prev.requests === requests && prev.bytes === bytes && prev.totalBytes === totalBytes &&
    prev.queued === queued && prev.inFlight === inFlight && prev.rate === rate && prev.bindings.length === bindings.length &&
    bindings.every((b, i) => { const p = prev.bindings[i]; return p && p.binding === b.binding && p.bytes === b.bytes && p.totalBytes === b.totalBytes && p.queued === b.queued && p.inFlight === b.inFlight && p.rate === b.rate; });
  if (same) return;
  assetTransferSnapshot = { players: playerCount, requests, bytes, totalBytes, queued, inFlight, rate, bindings };
  for (const fn of [...assetTransferListeners]) { try { fn(); } catch { /* 一个订阅者坏掉别拖住其他订阅者 */ } }
}
export function subscribeAssetTransferStats(fn: () => void): () => void {
  assetTransferListeners.add(fn);
  return () => { assetTransferListeners.delete(fn); };
}
export function assetTransferStats(): AssetTransferStats { return assetTransferSnapshot; }
const bindingsKey = () => `ts-player-bindings-${SESSION}`;
try {
  const saved = JSON.parse(sessionStorage.getItem(bindingsKey()) ?? '{}') as Record<string, string>;
  for (const [binding, pcId] of Object.entries(saved)) if (typeof pcId === 'string') players.set(binding, { pcId, context: projectContext() });
} catch { /* no reconnect state */ }
function saveBindings() {
  try { sessionStorage.setItem(bindingsKey(), JSON.stringify(Object.fromEntries([...players].filter(([, p]) => !p.trialContext).map(([key, p]) => [key, p.pcId])))); } catch { /* unavailable */ }
}
/** 本地窗口/线上房间切换；订阅者不用重挂。 */
const transportKindListeners = new Set<() => void>();
function notifyTransportKind(): void { for (const fn of [...transportKindListeners]) fn(); }
/** 给 UI 用：线上/本地切换时重新渲染（比如媒体同步按钮）。 */
export function subscribeTransportKind(fn: () => void): () => void {
  transportKindListeners.add(fn);
  return () => { transportKindListeners.delete(fn); };
}
export function setTransport(next: Transport): void { transport.use(next); notifyTransportKind(); }
/** 关掉线上房间后回本地窗口模式（新建一条本地传输，不重用已经关掉的）。 */
export function useLocalTransport(): void { transport.use(createLocalTransport(transport.role)); notifyTransportKind(); }
export function isOnlineTransport(): boolean { return transport.kind === 'ws'; }
/** 主持端从本地窗口切到线上房间时，旧的本地 binding 不再有意义，清掉。 */
export function resetPlayerBindings(): void {
  for (const binding of players.keys()) {
    transport.sendToPeer(binding, { type: 'clear', __ts: 'ts-map', seq: rand(), from: SESSION, inst: INST, born: BORN });
    transport.dropPeer(binding);
  }
  players.clear();
  assetBindingNames.clear();
  broadcastAsset = null;
  assetAllow.clear();
  assetSessions.clear();
  assetRequestLog.clear();
  assetFlows.clear();
  clearAssetRequestQueues();
  stopAssetRateTickIfIdle();
  refreshAssetTransferStats();
  saveBindings();
}
/** 线上邀请被加入时，主持端先把 binding 对到角色；服务器只知道 inviteId，不知道 pcId。 */
export function registerOnlinePlayer(binding: string, pcId: string): void {
  if (!binding || !pcId) return;
  players.set(binding, { pcId, context: projectContext() });
  const name = getRealWorld().party.find((pc) => pc.id === pcId)?.name;
  if (name) assetBindingNames.set(binding, name); else assetBindingNames.delete(binding);
  assetAllow.delete(binding);
  clearAssetRequestQueues(binding);
  assetSessions.set(binding, AssetSession.fresh());
  assetRequestLog.delete(binding);
  assetFlows.delete(binding);
  stopAssetRateTickIfIdle();
  refreshAssetTransferStats();
  saveBindings();
}
/** 服务器告诉主持端这个 binding 断了：别留下能继续请求媒体的僵尸入口。 */
export function unregisterOnlinePlayer(binding: string): void {
  if (!binding) return;
  clearAssetRequestQueues(binding);
  assetSessions.delete(binding);
  players.delete(binding);
  assetFlows.delete(binding);
  assetBindingNames.delete(binding);
  refreshAssetTransferStats();
  saveBindings();
  dropPlayerAssets(binding);
}
/**
 * 试玩里刚发生的攻击，推给跟他有关的玩家。
 * 打人的和挨打的都要知道；旁人只在同一张图、视野内才给提示 —— 这里先只推给当事人，
 * 免得把「谁在哪个角落打谁」漏出去。
 */
function combatNoticeFor(pcId: string): CombatNotice | null {
  const ev = getUI().trial?.event;
  if (!ev) return null;
  const asAttacker = ev.attackerPcId === pcId;
  const asTarget = ev.targetPcId === pcId;
  if (!asAttacker && !asTarget) return null;
  return {
    id: `${ev.at}-${ev.attackerName}-${ev.targetName}`,
    at: ev.at,
    kind: ev.kind,
    attackerName: ev.attackerName,
    attackerPcId: ev.attackerPcId,
    targetName: ev.targetName,
    targetPcId: ev.targetPcId,
    roll: ev.roll,
    crit: ev.crit,
    damage: ev.damage,
    hpBefore: ev.hpBefore,
    hpAfter: ev.hpAfter,
    hpMax: ev.hpMax,
    downed: ev.downed ?? null,
    note: ev.note,
    role: asAttacker ? 'attacker' : 'target',
  };
}

/** 玩家端要掷几颗：只看公开字段，不看被剥掉的 jump。 */
export function playerDiceMode(p: PendingJudgment): PendingJudgment['dice'] {
  // 多属性判定每个属性各一颗；优/劣势只会出现在单属性/跳跃上。
  if (p.check?.attrs.length) return 'single';
  return p.dice ?? p.jump?.dice ?? 'single';
}

/** 只把「落在你身上」的待掷判定发给这个玩家；别人的判定他一概不知道。 */
/** 发给玩家的判定副本：去掉主持端内部字段（context 是内部上下文标记）。 */
function forPlayer(p: PendingJudgment): PendingJudgment {
  const copy = { ...p };
  delete (copy as { context?: string }).context;
  // 玩家 UI 只需要 title/ruling/sides 和“掷几次”；jump / door / fall 都是主持人侧的落点和结算数据，不给他。
  const dice = playerDiceMode(p);
  delete copy.jump;
  delete copy.door;
  delete copy.fall;
  delete copy.place;
  delete copy.attack;
  delete copy.standIn;
  delete copy.ramImpact;
  copy.dice = dice;
  return copy;
}

function pendingForPlayer(pcId: string, trialContext?: string): PendingJudgment | null {
  const p = pendingFor(pcId, trialContext);
  return p ? forPlayer(p) : null;
}

function pendingFor(pcId: string, trialContext?: string): PendingJudgment | null {
  const p = getUI().pendingJudgment;
  if (!p || p.subjectId !== pcId) return null;
  // 试玩判定只给试玩窗口，真实判定只给真实窗口：同一个角色两边都开着也不串。
  const pendingTrial = !!p.context && p.context.endsWith(':trial');
  if (!!trialContext !== pendingTrial) return null;
  if (trialContext && p.context !== trialContext) return null;
  return p;
}

export function openPlayerWindow(pcId?: string, trial = false) {
  if (transport.kind === 'ws') { toast('线上房间请用「线上房间」面板里的邀请链接'); return; }
  const w = trial ? getWorld() : getRealWorld(), id = pcId ?? w.party[0]?.id;
  if (!id || !w.party.some(p => p.id === id)) return;
  const binding = rand();
  const base = playerWindowBase();
  if (transport.openPeer(binding, `${base}?view=player&session=${SESSION}&binding=${binding}`)) {
    players.set(binding, { pcId: id, context: projectContext(), ...(trial ? { trialContext: worldContext() } : {}) });
    saveBindings();
  } else toast(`玩家窗口被浏览器拦截，请允许此站点弹出窗口，再点「${trial ? '打开试玩玩家端' : '打开玩家窗口…'}」`);
}
export function clearTrialWindows() {
  for (const [id, p] of players) if (p.trialContext) {
    transport.sendToPeer(id, { type: 'clear', __ts: 'ts-map', seq: rand(), from: SESSION, inst: INST, born: BORN });
    transport.dropPeer(id);
    players.delete(id);
    dropPlayerAssets(id);
  }
}
/**
 * 试玩里刷新一遍玩家窗口。
 *
 * 注意：这里**不改** p.pcId。一个玩家窗口开出去就绑死那个角色，
 * pcId 同时是身份（鉴权用）和视角（裁剪世界用），改它等于改身份——
 * 那样「不是你的回合」这条守卫永远不成立，被暂停的人也能操作别人的棋子。
 */
export function selectTrialViewer(_pcId?: string) {
  send({ type: 'world', world: getWorld() });
}

/**
 * 发给玩家窗口的"玩家版"世界：主持人才能看的东西在发出去之前就删掉，而不只是不画。
 * 只留推给玩家的那一张图，而且只留"有人看得见"或"有人记得"的部分：
 * - 地形：现在有人看得见的格子才带实时地形；灰区靠各人的记忆（seen）画，黑区什么都没有；地形定义也只带用得上的；
 * - 物件：没隐藏、现在有人看得见的才带，备注、挂的媒体、线索删掉，其他状态的名字也删掉（只留当前这个）；
 *   记忆里的物件只留至少还有一格在灰区或看得见的（抹黑了的就不带）；
 * - 棋子：绑定角色自己始终保留，其他角色仅当前可见时保留；
 * - 连接点：没隐藏、这一头有人看得见的才带；另一头只在那张图去过时留下图的 ID，坐标一律不带；
 * - 线索：全队公开过的单独列在 clues 里（只带揭示到的那一档）；
 * - 标记：谁能看到（听得见）在完整的世界里算好，写进 audience（玩家窗口没有完整地形，自己算会算错）；
 * - 房间、D100、出生点、备注、流程图、记录、NPC、媒体列表都不带。
 * 编号（O/Z/T/C）在删之前按完整的世界算好放进 labels，所以玩家和主持人看到的编号一样。
 */
export function playerWorld(w: World, mapId: string | null = w.playerMapId, pcId?: string): World {
  const valid = pcId ? w.party.some(p => p.id === pcId) : w.visionMode === 'shared';
  const layer = (m: GameMap) => !valid ? emptyVision(m.width * m.height) : pcId ? effectiveLayer(w, m, pcId) : m;
  const src = w.maps.find((m) => m.id === mapId);
  const pm = src && playerMap(src, layer(src), pcId);
  const known = (id: string) => { const m = w.maps.find((x) => x.id === id); return !!m && layer(m).fog.some(Boolean); };
  const hidden = { mapId: '', x: 0, y: 0 };
  const connections = !src ? [] : w.connections.flatMap((c) => {
    if (c.hidden) return [];
    const show = (e: Endpoint) => e.mapId === src.id && fogAt(src, layer(src), e.x + .5, e.y + .5) === 1;
    if (!show(c.a) && !show(c.b)) return [];
    const far = (e: Endpoint) => (show(e) ? e : e.mapId !== src.id && known(e.mapId) ? { mapId: e.mapId, x: 0, y: 0 } : hidden);
    return [{ ...c, a: far(c.a), b: far(c.b) }];
  });
  // 编号表也只带玩家碰得到的东西（发出去的、记得的），不然从编号的空缺能数出有几个隐藏物件
  const keep = new Set<string>([
    ...(pm ? [...pm.objects, ...pm.tokens, ...pm.seen.objects, ...Object.values(pm.views).flatMap((L) => L.seen.objects)].map((x) => x.id) : []),
    ...connections.map((c) => c.id),
  ]);
  const labels: Record<string, string> = {};
  if (src) numbering(w, src).forEach((n) => { if (keep.has(n.id)) labels[n.id] = n.label; });
  const usedTerrains = new Set(pm ? [
    ...pm.cells, ...pm.seen.cells, ...(pm.fineCells ?? []),
    ...Object.values(pm.views).flatMap((L) => L.seen.cells),
  ] : []);
  const usedMaterials = new Set(pm ? [
    ...Object.values(pm.materialCells ?? {}),
    ...Object.values(pm.fineMaterials ?? {}),
    ...Object.values(pm.seen.materialCells ?? {}),
  ] : []);
  // ghost 物件不画外观图：实时组在 playerMap 已经排除，记忆物件按各自 ghost 过滤，开了下一帧再带上。
  const usedTextures = new Set([
    ...(pm?.groups ?? []).flatMap((g) => g.texture ? [g.texture.mediaId] : []),
    ...(pm?.seen.groups ?? []).flatMap((g) => g.texture ? [g.texture.mediaId] : []),
    ...(pm?.seen.objects ?? []).filter((r) => !r.ghost).flatMap((r) => r.texture ? [r.texture.mediaId] : []),
  ]);
  const clues: PlayerClue[] = valid ? w.maps.flatMap(m => m.objects.flatMap(o => o.secrets.flatMap(s => {
    const r = s.revealed;
    const manual = r && (r.scope === 'party' || pcId && r.recipients?.includes(pcId)) ? r : undefined;
    const known = manual ?? (pcId ? s.discoveries?.[pcId] : undefined);
    return known ? [{ id: s.id, object: identityKnown(o, pcId) ? o.name : UNKNOWN_OBJECT, label: s.label, kind: s.kind, check: s.check, tier: known.tier, text: s.tiers[known.tier], at: known.at }] : [];
  }))) : [];
  const marks = valid && pcId ? visibleMarks(w, mapId ?? '', pcId).map(k => ({ ...k, audience: [pcId] })) : valid ? w.marks.filter(k => k.mapId === mapId) : [];
  return {
    ...w,
    visionGroups: undefined, observationSeq: undefined, viewerId: pcId,
    // 只带自己那张卡：血、ME、六维区值够画状态条就行；技能走单独的公开清单。
    party: pcId ? w.party.filter(p => p.id === pcId).map(p => ({ id: p.id, name: p.name, tags: [], color: p.color, attributes: p.attributes, hp: p.hp, hpMax: p.hpMax, me: p.me, meMax: p.meMax })) : [],
    terrains: w.terrains.filter((t) => usedTerrains.has(t.id)),
    materials: (w.materials ?? []).filter((m) => usedMaterials.has(m.id)),
    flows: [], log: [], npcs: [], media: w.media.filter((m) => usedTextures.has(m.id)).map((m) => ({ ...m, name: '贴图' })), events: [],
    ...(() => {
      if (!valid || !pcId) return { judgments: [] };
      const mine = (w.judgments ?? []).filter(j => j.recipients.includes(pcId));
      const latest = mine[mine.length - 1];
      const latestHidden = !!latest && !judgmentVisible(w, latest, pcId);
      if (latestHidden) return { judgments: [], judgmentNotice: { id: latest!.id, at: latest!.at } };
      return { judgments: mine.filter(j => judgmentVisible(w, j, pcId)).map(j => ({ ...j, recipients: [pcId] })), judgmentNotice: null };
    })(),
    labels, clues, marks, connections,
    playerMapId: pm?.id ?? null,
    maps: pm ? [pm] : [],
  };
}

/** 判定是否在这个角色的视野里：自己发起的永远算；别的人看判定锚点。 */
function judgmentVisible(w: World, j: DiceJudgment, pcId: string): boolean {
  if (!j.place) return true;
  if (j.subjectId === pcId) return true;
  const m = w.maps.find((x) => x.id === j.place!.mapId);
  const t = m?.tokens.find((x) => x.pcId === pcId);
  if (!m || !t) return false;
  const pc = w.party.find((p) => p.id === pcId);
  return visiblePoint(w, m, viewerOf(t, { sex: pc?.sex, heightCm: pc?.heightCm }), { x: j.place.x, y: j.place.y });
}

/** 玩家侧记忆组的 id：不暴露原组/版本，但对同一个原组+贴图版本保持稳定。 */
function opaqueMemoryId(sourceId: string, key: string): string {
  let h = 2166136261;
  const text = `${sourceId}\u0000${key}`;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `mh${(h >>> 0).toString(36)}`;
}

/** Only the bound role's live cells and memory leave the host. */
export function playerMap(m: GameMap, L: VisionLayer, pcId?: string): GameMap {
  const seen = {
    cells: L.seen.cells.map((c, i) => L.fog[i] ? c : ''),
    objects: L.seen.objects.filter(r => {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (L.fog[y * m.width + x]) return true;
      return false;
    }).map(r => playerSeen(r, pcId, m.objects.find(o => o.id === r.id))),
    architecture: [...clipArchitecture(m, L, 1, L.seen.architecture ?? []), ...clipArchitecture(m, L, 2, L.seen.architecture ?? [])],
    materialCells: Object.fromEntries(Object.entries(L.seen.materialCells ?? {}).filter(([key]) => L.fog[+key])),
    groups: [] as CellGroup[],
  };
  const fineRows = m.width * 3;
  const fineCells = m.fineCells.map((c, key) => {
    const x3 = key % fineRows, y3 = Math.floor(key / fineRows);
    return L.fog[Math.floor(y3 / 3) * m.width + Math.floor(x3 / 3)] === 1 ? c : '';
  });
  const fineMaterials = Object.fromEntries(Object.entries(m.fineMaterials ?? {}).filter(([key]) => {
    const k = +key, x3 = k % fineRows, y3 = Math.floor(k / fineRows);
    return L.fog[Math.floor(y3 / 3) * m.width + Math.floor(x3 / 3)] === 1;
  }));
  // 贴图组只发看得见的格子。整组都看见时才带整组包围盒；只看见一角就用可见格的
  // 包围盒铺图（局部拉伸），不把看不见部分的形状/范围带给玩家。
  // 物件贴图（objectId）是物件外观，等物件外观那一步再发。
  const fogOf = (key: number) => {
    const x3 = key % fineRows, y3 = Math.floor(key / fineRows);
    return L.fog[Math.floor(y3 / 3) * m.width + Math.floor(x3 / 3)] ?? 0;
  };
  const copyTexture = (t: CellGroup['texture']) => t ? { mediaId: t.mediaId, ...(t.fit !== undefined ? { fit: t.fit } : {}), ...(t.opacity !== undefined ? { opacity: t.opacity } : {}) } : undefined;
  const visibleGroup = (g: CellGroup, cells: number[], withFullBounds: boolean): CellGroup => {
    const out: CellGroup = { id: g.id, name: '贴图', cells };
    const texture = copyTexture(g.texture);
    if (texture) out.texture = texture;
    if (g.z !== undefined) out.z = g.z;
    if (withFullBounds) {
      const bounds = groupBounds(m.width, cells, m.height);
      if (bounds) out.bounds = bounds;
    }
    return out;
  };
  const visibleObjects = m.objects.filter(o => objectEnabled(m, o) && o.kind === 'object' && !isArchitectureObject(o) && !o.hidden && anyVisible({ ...m, ...L }, o));
  const visibleObjectIds = new Set(visibleObjects.map((o) => o.id));
  const ghostObjectIds = new Set(visibleObjects.filter((o) => !!o.blocksWhen && !o.blocksWhen.includes(o.state)).map((o) => o.id));
  const texturedObjectIds = new Set((m.groups ?? []).filter((g) => g.objectId && g.texture && visibleObjectIds.has(g.objectId)).map((g) => g.objectId!));
  const groups = (m.groups ?? []).flatMap((g) => {
    if (g.objectId) {
      // ghost 物件只画虚线，外观图不发；标签靠 objects.textured 维持“有图”口径。
      if (!visibleObjectIds.has(g.objectId) || ghostObjectIds.has(g.objectId)) return [];
      const cells = g.cells.filter((key) => fogOf(key) === 1);
      if (!cells.length) return [];
      const out = visibleGroup(g, cells, cells.length === g.cells.length);
      out.objectId = g.objectId;
      return [out];
    }
    const cells = g.cells.filter((key) => fogOf(key) === 1);
    return cells.length ? [visibleGroup(g, cells, cells.length === g.cells.length)] : [];
  });
  // 同一原组+同一贴图版本在玩家侧合成一个不透明 id；旧工程里拆开的同版本记忆也并回来。
  type MemoryBucket = { key: string; cells: Set<number>; texture?: CellGroup['texture']; z?: number };
  const buckets = new Map<string, MemoryBucket>();
  const usedIds = new Set((m.groups ?? []).map((g) => g.id));
  for (const g of L.seen.groups ?? []) {
    if (g.objectId) continue;
    const cells = g.cells.filter((key) => fogOf(key) === 2).sort((a, b) => a - b);
    if (!cells.length) continue;
    const source = g.sourceId ?? g.id;
    const key = g.textureKey ?? (g.texture ? `${g.texture.mediaId}~${g.texture.fit ?? 'fill'}~${g.texture.opacity ?? 1}` : 'none');
    const base = opaqueMemoryId(source, key);
    let id = base, n = 0;
    while (usedIds.has(id) && buckets.get(id)?.key !== key) id = `${base}x${++n}`;
    usedIds.add(id);
    let bucket = buckets.get(id);
    if (!bucket) { bucket = { key, cells: new Set() }; buckets.set(id, bucket); }
    for (const cell of cells) bucket.cells.add(cell);
    if (!bucket.texture) bucket.texture = copyTexture(g.texture);
    if (bucket.z === undefined) bucket.z = g.z;
  }
  const seenGroups: CellGroup[] = [];
  for (const [id, bucket] of buckets) {
    const cells = [...bucket.cells].sort((a, b) => a - b);
    const bounds = groupBounds(m.width, cells, m.height);
    if (!bounds) continue;
    const out: CellGroup = { id, name: '贴图', cells, bounds };
    if (bucket.texture) out.texture = bucket.texture;
    if (bucket.z !== undefined) out.z = bucket.z;
    seenGroups.push(out);
  }
  seen.groups = seenGroups;
  return {
    id: m.id, name: m.name, layer: m.layer, floor: m.floor, width: m.width, height: m.height,
    fog: [...L.fog], seen, views: {}, autoFog: false,
    architectureFragments: clipArchitecture(m, L),
    cells: m.cells.map((c, i) => L.fog[i] === 1 ? c : ''),
    fineCells,
    materialCells: Object.fromEntries(Object.entries(m.materialCells ?? {}).filter(([key]) => L.fog[+key] === 1)),
    fineMaterials,
    groups,
    d100: m.d100.map(() => 0), rooms: [], roomCells: m.roomCells.map(() => ''), notes: '', spawn: null,
    tokens: m.tokens.filter(t => { const p = tokenPosition(t); return t.pcId === pcId || fogAt(m, L, p.x, p.y) === 1; }),
    objects: visibleObjects.map(o => ({
      id: o.id, kind: o.kind, name: identityKnown(o, pcId) ? o.name : UNKNOWN_OBJECT, x: o.x, y: o.y, w: o.w, h: o.h, anchor: o.anchor, height: o.height, color: o.color, icon: identityKnown(o, pcId) ? o.icon : '',
      state: identityKnown(o, pcId) ? o.state : 0, states: identityKnown(o, pcId) ? o.states.map((s, k) => k === o.state ? s : '') : [''], ghost: !!o.blocksWhen && !o.blocksWhen.includes(o.state), ...(texturedObjectIds.has(o.id) ? { textured: true } : {}), notes: '', hidden: false, media: [], secrets: [],
    })),
  };
}

onProjectReplaced(() => {
  // 换工程：主持端还等着的判定跨工程没有意义，先收掉；下面会给所有窗口发 clear。
  setUI({ pendingJudgment: null, judgmentResult: null, pendingCode: null });
  for (const binding of players.keys()) {
    transport.sendToPeer(binding, { type: 'clear', __ts: 'ts-map', seq: rand(), from: SESSION, inst: INST, born: BORN });
    transport.dropPeer(binding);
  }
  players.clear(); assetBindingNames.clear(); saveBindings(); broadcastAsset = null; assetAllow.clear(); assetSessions.clear(); assetRequestLog.clear(); assetFlows.clear(); clearAssetRequestQueues(); stopAssetRateTickIfIdle(); refreshAssetTransferStats();
});

let quietUntil = 0; // 编辑器刚启动、还在确认会话标识没撞车时，先不往外推

export function send(body: SyncBody, to?: string) {
  if ((body.type === 'world' || body.type === 'play' || body.type === 'stop') && Date.now() < quietUntil) {
    window.setTimeout(() => send(body, to), quietUntil - Date.now() + 5);
    return;
  }
  // 试玩期间不推新的播放；stop 仍要放行，否则试玩开始前延迟的 stop 会被拦，玩家停不下来。
  if (body.type === 'play' && getUI().trial) return;
  const msg = (out: SyncBody): SyncMsg => ({ ...out, __ts: 'ts-map', seq: rand(), from: SESSION, inst: INST, born: BORN, ...(to ? { to } : {}) });
  if (body.type === 'world' || body.type === 'play' || body.type === 'stop' || body.type === 'clear') {
    if (body.type === 'play') {
      broadcastAsset = { key: body.mediaId, mime: body.mime, size: 0 };
      refreshPlayerAssets();
    } else if (body.type === 'stop' || body.type === 'clear') {
      broadcastAsset = null;
      refreshPlayerAssets();
    }
    for (const [binding, p] of players) {
      const w = p.trialContext ? getWorld() : getRealWorld();
      if (!transport.hasPeer(binding)) {
        if (transport.peerClosed(binding) || p.context !== projectContext() || !w.party.some(pc => pc.id === p.pcId)) {
          players.delete(binding); saveBindings(); dropPlayerAssets(binding); transport.dropPeer(binding);
        }
        continue;
      }
      // A new project requires a fresh host binding. Trial leaves the real project untouched.
      const context = projectContext();
      const valid = p.context === context && (!p.trialContext || !!getUI().trial && p.trialContext === worldContext()) && w.party.some(pc => pc.id === p.pcId);
      const mapId = p.trialContext ? getUI().trial?.mapId ?? null : w.playerMapId;
      let out: SyncBody;
      if (!valid) out = { type: 'clear' };
      else if (body.type === 'world') {
        const projected = playerWorld(w, mapId, p.pcId);
        const pw = { ...projected, pendingJudgment: pendingForPlayer(p.pcId, p.trialContext), pendingCode: codeForPlayer(p.pcId), combatNotice: combatNoticeFor(p.pcId), utterances: utterancesFor(p.pcId), trialFlags: trialFlagsFor(p.pcId) } as World;
        setPlayerAssets(binding, pw, !p.trialContext);
        out = { type: 'world', world: pw, focus: getUI().focus ?? null, cast: getUI().cast ?? null, you: p.pcId, skills: publicSkillsOf(w.party.find((pc) => pc.id === p.pcId)?.skills ?? []),
          pathway: currentPathwayOf(w.party.find((pc) => pc.id === p.pcId) ?? { skills: [] }),
          avatar: w.party.find((pc) => pc.id === p.pcId)?.avatar ?? null };
      } else out = body;
      transport.sendToPeer(binding, msg(out));
      if (!valid) { players.delete(binding); saveBindings(); dropPlayerAssets(binding); transport.dropPeer(binding); }
    }
    return;
  }
  const out = msg(body);
  if (body.type === 'hello') {
    transport.sendToHost(out);
    return;
  }
  if (body.type === 'alive') for (const binding of players.keys()) {
    if (transport.hasPeer(binding)) transport.sendToPeer(binding, out);
  }
  // 玩家端回传媒体请求：和判定/说话一样，只回给打开它的主持人窗口。
  if (body.type === 'asset-request' || body.type === 'asset-cancel') {
    transport.sendToHost(out);
    return;
  }
  // 玩家端回传判定的掷骰结果：直接回给打开它的那个主持人窗口。
  if (body.type === 'judge-roll' || body.type === 'say' || body.type === 'move' || body.type === 'code-submit' || body.type === 'skill-decision') {
    transport.sendToHost(out);
    return;
  }
  transport.broadcast(out);
}

/** 守卫的入口里，binding 和窗口来源都可能传进来：测试传窗口，WebSocket 传 binding。 */
type PeerRef = string | MessageEventSource | null;
function bindingOf(ref: PeerRef): string | null {
  if (typeof ref === 'string') return players.has(ref) ? ref : null;
  return transport.bindingFor(ref);
}
/** 供 consent 这类规则层使用：把传输层认出来的 binding 换成 pcId。 */
export function pcIdForBinding(binding: string): string | null {
  return players.get(binding)?.pcId ?? null;
}

/** 这条消息该发到哪一类窗口：试玩里的判定只发给试玩窗口，真实世界的判定只发给真实窗口。 */
function sameContextWindow(entry: { trialContext?: string }): boolean {
  return (entry.trialContext ?? null) === (getUI().trial ? worldContext() : null);
}

function setPlayerAssets(binding: string, w: World, allowBroadcast = false): void {
  const media = new Map<string, { mime: string; size: number }>();
  for (const m of w.media ?? []) {
    if (!m || typeof m.id !== 'string') continue;
    const key = assetKeyOf(m);
    if (!key) continue;
    media.set(key, { mime: typeof m.mime === 'string' ? m.mime : 'application/octet-stream', size: typeof m.size === 'number' ? m.size : 0 });
  }
  if (allowBroadcast && broadcastAsset) media.set(broadcastAsset.key, { mime: broadcastAsset.mime, size: broadcastAsset.size });
  assetAllow.set(binding, media);
}

/** 广播开始/结束时重算所有玩家的 media allow：只多这一个文件，不放开媒体库。 */
function refreshPlayerAssets(): void {
  const w = getRealWorld();
  const context = projectContext();
  for (const [binding, p] of players) {
    if (p.trialContext || p.context !== context) continue;
    if (!w.party.some((pc) => pc.id === p.pcId)) continue;
    setPlayerAssets(binding, playerWorld(w, w.playerMapId, p.pcId), true);
  }
}
function dropPlayerAssets(binding: string): void { clearAssetRequestQueues(binding); assetAllow.delete(binding); assetSessions.delete(binding); assetRequestLog.delete(binding); assetFlows.delete(binding); assetBindingNames.delete(binding); stopAssetRateTickIfIdle(); refreshAssetTransferStats(); }

function assetMsg(binding: string, body: AssetBody): boolean {
  return transport.sendToPeer(binding, { ...body, __ts: 'ts-map', seq: rand(), from: SESSION, inst: INST, born: BORN });
}

/** 拒绝也不留 active：最多 32 条 forbidden 在节流钟里发完，玩家收到后清 pending。 */
function rejectAssetRequest(m: Extract<AssetBody, { type: 'asset-request' }>, binding: string): void {
  void serveAssetRequest(m, {
    send: (body) => (players.has(binding) ? assetMsg(binding, body) : false),
    load: async () => undefined,
    meta: () => undefined,
    binding,
    flowTimeoutMs: 0,
  });
}

/** 一条 binding 最多 2 条在途 request；再多先排队（最多 8 条），不是直接 forbidden。 */
function assetFlowHasRoom(binding: string): boolean {
  const flows = assetFlows.get(binding);
  return !flows || flows.size < ASSET_MAX_FLOWS;
}

function clearQueuedAssetRequest(binding: string, requestId: string, key?: string): boolean {
  const queue = assetRequestQueues.get(binding);
  if (!queue) return false;
  const index = queue.findIndex((entry) => entry.m.requestId === requestId);
  if (index < 0) return false;
  const entry = queue[index];
  if (typeof key === 'string' && key) {
    if (!entry.m.keys.includes(key)) return false;
    const keys = entry.m.keys.filter((k) => k !== key);
    if (keys.length) { entry.m = { ...entry.m, keys }; return true; }
  }
  queue.splice(index, 1);
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  if (!queue.length) assetRequestQueues.delete(binding);
  return true;
}

function clearAssetRequestQueues(binding?: string): void {
  const bindings = binding ? [binding] : [...assetRequestQueues.keys()];
  for (const key of bindings) {
    for (const entry of assetRequestQueues.get(key) ?? []) if (entry.timer !== undefined) clearTimeout(entry.timer);
    assetRequestQueues.delete(key);
  }
}

function queueAssetRequest(
  m: Extract<AssetBody, { type: 'asset-request' }>,
  binding: string,
  opts: Pick<ServeAssetOptions, 'load' | 'meta'>,
): void {
  const queue = assetRequestQueues.get(binding) ?? [];
  if (queue.some((entry) => entry.m.requestId === m.requestId) || queue.length >= ASSET_MAX_QUEUED_REQUESTS) {
    rejectAssetRequest(m, binding);
    return;
  }
  const entry: QueuedAssetRequest = { m, load: opts.load, meta: opts.meta };
  if (ASSET_QUEUE_TIMEOUT_MS) {
    entry.timer = setTimeout(() => {
      clearQueuedAssetRequest(binding, m.requestId);
      rejectAssetRequest(m, binding);
    }, ASSET_QUEUE_TIMEOUT_MS);
    (entry.timer as unknown as { unref?: () => void }).unref?.();
  }
  queue.push(entry);
  assetRequestQueues.set(binding, queue);
}

function drainAssetRequestQueue(binding: string): void {
  const queue = assetRequestQueues.get(binding);
  if (!queue || !queue.length) return;
  while (queue.length && assetFlowHasRoom(binding)) {
    const entry = queue.shift()!;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    beginAssetServe(entry.m, binding, { load: entry.load, meta: entry.meta });
  }
  if (!queue.length) assetRequestQueues.delete(binding);
}

function beginAssetServe(
  m: Extract<AssetBody, { type: 'asset-request' }>,
  binding: string,
  opts: Pick<ServeAssetOptions, 'load' | 'meta'> & { stats?: boolean },
): void {
  const session = assetSessions.get(binding) ?? AssetSession.fresh();
  assetSessions.set(binding, session);
  // 同 binding 同 requestId 在途时不能再开一条：否则后一条会覆盖账本，旧 serve 的块会串到新请求上。
  if (session.get(m.requestId) > 0) { rejectAssetRequest(m, binding); return; }
  if (opts.stats !== false && !assetFlowHasRoom(binding)) { queueAssetRequest(m, binding, opts); return; }
  // 超 refs / 超总量直接回 forbidden，不占引用；玩家收到 fail 会清 pending。
  if (!session.tryAcquire(m.requestId)) { rejectAssetRequest(m, binding); return; }
  if (opts.stats !== false) beginAssetFlow(binding, m.requestId, m.keys);
  else refreshAssetTransferStats();
  void serveAssetRequest(m, {
    binding,
    send: (body) => {
      const ok = players.has(binding) ? assetMsg(binding, body) : false;
      if (ok && opts.stats !== false) noteAssetBody(binding, m.requestId, body);
      return ok;
    },
    load: opts.load,
    meta: opts.meta,
    isCancelled: (key) => session.isCancelled(m.requestId, key),
    flowTimeoutMs: ASSET_FLOW_IDLE_TIMEOUT_MS,
    onFlowTimeout: () => {
      session.cancel(m.requestId);
      if (opts.stats !== false) endAssetFlow(binding, m.requestId);
    },
  }).finally(() => { if (opts.stats !== false) endAssetFlow(binding, m.requestId); session.release(m.requestId); refreshAssetTransferStats(); drainAssetRequestQueue(binding); });
}

/** 玩家窗口按 world.media 的存储名来要文件；主持端只发这个 binding 被允许的 key。 */
export function onAssetRequest(m: Extract<AssetBody, { type: 'asset-request' }>, ref: PeerRef): void {
  if (transport.kind !== 'ws') return;
  const binding = bindingOf(ref);
  if (!binding) return;
  if (!players.has(binding)) return;
  const now = Date.now();
  const log = (assetRequestLog.get(binding) ?? []).filter((t) => now - t < 10_000);
  if (log.length >= 30) {
    // 配额拒绝也要登记 active：玩家 reset 的 cancel 能停掉这串 forbidden。
    beginAssetServe(m, binding, { load: async () => undefined, meta: () => undefined, stats: false });
    return;
  }
  log.push(now);
  assetRequestLog.set(binding, log);
  beginAssetServe(m, binding, {
    load: (key) => getRaw(key),
    // 不缓存 allow 表：world 一换，正在传的旧 key 下一块就停。
    meta: (key) => assetAllow.get(binding)?.get(key),
  });
}

/** 玩家 clear/unmount / 单个 key 超时时，别让主持端把几十 MB 发完。 */
export function onAssetCancel(m: Extract<AssetBody, { type: 'asset-cancel' }>, ref: PeerRef): void {
  if (transport.kind !== 'ws') return;
  const binding = bindingOf(ref);
  if (!binding) return;
  if (!players.has(binding)) return;
  clearQueuedAssetRequest(binding, m.requestId, m.key);
  const session = assetSessions.get(binding);
  if (!session?.cancel(m.requestId, m.key)) return; // 迟到/木马 cancel 不留垃圾
  cancelAssetFlow(binding, m.requestId, m.key);
}

/** 玩家载荷里的密码请求：只给门名和谁在输，不带作者密码、不带已输入原文。 */
function codeForPlayer(pcId: string): CodeRequest | null {
  const p = getUI().pendingCode;
  if (!p || p.pcId !== pcId || p.context !== worldContext()) return null;
  return { id: p.id, mapId: p.mapId, objectId: p.objectId, name: p.name, pcId: p.pcId, at: p.at, submitted: !!p.code };
}

/** 让玩家窗口弹出密码输入。 */
export function pushCodeRequest(pcId: string): void {
  const request = codeForPlayer(pcId);
  if (!request) return;
  for (const [binding, entry] of players) {
    if (entry.pcId !== pcId || !transport.hasPeer(binding) || !sameContextWindow(entry)) continue;
    const msg: SyncMsg = { type: 'code-request', request, __ts: 'ts-map', seq: rand(), from: SESSION, inst: INST, born: BORN };
    transport.sendToPeer(binding, msg);
  }
}

/** 密码裁定完了：玩家窗口收到反馈并收掉输入框。只发文字，不发密码和门锁内部数据。 */
export function pushCodeResult(pcId: string, id: string, text?: string): void {
  for (const [binding, entry] of players) {
    if (entry.pcId !== pcId || !transport.hasPeer(binding) || !sameContextWindow(entry)) continue;
    const msg: SyncMsg = { type: 'code-result', id, ...(text ? { text } : {}), __ts: 'ts-map', seq: rand(), from: SESSION, inst: INST, born: BORN };
    transport.sendToPeer(binding, msg);
  }
}

/** 玩家窗口发来的密码：只认绑定给「这条等待」的那扇窗。 */
export function onCodeSubmit(m: Extract<SyncMsg, { type: 'code-submit' }>, ref: PeerRef): void {
  const p = getUI().pendingCode;
  if (!p || p.id !== m.id) return;
  const binding = bindingOf(ref);
  const entry = binding ? players.get(binding) : undefined;
  if (!entry || entry.pcId !== p.pcId) return;
  if (!sameContextWindow(entry)) return;
  if (m.from !== SESSION) return;
  if (typeof m.code !== 'string' || !m.code) return;
  if (m.code.length > 256) return;
  if (p.code !== null) return;
  setUI({ pendingCode: { ...p, code: m.code } });
}

/** 开出判定后，直接把「轮到你了」推到对应玩家的窗口。 */
/** 这个角色有没有开着的玩家窗口：有就让他自己掷，没有就见证者代掷。 */
export function playerWindowFor(pcId: string, trialContext: string | null = getUI().trial ? worldContext() : null): boolean {
  for (const [binding, e] of players) {
    if (e.pcId !== pcId || !transport.hasPeer(binding)) continue;
    // 试玩窗口和真实窗口不能互相冒充：只认当前上下文的那个。
    if ((e.trialContext ?? null) === trialContext) return true;
  }
  return false;
}

export function pushJudgmentRequest(pcId: string): void {
  // 只发「要掷什么」，不发主持端内部的结算数据：
  // jump 里带着落点、摔伤档，推给玩家等于把结果提前告诉他；context 也不给玩家。
  for (const [binding, entry] of players) {
    if (entry.pcId !== pcId || !transport.hasPeer(binding) || !sameContextWindow(entry)) continue;
    const p = pendingFor(pcId, entry.trialContext);
    if (!p) continue;
    const judgment = forPlayer(p);
    const msg: SyncMsg = { type: 'judge-request', judgment, __ts: 'ts-map', seq: rand(), from: SESSION, inst: INST, born: BORN };
    transport.sendToPeer(binding, msg);
  }
}

/** 取消判定时把「别等了」推到那个玩家的窗口：不然他的骰盘会一直挂着，掷了也没人接。 */
export function pushJudgeCancel(pcId: string, judgmentId: string): void {
  for (const [binding, entry] of players) {
    if (entry.pcId !== pcId || !transport.hasPeer(binding) || !sameContextWindow(entry)) continue;
    const msg: SyncMsg = { type: 'judge-cancel', id: judgmentId, __ts: 'ts-map', seq: rand(), from: SESSION, inst: INST, born: BORN };
    transport.sendToPeer(binding, msg);
  }
}

/** 一笔判定走完了（玩家掷完广播 / 见证者代掷结算）：清掉主持端的等待状态，并让还在等这颗骰子的窗口收掉骰盘。 */
export function closePendingJudgment(): void {
  const p = getUI().pendingJudgment;
  if (!p) return;
  setUI({ pendingJudgment: null, judgmentResult: null });
  if (p.subjectId) pushJudgeCancel(p.subjectId, p.id);
}

/** 玩家窗口掷完，主持人这边收下来，等着确认广播。 */
/**
 * 玩家窗口发来的一句话：落到主持人这边的 world 里，等见证者接。
 * 发言人和地图都用主持人这边的绑定信息，不信玩家自报的身份。
 */
function onSay(m: Extract<SyncMsg, { type: 'say' }>, ref: PeerRef): void {
  const binding = bindingOf(ref);
  const p = binding ? players.get(binding) : undefined;
  if (!p) return;
  const t = getUI().trial;
  if (!t) return;
  const pl = t.players.find((x) => x.pcId === p.pcId);
  if (!pl) return;
  say(m.text, m.targetTokenId, { pcId: p.pcId, tokenId: pl.tokenId, mapId: t.mapId, name: pl.name });
}

/** 试玩里这个角色自己的处境：被暂停了吗、轮到他了吗。 */
function trialFlagsFor(pcId: string): { paused: boolean; isCurrent: boolean } | null {
  const t = getUI().trial;
  if (!t) return null;
  const idx = t.players.findIndex((x) => x.pcId === pcId);
  if (idx < 0) return null;
  return { paused: !!t.players[idx].paused, isCurrent: idx === t.current };
}

/** 试玩执行一步移动。trial 和 sync 互相 import，用注册回调避开直接依赖。
 * 返回动作结果而不是“有没有 msg”：转身、起跳确认、跳过去成功都可能有提示，
 * 不能把提示本身当成失败。 */
let trialMoveHandler: ((dx: number, dy: number) => TrialMoveSignal) | null = null;
export function registerTrialMove(fn: (dx: number, dy: number) => TrialMoveSignal): void { trialMoveHandler = fn; }

function replyMove(binding: string, ok: boolean, msg: string, kind: TrialMoveSignal): void {
  transport.sendToPeer(binding, { type: 'move-result', ok, msg, kind, __ts: 'ts-map', seq: rand(), from: SESSION, inst: INST, born: BORN });
}

/**
 * 玩家窗口按了方向键。
 * 身份用主持人这边的绑定反查，不信玩家自报；不是他的回合一概不认。
 */
export function onMove(m: Extract<SyncMsg, { type: 'move' }>, ref: PeerRef): void {
  const binding = bindingOf(ref);
  if (!binding) return;
  const entry = players.get(binding);
  if (!entry || !trialMoveHandler) return;
  if (!Number.isInteger(m.dx) || !Number.isInteger(m.dy)) return;
  if (Math.abs(m.dx) + Math.abs(m.dy) !== 1) return; // 只认一格一步
  const t = getUI().trial;
  if (!t) return;
  const pl = t.players[t.current];
  if (!pl || pl.pcId !== entry.pcId) return replyMove(binding, false, '现在不是你的回合', 'failed');
  if (pl.paused) return replyMove(binding, false, '见证者暂停了你的操作', 'failed');
  const outcome = trialMoveHandler(m.dx, m.dy);
  const msg = getUI().trial?.msg ?? '';
  // 转身、起跳确认、跳过去成功都不是失败；只有 failed 才弹红条。
  const ok = outcome === 'turn' || outcome === 'move' || outcome === 'prompt';
  replyMove(binding, ok, msg, outcome);
}

export function onJudgeRoll(m: Extract<SyncMsg, { type: 'judge-roll' }>, ref: PeerRef): void {
  const p = getUI().pendingJudgment;
  if (!p || p.id !== m.id) return;
  // 这颗骰子必须来自绑给「判定角色」的那个窗口：别的玩家窗口、甚至别的标签页塞来的都不算。
  const binding = bindingOf(ref);
  if (!binding) return;
  const entry = players.get(binding);
  if (!entry || entry.pcId !== p.subjectId) return;
  // 也不能跨上下文：判定自己的上下文要对，来源窗口也得是同一类窗口——
  // 试玩窗口不能替真实判定掷，真实窗口也不能替试玩判定掷。
  if (p.context !== worldContext()) return;
  if (!sameContextWindow(entry)) return;
  // 这里以前只比一个 id：任何同源标签页（甚至 BroadcastChannel，source 是 null 会跳过来源检查）
  // 都能往待掷判定里塞一颗骰子，包括不可能的 D20=999。骰子是这个程序最核心的承诺，得验。
  if (m.from !== SESSION) return;
  if (!Number.isInteger(m.sides) || m.sides !== p.sides) return;
  if (!Number.isInteger(m.value) || m.value < 1 || m.value > m.sides) return;
  const maxValues = p.check?.attrs.length ?? 2;
  if (m.values !== undefined) {
    if (!Array.isArray(m.values) || m.values.length > maxValues) return;
    if (m.values.some((v) => !Number.isInteger(v) || v < 1 || v > m.sides)) return;
    if (!m.values.includes(m.value)) return; // 采信值必须是掷出来的其中一颗
  }
  // 多属性判定必须把每个属性那颗都送齐；缺一颗别让它进结果、到结算才报错。
  if (p.check && (!m.values || m.values.length !== p.check.attrs.length)) return;
  if (m.tens !== null && !(Number.isInteger(m.tens) && m.tens >= 0 && m.tens <= 90 && m.tens % 10 === 0)) return;
  if (m.units !== null && !(Number.isInteger(m.units) && m.units >= 0 && m.units <= 9)) return;
  setUI({
    judgmentResult: {
      judgmentId: m.id, title: m.title, sides: m.sides, value: m.value, values: m.values, tens: m.tens, units: m.units,
      material: m.material, seed: m.seed, rollId: m.rollId, byStandIn: false,
    },
  });
}

/** 玩家掷完：把结果送到见证者那边等他确认。 */
export function reportJudgmentRoll(body: Extract<SyncBody, { type: 'judge-roll' }>): void {
  send({ ...body });
}

/** 订阅消息（两条路都听，按编号去重）。 */
export function listen(fn: (m: SyncMsg, source: MessageEventSource | null, from?: string | null) => void, _player = isPlayerEntry()) {
  return transport.onMessage((m, meta) => fn(m, meta.source, meta.from));
}

/**
 * 编辑器这边：
 * - 启动时先问一句会话标识有没有人在用（复制标签页），有就换新的；
 * - 别的编辑器来问、而且问的正是自己的标识，就回答"在用"；
 * - 只回应找自己的玩家窗口（没指定找谁的也回应），顺便记下它，之后直接 postMessage。
 */
export function listenAsEditor(onHello: () => void) {
  const off = transport.onMessage((m, meta) => {
    // 另一个编辑器实例在用同一个会话标识（复制了标签页）：不管消息来得多晚，都按"后打开的让"处理
    // 玩家窗口的 judge-roll 也带同一个 SESSION，但那是绑定窗口发的，不是复制出来的编辑器，得放行。
    // skill-decision / asset 也要放行：玩家点「同意/不同意」或要媒体时同源部署下玩家窗口的 sessionStorage 是主持人的副本，
    // 不排除它就会命中这个分支去 renewSession()，所有玩家窗口会永久掉线。
    const playerAsset = m.type === 'asset-request' || m.type === 'asset-cancel';
    if (!playerAsset && m.type !== 'hello' && m.type !== 'judge-roll' && m.type !== 'say' && m.type !== 'move'
      && m.type !== 'code-submit' && m.type !== 'skill-decision' && m.from === SESSION && m.inst !== INST) {
      const iAmNewer = m.born < BORN || (m.born === BORN && m.inst < INST);
      if (iAmNewer) renewSession();
      else { send({ type: 'taken' }); onHello(); saveNow(); } // 我是原来那个：叫对方换号，重推一次世界（万一玩家窗口刚才收到了对方的），并重存一次自己的槽（万一对方存进来过）
      return;
    }
    if (m.type === 'claim' || m.type === 'taken' || m.type === 'alive') return;
    if (m.type === 'judge-roll') { onJudgeRoll(m, meta.from ?? meta.source); return; }
    if (m.type === 'code-submit') { onCodeSubmit(m, meta.from ?? meta.source); return; }
    if (m.type === 'say') { onSay(m, meta.from ?? meta.source); return; }
    if (m.type === 'move') { onMove(m, meta.from ?? meta.source); return; }
    if (m.type === 'asset-request') { onAssetRequest(m, meta.from ?? meta.source); return; }
    if (m.type === 'asset-cancel') { onAssetCancel(m, meta.from ?? meta.source); return; }
    if (m.type !== 'hello' || (m.to && m.to !== SESSION)) return;
    const p = m.binding && players.get(m.binding);
    if (!p) return;
    // 线上房间的绑定由服务器和 onlineRoom 维护，没有本地 window 可绑。
    if (transport.kind !== 'ws' && !transport.bindPeer(m.binding!, meta.source)) return;
    onHello();
  });
  if (transport.hasBroadcast) { quietUntil = Date.now() + 250; send({ type: 'claim' }); }
  const beat = window.setInterval(() => send({ type: 'alive' }), 2000);
  return () => { off(); clearInterval(beat); };
}

/**
 * 玩家窗口这边：只接收绑定的那个编辑器的世界和播放。
 * 网址带会话和主持人创建的绑定凭据；不提供玩家端换角色或全队总览。
 * 一段时间没收到消息就再打个招呼（编辑器刷新过、只能走 postMessage 时靠这个重新连上）。
 */
export interface PlayerListenOptions { session?: string | null; binding?: string | null; online?: boolean }

export function listenAsPlayer(fn: (m: SyncMsg) => void, opts: PlayerListenOptions = {}) {
  const url = new URL(location.href);
  let bound = opts.online ? opts.session ?? null : opts.session ?? url.searchParams.get('session');
  const binding = opts.binding ?? url.searchParams.get('binding');
  // 只认一个编辑器实例：同一个会话标识出现第二个实例（复制了标签页、还没来得及换号）时不理它；
  // 只有原来那个实例安静了一阵（关了、刷新了），才改认新的实例
  let inst: string | null = null;
  let lastHeard = 0;
  const QUIET = 5000;
  if (!binding) return () => {};
  const off = transport.onMessage((m, meta) => {
    if (m.type !== 'world' && m.type !== 'play' && m.type !== 'stop' && m.type !== 'clear' && m.type !== 'alive' && m.type !== 'judge-request' && m.type !== 'judge-cancel' && m.type !== 'code-request' && m.type !== 'code-result' && m.type !== 'move-result' && m.type !== 'asset-start' && m.type !== 'asset-chunk' && m.type !== 'asset-end' && m.type !== 'asset-fail') return;
    if (m.type !== 'alive' && meta.from !== 'host') return;
    // 线上第一份 world 到了才知道主持人的 SESSION；本地 URL 里已经钉死。
    if (bound && m.from !== bound) return;
    if (!bound) bound = m.from;
    if (inst && m.inst !== inst) {
      if (Date.now() - lastHeard < QUIET) return; // 原来那个还活着：这是复制出来的，不认
      if (m.type !== 'world' && m.type !== 'clear') { send({ type: 'hello', binding: binding ?? undefined }, bound); return; } // 换认新实例：先请它推一整份世界，从世界开始认
    }
    inst = m.inst;
    lastHeard = Date.now();
    if (m.type !== 'alive') fn(m);
  });
  send({ type: 'hello', binding: binding ?? undefined }, bound ?? undefined);
  const beat = window.setInterval(() => {
    if (lastHeard && Date.now() - lastHeard > 10000) fn({ type: 'clear', __ts: 'ts-map', seq: rand(), from: bound ?? '', inst: INST, born: BORN });
    if (Date.now() - lastHeard > 10000 || !inst) send({ type: 'hello', binding: binding ?? undefined }, bound ?? undefined);
  }, 5000);
  return () => { off(); clearInterval(beat); };
}

/** focus / 技能发动状态变了要立刻推一次：玩家窗口靠它暂停（只能看不能动）。 */
export function pushFocus() {
  send({ type: 'world', world: getWorld() });
}

let timer: number | undefined;
export function broadcastWorld(w: World) {
  clearTimeout(timer);
  timer = window.setTimeout(() => send({ type: 'world', world: w }), 60);
}
