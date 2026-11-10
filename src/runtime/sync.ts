import { hostOriginForPlayer, playerWindowBase, playerWindowOrigin, messageTarget, isPlayerEntry } from '../core/deployment';
import { identityKnown, playerSeen, UNKNOWN_OBJECT } from '../scene/identity';
import { objectEnabled } from '../core/objectData.js';
import { isArchitectureObject, clipArchitecture, fogAt, tokenPosition } from '../scene/architecture';
import { anyVisible } from '../scene/memory';
import type { CombatNotice, DiceJudgment, Endpoint, GameMap, PendingJudgment, PlayerClue, VisionLayer, World, Focus, SkillCast, PublicSkill } from '../core/types';
import { say, utterancesFor } from '../rules/dialogue';
import { visibleMarks } from '../scene/perception';
import { viewerOf, visiblePoint } from '../scene/sight';
import { currentPathwayOf, publicSkillsOf } from '../rules/skills';
import { numbering } from '../scene/render';
import { getRealWorld, getWorld, getUI, setUI, saveNow, worldContext, toast } from '../core/store';
import { SESSION, rand, renewSession } from '../core/session';
import { effectiveLayer, emptyVision } from '../scene/vision';
import { onProjectReplaced, projectContext } from '../core/store';

// 主持人窗口 ↔ 玩家窗口。玩家窗口用来共享屏幕给玩家（第一阶段还没有联网，靠共享屏幕）。
// world / 播放仅通过已绑定窗口的 postMessage 定向发送。
// 公共 BroadcastChannel 只传会话占用与存活，不传 world、角色或绑定凭据。

export type SyncBody =
  | { type: 'world'; world: World; focus?: Focus | null; cast?: SkillCast | null; you?: string; skills?: PublicSkill[]; pathway?: string | null; avatar?: string | null }
  | { type: 'skill-decision'; castId: string; ok: boolean } // 玩家窗口回传：同不同意发动
  | { type: 'hello'; binding?: string }
  | { type: 'judge-request'; judgment: PendingJudgment } // 见证者→玩家：轮到你自己掷
  | { type: 'judge-cancel'; id: string } // 见证者取消整个判定
  | { type: 'judge-roll'; id: string; title: string; sides: number; value: number; tens: number | null; units: number | null; material: string; seed: number; rollId: string } // 玩家掷完回传
  | { type: 'say'; text: string; targetTokenId: string | null } // 玩家窗口→见证者：玩家说了什么
  | { type: 'move'; dx: number; dy: number } // 玩家窗口→见证者：我要往这个方向走一格
  | { type: 'move-result'; ok: boolean; msg: string } // 见证者→玩家：这一走成没成
  | { type: 'clear' }
  | { type: 'play'; mediaId: string; label: string; mime: string; blob?: Blob }
  | { type: 'stop' }
  | { type: 'claim' } // 编辑器启动时：这个会话标识有人在用吗？
  | { type: 'taken' } // 回答：在用（复制标签页时会碰上），换一个
  | { type: 'alive' }; // 编辑器每两秒报一声"我还在"：玩家窗口靠它判断原来那个编辑器是不是已经关了 / 刷新了
/** from：发送方的会话；to：只给某个会话（玩家窗口打招呼时用）。 */
/** inst / born：发送的是哪个页面实例、什么时候打开的（同一个会话标识出现在两个实例上时，后打开的让）。 */
export type SyncMsg = SyncBody & { __ts: 'ts-map'; seq: string; from: string; to?: string; inst: string; born: number };

export { SESSION };
const INST = rand(); // 这个页面实例（刷新就是新的实例，但会话标识不变）
const BORN = Date.now();
let channel: BroadcastChannel | null = null;
try { channel = new BroadcastChannel('ts-map-sync'); } catch { /* 不支持就只走 postMessage */ }

// Binding is held only by the host; the URL carries an opaque reconnect capability, never a selectable pcId.
const players = new Map<string, { win: Window | null; pcId: string; context: number; trialContext?: string }>();
const bindingsKey = () => `ts-player-bindings-${SESSION}`;
try {
  const saved = JSON.parse(sessionStorage.getItem(bindingsKey()) ?? '{}') as Record<string, string>;
  for (const [binding, pcId] of Object.entries(saved)) if (typeof pcId === 'string') players.set(binding, { win: null, pcId, context: projectContext() });
} catch { /* no reconnect state */ }
function saveBindings() {
  try { sessionStorage.setItem(bindingsKey(), JSON.stringify(Object.fromEntries([...players].filter(([, p]) => !p.trialContext).map(([key, p]) => [key, p.pcId])))); } catch { /* unavailable */ }
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

/** 只把「落在你身上」的待掷判定发给这个玩家；别人的判定他一概不知道。 */
function pendingFor(pcId: string): PendingJudgment | null {
  const p = getUI().pendingJudgment;
  return p && p.subjectId === pcId ? p : null;
}

export function openPlayerWindow(pcId?: string, trial = false) {
  const w = trial ? getWorld() : getRealWorld(), id = pcId ?? w.party[0]?.id;
  if (!id || !w.party.some(p => p.id === id)) return;
  const binding = rand();
  const base = playerWindowBase();
  const win = window.open(`${base}?view=player&session=${SESSION}&binding=${binding}`, `ts-player-${binding}`, 'width=1280,height=800');
  if (win) { players.set(binding, { win, pcId: id, context: projectContext(), ...(trial ? { trialContext: worldContext() } : {}) }); saveBindings(); }
  else toast(`玩家窗口被浏览器拦截，请允许此站点弹出窗口，再点「${trial ? '打开试玩玩家端' : '打开玩家窗口…'}」`);
}
export function clearTrialWindows() {
  for (const [id, p] of players) if (p.trialContext) {
    try { p.win?.postMessage({ type: 'clear', __ts: 'ts-map', seq: rand(), from: SESSION, inst: INST, born: BORN }, target()); } catch { /* closed */ }
    players.delete(id);
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

const isMsg = (d: unknown): d is SyncMsg => !!d && typeof d === 'object' && (d as SyncMsg).__ts === 'ts-map' && typeof (d as SyncMsg).from === 'string' && typeof (d as SyncMsg).inst === 'string' && typeof (d as SyncMsg).born === 'number';

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
    ...pm.cells, ...pm.seen.cells,
    ...Object.values(pm.subCells ?? {}),
    ...Object.values(pm.seen.subCells ?? {}),
    ...Object.values(pm.views).flatMap((L) => [...L.seen.cells, ...Object.values(L.seen.subCells ?? {})]),
  ] : []);
  const usedMaterials = new Set(pm ? [
    ...Object.values(pm.materialCells ?? {}),
    ...Object.values(pm.materialSubCells ?? {}),
    ...Object.values(pm.seen.materialCells ?? {}),
    ...Object.values(pm.seen.materialSubCells ?? {}),
  ] : []);
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
    flows: [], log: [], npcs: [], media: [],
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

/** Only the bound role's live cells and memory leave the host. */
export function playerMap(m: GameMap, L: VisionLayer, pcId?: string): GameMap {
  const seen = {
    cells: L.seen.cells.map((c, i) => L.fog[i] ? c : ''),
    objects: L.seen.objects.filter(r => {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (L.fog[y * m.width + x]) return true;
      return false;
    }).map(r => playerSeen(r, pcId, m.objects.find(o => o.id === r.id))),
    architecture: [...clipArchitecture(m, L, 1, L.seen.architecture ?? []), ...clipArchitecture(m, L, 2, L.seen.architecture ?? [])],
    subCells: Object.fromEntries(Object.entries(L.seen.subCells ?? {}).filter(([key]) => L.subFog?.[+key])),
    materialCells: Object.fromEntries(Object.entries(L.seen.materialCells ?? {}).filter(([key]) => L.fog[+key])),
    materialSubCells: Object.fromEntries(Object.entries(L.seen.materialSubCells ?? {}).filter(([key]) => L.subFog?.[+key])),
  };
  return {
    id: m.id, name: m.name, layer: m.layer, floor: m.floor, width: m.width, height: m.height,
    fog: [...L.fog], subFog: { ...L.subFog }, seen, views: {}, autoFog: false,
    architectureFragments: clipArchitecture(m, L),
    subdivisions: m.subdivisions?.filter(i => L.fog[i]),
    cells: m.cells.map((c, i) => L.fog[i] === 1 ? c : ''),
    subCells: Object.fromEntries(Object.entries(m.subCells ?? {}).filter(([key]) => L.subFog?.[+key] === 1)),
    materialCells: Object.fromEntries(Object.entries(m.materialCells ?? {}).filter(([key]) => L.fog[+key] === 1)),
    materialSubCells: Object.fromEntries(Object.entries(m.materialSubCells ?? {}).filter(([key]) => L.subFog?.[+key] === 1)),
    d100: m.d100.map(() => 0), rooms: [], roomCells: m.roomCells.map(() => ''), notes: '', spawn: null,
    tokens: m.tokens.filter(t => { const p = tokenPosition(t); return t.pcId === pcId || fogAt(m, L, p.x, p.y) === 1; }),
    objects: m.objects.filter(o => objectEnabled(m, o) && o.kind === 'object' && !isArchitectureObject(o) && !o.hidden && anyVisible({ ...m, ...L }, o)).map(o => ({
      id: o.id, kind: o.kind, name: identityKnown(o, pcId) ? o.name : UNKNOWN_OBJECT, x: o.x, y: o.y, w: o.w, h: o.h, anchor: o.anchor, height: o.height, color: o.color, icon: identityKnown(o, pcId) ? o.icon : '',
      state: identityKnown(o, pcId) ? o.state : 0, states: identityKnown(o, pcId) ? o.states.map((s, k) => k === o.state ? s : '') : [''], notes: '', hidden: false, media: [], secrets: [],
    })),
  };
}

onProjectReplaced(() => {
  for (const p of players.values()) if (p.win && !p.win.closed) {
    try { p.win.postMessage({ type: 'clear', __ts: 'ts-map', seq: rand(), from: SESSION, inst: INST, born: BORN }, target()); } catch { /* closed */ }
  }
  players.clear(); saveBindings();
});

// Each deployment pins the other endpoint; 开发时没配就发当前页面的来源（同源窗口）。
const target = () => messageTarget(playerWindowOrigin());

let quietUntil = 0; // 编辑器刚启动、还在确认会话标识没撞车时，先不往外推

export function send(body: SyncBody, to?: string) {
  if ((body.type === 'world' || body.type === 'play' || body.type === 'stop') && Date.now() < quietUntil) {
    window.setTimeout(() => send(body, to), quietUntil - Date.now() + 5);
    return;
  }
  // 试玩期间不推播放；下面按绑定分别发送沙盒或真正的世界。
  if ((body.type === 'play' || body.type === 'stop') && getUI().trial) return;
  const msg = (out: SyncBody): SyncMsg => ({ ...out, __ts: 'ts-map', seq: rand(), from: SESSION, inst: INST, born: BORN, ...(to ? { to } : {}) });
  if (body.type === 'world' || body.type === 'play' || body.type === 'stop' || body.type === 'clear') {
    for (const [binding, p] of players) {
      const w = p.trialContext ? getWorld() : getRealWorld();
      if (!p.win) { if (p.context !== projectContext() || !w.party.some(pc => pc.id === p.pcId)) { players.delete(binding); saveBindings(); } continue; }
      if (p.win.closed) { players.delete(binding); saveBindings(); continue; }
      // A new project requires a fresh host binding. Trial leaves the real project untouched.
      const context = projectContext();
      const valid = p.context === context && (!p.trialContext || !!getUI().trial && p.trialContext === worldContext()) && w.party.some(pc => pc.id === p.pcId);
      const mapId = p.trialContext ? getUI().trial?.mapId ?? null : w.playerMapId;
      const out: SyncBody = !valid
        ? { type: 'clear' }
        : body.type === 'world'
          ? { type: 'world', world: { ...playerWorld(w, mapId, p.pcId), pendingJudgment: pendingFor(p.pcId), combatNotice: combatNoticeFor(p.pcId), utterances: utterancesFor(p.pcId), trialFlags: trialFlagsFor(p.pcId) } as World, focus: getUI().focus ?? null, cast: getUI().cast ?? null, you: p.pcId, skills: publicSkillsOf(w.party.find((pc) => pc.id === p.pcId)?.skills ?? []),
            pathway: currentPathwayOf(w.party.find((pc) => pc.id === p.pcId) ?? { skills: [] }),
            avatar: w.party.find((pc) => pc.id === p.pcId)?.avatar ?? null }
          : body;
      try { p.win.postMessage(msg(out), target()); } catch { /* closed */ }
      if (!valid) { players.delete(binding); saveBindings(); }
    }
    return;
  }
  const out = msg(body);
  if (body.type === 'hello') {
    if (window.opener && !window.opener.closed) window.opener.postMessage(out, messageTarget(hostOriginForPlayer()));
    return;
  }
  if (body.type === 'alive') for (const p of players.values()) {
    if (p.win && !p.win.closed) try { p.win.postMessage(out, target()); } catch { /* closed */ }
  }
  // 玩家端回传判定的掷骰结果：直接回给打开它的那个主持人窗口。
  if (body.type === 'judge-roll' || body.type === 'say' || body.type === 'move') {
    if (window.opener && !window.opener.closed) { try { window.opener.postMessage(out, messageTarget(hostOriginForPlayer())); } catch { /* closed */ } }
    return;
  }
  try { channel?.postMessage(out); } catch { /* unavailable */ }
}

/** 开出判定后，直接把「轮到你了」推到对应玩家的窗口。 */
export function pushJudgmentRequest(pcId: string): void {
  const p = pendingFor(pcId);
  if (!p) return;
  // 只发「要掷什么」，不发主持端内部的结算数据：
  // jump 里带着落点、摔伤档，推给玩家等于把结果提前告诉他。
  const judgment: PendingJudgment = { ...p, jump: null };
  for (const [binding, entry] of players) {
    if (entry.pcId !== pcId || !entry.win || entry.win.closed) continue;
    const msg: SyncMsg = { type: 'judge-request', judgment, __ts: 'ts-map', seq: rand(), from: SESSION, inst: INST, born: BORN };
    try { entry.win.postMessage(msg, target()); } catch { /* closed */ }
    void binding;
  }
}

/** 玩家窗口掷完，主持人这边收下来，等着确认广播。 */
/**
 * 玩家窗口发来的一句话：落到主持人这边的 world 里，等见证者接。
 * 发言人和地图都用主持人这边的绑定信息，不信玩家自报的身份。
 */
function onSay(m: Extract<SyncMsg, { type: 'say' }>, source: MessageEventSource | null): void {
  const binding = [...players.entries()].find(([, p]) => p.win === source)?.[0];
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

/** 试玩执行一步移动。trial 和 sync 互相 import，用注册回调避开直接依赖。 */
let trialMoveHandler: ((dx: number, dy: number) => void) | null = null;
export function registerTrialMove(fn: (dx: number, dy: number) => void): void { trialMoveHandler = fn; }

function replyMove(entry: { win: Window | null }, ok: boolean, msg: string): void {
  try {
    entry.win?.postMessage({ type: 'move-result', ok, msg, __ts: 'ts-map', seq: rand(), from: SESSION, inst: INST, born: BORN }, target());
  } catch { /* closed */ }
}

/**
 * 玩家窗口按了方向键。
 * 身份用主持人这边的绑定反查，不信玩家自报；不是他的回合一概不认。
 */
function onMove(m: Extract<SyncMsg, { type: 'move' }>, source: MessageEventSource | null): void {
  const binding = [...players.entries()].find(([, p]) => p.win === source)?.[0];
  const entry = binding ? players.get(binding) : undefined;
  if (!entry || !trialMoveHandler) return;
  if (!Number.isInteger(m.dx) || !Number.isInteger(m.dy)) return;
  if (Math.abs(m.dx) + Math.abs(m.dy) !== 1) return; // 只认一格一步
  const t = getUI().trial;
  if (!t) return;
  const pl = t.players[t.current];
  if (!pl || pl.pcId !== entry.pcId) return replyMove(entry, false, '现在不是你的回合');
  if (pl.paused) return replyMove(entry, false, '见证者暂停了你的操作');
  trialMoveHandler(m.dx, m.dy);
  const msg = getUI().trial?.msg ?? '';
  replyMove(entry, !msg, msg);
}

function onJudgeRoll(m: Extract<SyncMsg, { type: 'judge-roll' }>): void {
  const p = getUI().pendingJudgment;
  if (!p || p.id !== m.id) return;
  setUI({
    judgmentResult: {
      id: m.id, title: m.title, sides: m.sides, value: m.value, tens: m.tens, units: m.units,
      material: m.material, seed: m.seed, rollId: m.rollId, byStandIn: false,
    },
  });
}

/** 玩家掷完：把结果送到见证者那边等他确认。 */
export function reportJudgmentRoll(body: Extract<SyncBody, { type: 'judge-roll' }>): void {
  send({ ...body });
}

/** 订阅消息（两条路都听，按编号去重）。 */
export function listen(fn: (m: SyncMsg, source: MessageEventSource | null) => void, player = isPlayerEntry()) {
  const seen = new Set<string>();
  const handle = (e: MessageEvent) => {
    if (!isMsg(e.data) || seen.has(e.data.seq)) return;
    // 主持端这边：自己的窗口（另一个编辑器标签、BroadcastChannel）来自本机 origin，
    // 玩家窗口来自配置的玩家 origin——分端口部署时这两个不一样，得都认。
    const allowed = player
      ? [hostOriginForPlayer()]
      : e.data.type === 'hello'
        ? [playerWindowOrigin()]
        : [location.origin, playerWindowOrigin()];
    if (e.origin && !allowed.includes(e.origin)) return;
    // Cross-origin windows never participate in host session-collision negotiation.
    // 玩家窗口回传的掷骰结果例外：那是绑定窗口自己发的，要收。
    if (!player && e.data.type !== 'hello' && e.data.type !== 'judge-roll' && e.data.type !== 'say' && e.data.type !== 'move' && e.source) return;
    seen.add(e.data.seq);
    if (seen.size > 500) seen.clear();
    fn(e.data, e.source);
  };
  channel?.addEventListener('message', handle);
  window.addEventListener('message', handle);
  return () => {
    channel?.removeEventListener('message', handle);
    window.removeEventListener('message', handle);
  };
}

/**
 * 编辑器这边：
 * - 启动时先问一句会话标识有没有人在用（复制标签页），有就换新的；
 * - 别的编辑器来问、而且问的正是自己的标识，就回答"在用"；
 * - 只回应找自己的玩家窗口（没指定找谁的也回应），顺便记下它，之后直接 postMessage。
 */
export function listenAsEditor(onHello: () => void) {
  const off = listen((m, source) => {
    // 另一个编辑器实例在用同一个会话标识（复制了标签页）：不管消息来得多晚，都按"后打开的让"处理
    // 玩家窗口的 judge-roll 也带同一个 SESSION，但那是绑定窗口发的，不是复制出来的编辑器，得放行。
    if (m.type !== 'hello' && m.type !== 'judge-roll' && m.type !== 'say' && m.type !== 'move' && m.from === SESSION && m.inst !== INST) {
      const iAmNewer = m.born < BORN || (m.born === BORN && m.inst < INST);
      if (iAmNewer) renewSession();
      else { send({ type: 'taken' }); onHello(); saveNow(); } // 我是原来那个：叫对方换号，重推一次世界（万一玩家窗口刚才收到了对方的），并重存一次自己的槽（万一对方存进来过）
      return;
    }
    if (m.type === 'claim' || m.type === 'taken' || m.type === 'alive') return;
    if (m.type === 'judge-roll') { onJudgeRoll(m); return; }
    if (m.type === 'say') { onSay(m, source); return; }
    if (m.type === 'move') { onMove(m, source); return; }
    if (m.type !== 'hello' || (m.to && m.to !== SESSION)) return;
    const p = m.binding && players.get(m.binding);
    if (!p || !source || !('postMessage' in source) || p.win && source !== p.win) return;
    p.win = source as Window;
    onHello();
  });
  if (channel) { quietUntil = Date.now() + 250; send({ type: 'claim' }); }
  const beat = window.setInterval(() => send({ type: 'alive' }), 2000);
  return () => { off(); clearInterval(beat); };
}

/**
 * 玩家窗口这边：只接收绑定的那个编辑器的世界和播放。
 * 网址带会话和主持人创建的绑定凭据；不提供玩家端换角色或全队总览。
 * 一段时间没收到消息就再打个招呼（编辑器刷新过、只能走 postMessage 时靠这个重新连上）。
 */
export function listenAsPlayer(fn: (m: SyncMsg) => void) {
  const url = new URL(location.href);
  const bound = url.searchParams.get('session');
  const binding = url.searchParams.get('binding');
  // 只认一个编辑器实例：同一个会话标识出现第二个实例（复制了标签页、还没来得及换号）时不理它；
  // 只有原来那个实例安静了一阵（关了、刷新了），才改认新的实例
  let inst: string | null = null;
  let lastHeard = 0;
  const QUIET = 5000;
  const off = listen((m, source) => {
    if (m.type !== 'world' && m.type !== 'play' && m.type !== 'stop' && m.type !== 'clear' && m.type !== 'alive' && m.type !== 'judge-request' && m.type !== 'judge-cancel' && m.type !== 'move-result') return;
    if (!bound || !binding) return;
    if (m.type !== 'alive' && (!source || source !== window.opener)) return;
    if (m.from !== bound) return;
    if (inst && m.inst !== inst) {
      if (Date.now() - lastHeard < QUIET) return; // 原来那个还活着：这是复制出来的，不认
      if (m.type !== 'world' && m.type !== 'clear') { send({ type: 'hello', binding: binding ?? undefined }, bound); return; } // 换认新实例：先请它推一整份世界，从世界开始认
    }
    inst = m.inst;
    lastHeard = Date.now();
    if (m.type !== 'alive') fn(m);
  }, true);
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
