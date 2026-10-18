import type { Draft } from 'immer';
import JSZip from 'jszip';
import { getUI, getWorld, reachableWorlds, replaceWorld, setUI, toast, update, worldContext, type Selection } from './store';
import { pcWithin } from './perception';
import type { Flow, GameMap, LogEntry, MapObject, MediaAttach, Tier, World } from './types';
import { NODE_H, NODE_W } from './flow';
export { NODE_H, NODE_W, reachable } from './flow';
import { CONN_LABEL } from './types';
import { TIER_LABEL } from './types';
import { download, uid } from './util';
import { contentKey, getRaw, listStored, mediaChanged, putBlobs, storageKey } from './media';
import { checkWorld, repairWorld } from './schema.js';
import { allSlots, dropSlot, loadSlot, saveSlot } from './persist';
import { send } from './sync';
import { emptyLayer, migrateWorld } from './memory';

export const findMap = (w: World | Draft<World>, id: string) => w.maps.find((m) => m.id === id);
export const findObj = (w: World | Draft<World>, mapId: string, id: string) =>
  findMap(w, mapId)?.objects.find((o) => o.id === id);

export function log(d: Draft<World>, kind: LogEntry['kind'], text: string, mapId?: string) {
  d.log.push({ id: uid(), at: Date.now(), session: d.session, kind, text, mapId });
}

/** 把队伍里所有人的途径标签收集起来，用来判断哪些预测线生效。 */
export function partyTags(w: World) {
  const s = new Set<string>();
  w.party.forEach((p) => p.tags.forEach((t) => s.add(t)));
  return s;
}

// ---------- 物件状态 ----------

export function setObjectState(mapId: string, objId: string, idx: number) {
  update((d) => {
    const o = findObj(d, mapId, objId);
    if (!o || o.state === idx) return;
    const from = o.states[o.state];
    o.state = idx;
    log(d, 'state', `${o.name}：${from} → ${o.states[idx]}`, mapId);
  });
}

// ---------- 检定揭示 ----------

/** 能不能揭示：要有玩家角色在范围内、而且看得见（私密的话，得是收信的那个人）。不能就返回原因。 */
export function revealBlocked(w: World, mapId: string, o: MapObject, range: number, scope: 'party' | 'private', to?: string): string | null {
  const m = findMap(w, mapId);
  if (!m) return '找不到地图';
  if (scope === 'private') {
    if (!to) return '还没选私密给谁';
    const pc = w.party.find((p) => p.name === to);
    if (!pc) return `队伍里没有「${to}」`;
    const mine = { ...m, tokens: m.tokens.filter((t) => t.pcId === pc.id) };
    if (!mine.tokens.length) return `${to}不在这张图上`;
    return pcWithin(w, mine, o, range) ? null : `${to}不在 ${range} 格以内，或者隔着墙看不见`;
  }
  if (!m.tokens.some((t) => t.pcId)) return '这张图上没有玩家角色';
  return pcWithin(w, m, o, range) ? null : `没有玩家角色在 ${range} 格以内、而且看得见`;
}

/** 揭示一条线索。范围和视线不满足时要主持人明确确认（主持人兜底：比如玩家用了别的办法知道了）。 */
export function revealSecret(mapId: string, objId: string, secretId: string, tier: Tier, scope: 'party' | 'private', to?: string) {
  const o = findObj(getWorld(), mapId, objId);
  const s = o?.secrets.find((x) => x.id === secretId);
  if (!o || !s) return;
  const why = revealBlocked(getWorld(), mapId, o, s.range, scope, to);
  if (why && (scope === 'private' && !to)) return toast(why);
  if (why && !confirm(`${why}。\n\n主持人仍然要揭示「${s.label}」吗？（会在记录里注明是主持人决定的）`)) return;
  update((d) => {
    const ds = findObj(d, mapId, objId)!.secrets.find((x) => x.id === secretId)!;
    ds.revealed = { tier, scope, to, at: Date.now() };
    const how = s.kind === 'auto' ? '浮现' : `${s.check}${TIER_LABEL[tier]}`;
    log(d, 'reveal', `${o.name}·${s.label}（${how}${scope === 'private' ? `，私密给 ${to || '?'}` : '，全队'}${why ? `，主持人决定：${why}` : ''}）：${s.tiers[tier]}`, mapId);
  });
  if (scope === 'private') setUI({ privateNote: { to: to || '', title: `${o.name}·${s.label}　${s.check}${TIER_LABEL[tier]}`, text: s.tiers[tier] } });
}

export function hideSecret(mapId: string, objId: string, secretId: string) {
  update((d) => {
    const s = findObj(d, mapId, objId)?.secrets.find((x) => x.id === secretId);
    if (s) delete s.revealed;
  });
}

// ---------- 媒体 ----------

let playSeq = 0; // 每次播放 / 停止都加一：读文件是异步的，读完时如果已经停了、换了别的、或者试玩开始 / 结束了，就不再发

export function playMedia(mediaId: string, label: string, broadcast: boolean) {
  const meta = getWorld().media.find((m) => m.id === mediaId);
  if (!meta) return toast('找不到这个媒体文件');
  const seq = ++playSeq;
  const key = storageKey(mediaId); // 按开始播放那一刻的版本
  const ctx = worldContext();
  setUI({ nowPlaying: { mediaId, label, broadcast } });
  // 文件本身也一起发过去：玩家窗口不一定能读到本地存储（例如双击 html 打开时）。试玩里的播放只在主持人这边，根本不发
  if (broadcast && !getUI().trial)
    getRaw(key).catch(() => undefined).then((blob) => { if (seq === playSeq && ctx === worldContext() && !getUI().trial) send({ type: 'play', mediaId: key, label, mime: meta.mime, blob: blob && blob.type !== meta.mime ? new Blob([blob], { type: meta.mime }) : blob }); }); // 玩家窗口没有媒体表，直接给存储名
  update((d) => log(d, 'media', `播放：${label || meta.name}${broadcast ? '（同步给玩家）' : '（仅主持人）'}`), { history: false });
}

/** 试玩开始 / 结束时调用：作废还在读文件的播放。 */
export function cancelPendingPlay() { playSeq++; }

export function stopMedia() {
  playSeq++;
  const np = getUI().nowPlaying;
  if (np?.broadcast) send({ type: 'stop' });
  setUI({ nowPlaying: null });
}

export function fireAttach(mapId: string, objId: string, a: MediaAttach) {
  playMedia(a.mediaId, a.label, a.broadcast);
  if (a.once) update((d) => {
    const da = findObj(d, mapId, objId)?.media.find((x) => x.id === a.id);
    if (da) da.fired = true;
  }, { history: false });
}

/** 棋子走进物件/触发区时，触发挂在上面的"进入即播放"媒体。 */
export function checkEnterTriggers(mapId: string, tokenId: string, fromX: number, fromY: number) {
  const w = getWorld();
  const m = findMap(w, mapId);
  const t = m?.tokens.find((x) => x.id === tokenId);
  if (!m || !t) return;
  const inside = (o: { x: number; y: number; w: number; h: number }, x: number, y: number) =>
    x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h;
  for (const o of m.objects) {
    if (!inside(o, t.x, t.y) || inside(o, fromX, fromY)) continue;
    const triggers = o.media.filter((a) => a.trigger === 'enter' && !(a.once && a.fired));
    if (o.kind === 'zone' || triggers.length) update((d) => log(d, 'enter', `${t.name} 进入「${o.name}」`, mapId), { history: false });
    triggers.forEach((a) => fireAttach(mapId, o.id, a));
  }
  if (getUI().mode === 'run') autoReveal(mapId);
}

/** 带团时：玩家角色走进"自动浮现"的范围（且中间没墙），信息自动出现给全队。 */
export function autoReveal(mapId: string) {
  const w = getWorld();
  const m = findMap(w, mapId);
  if (!m) return;
  for (const o of m.objects)
    for (const s of o.secrets) {
      if (s.kind !== 'auto' || s.revealed) continue;
      const pc = pcWithin(w, m, o, s.range);
      if (pc) {
        revealSecret(mapId, o.id, s.id, 'success', 'party');
        toast(`自动浮现：${o.name}·${s.label}（${pc.name} 走近了）`);
      }
    }
}

// ---------- 一格多物 ----------

export interface StackItem { sel: NonNullable<Selection>; label: string; kind: string }

/** 某一格上的所有东西：棋子 → 连接点 → 物件（高的在前）→ 触发区。 */
export function itemsAt(w: World, m: GameMap, x: number, y: number): StackItem[] {
  const out: StackItem[] = [];
  [...m.tokens].reverse().filter((t) => t.x === x && t.y === y)
    .forEach((t) => out.push({ sel: { type: 'token', mapId: m.id, id: t.id }, label: t.name, kind: '棋子' }));
  w.connections.filter((c) => [c.a, c.b].some((p) => p.mapId === m.id && p.x === x && p.y === y))
    .forEach((c) => out.push({ sel: { type: 'conn', id: c.id }, label: c.label || CONN_LABEL[c.kind], kind: '连接点' }));
  const hits = m.objects.filter((o) => x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h);
  hits.filter((o) => o.kind === 'object').sort((a, b) => b.height - a.height)
    .forEach((o) => out.push({ sel: { type: 'object', mapId: m.id, id: o.id }, label: (o.icon ? o.icon + ' ' : '') + o.name, kind: `物件 ${o.height}m` }));
  hits.filter((o) => o.kind === 'zone')
    .forEach((o) => out.push({ sel: { type: 'object', mapId: m.id, id: o.id }, label: o.name, kind: '触发区' }));
  return out;
}

export function sameSel(a: Selection, b: Selection) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'cell' || b.type === 'cell') return false;
  return (a as { id: string }).id === (b as { id: string }).id;
}

// ---------- 预测 / 记录 ----------

const findFlow = (w: World | Draft<World>, id: string) => w.flows.find((f) => f.id === id);

/**
 * 改物件的状态列表（检查器里一行一个）。流程图里的事件按序号引用状态，所以要把引用一起迁过去：
 * 先按文字对（删了一行、调了顺序都对得上），剩下的在行数没变时按位置对（改了某一行的字）。
 * 引用的那个状态被删掉了：引用改成第一个状态，并提示一下。
 */
export function setObjectStates(mapId: string, objId: string, states: string[]) {
  let lost: string[] = [];
  update((d) => {
    const o = findObj(d, mapId, objId);
    if (!o) return;
    const before = [...o.states];
    const map = new Map<number, number>();
    const used = new Set<number>();
    before.forEach((s, i) => {
      const j = states.findIndex((t, k) => t === s && !used.has(k));
      if (j >= 0 && before.filter((x) => x === s).length === 1) { map.set(i, j); used.add(j); }
    });
    if (states.length === before.length) before.forEach((_, i) => { if (!map.has(i) && !used.has(i)) { map.set(i, i); used.add(i); } });
    const to = (i: number) => map.get(i) ?? -1;
    o.states = states.length ? states : [''];
    // 当前状态只是换了序号（还是同一个状态）：不算"状态被改过"，流程图里记的版本跟着走
    const rev0 = o.stateRev ?? 0, cur = to(o.state);
    const renumbered = cur >= 0 && cur !== o.state;
    o.state = Math.max(0, cur);
    if (renumbered) o.stateRev = rev0 + 1;
    for (const f of d.flows) for (const n of f.nodes) {
      if (renumbered && n.applied && n.applied.mapId === mapId && n.applied.objectId === objId && n.applied.rev === rev0) n.applied.rev = rev0 + 1;
      if (n.effect && n.effect.mapId === mapId && n.effect.objectId === objId) {
        const j = to(n.effect.toState);
        if (j < 0) lost.push(n.title);
        n.effect.toState = Math.max(0, j);
      }
      if (n.applied && n.applied.mapId === mapId && n.applied.objectId === objId) {
        const a = to(n.applied.from), b = to(n.applied.to);
        if (a < 0 || b < 0) delete n.applied; else n.applied = { ...n.applied, from: a, to: b };
      }
    }
  }, { coalesce: 'states' + objId });
  lost = [...new Set(lost)];
  if (lost.length) toast(`这些事件引用的状态被删掉了，已改成第一个状态：${lost.join('、')}`);
}

/** 一个事件可能是从哪几条连线过来的：起点已经发生了的连线，条件满足的排前面，同样满足的按起点发生的时间从近到远。 */
export function incomingCandidates(f: Flow | Draft<Flow>, nodeId: string, tags: Set<string>) {
  const byId = new Map(f.nodes.map((n) => [n.id, n]));
  return f.edges
    .filter((e) => e.to === nodeId && e.from !== nodeId && byId.get(e.from)?.status === 'happened')
    .map((e) => ({ e, ok: !e.condition || tags.has(e.condition), at: byId.get(e.from)!.at ?? 0 }))
    .sort((a, b) => Number(b.ok) - Number(a.ok) || b.at - a.at)
    .map((x) => x.e);
}

/**
 * 标记一个事件发生了（描成实线），并执行它绑定的物件变化；撤销时把这次改的物件改回去。
 * via：从哪条连线过来的；不给就按 incomingCandidates 选第一条（主持人可以在侧栏改）。
 */
export function setNodeStatus(flowId: string, nodeId: string, status: 'predicted' | 'happened', via?: string) {
  update((d) => {
    const f = findFlow(d, flowId);
    const n = f?.nodes.find((x) => x.id === nodeId);
    if (!f || !n || n.status === status) return;
    n.status = status;
    n.at = Date.now();
    n.session = d.session;
    if (status === 'happened') {
      log(d, 'step', `［${f.name}］${n.title}`);
      // 自动只选条件满足的；只有锁着的连线可选时不替主持人决定（侧栏可以手动指定，算破例）
      const tags = partyTags(d as World);
      n.via = via ?? incomingCandidates(f, n.id, tags).find((e) => !e.condition || tags.has(e.condition))?.id ?? ''; // '' = 明确没有合法来路（区别于旧存档的"没记"）
      const e = n.effect;
      const o = e && findObj(d, e.mapId, e.objectId);
      if (e && o && o.state !== e.toState && o.states[e.toState] !== undefined) {
        n.applied = { mapId: e.mapId, objectId: e.objectId, from: o.state, to: e.toState, rev: (o.stateRev ?? 0) + 1 }; // 这次改完后 stateRev 会加一
        log(d, 'state', `${o.name}：${o.states[o.state]} → ${o.states[e.toState]}`, e.mapId);
        o.state = e.toState;
      }
    } else {
      log(d, 'step', `［${f.name}］撤销：${n.title}`);
      const a = n.applied;
      const o = a && findObj(d, a.mapId, a.objectId);
      if (a && o) {
        // 之后没人动过（版本还是这次改完的那个）才改回去；只比状态值的话，"关了又开"会被误认成没动过
        // 旧存档的记录没有版本：证明不了之后没人动过，就不自动改回（写进记录，主持人自己判断）
        const untouched = a.rev !== undefined && (o.stateRev ?? 0) === a.rev;
        if (untouched && o.state === a.to && o.states[a.from] !== undefined) {
          o.state = a.from;
          log(d, 'state', `${o.name}：${o.states[a.to]} → ${o.states[a.from]}（撤销「${n.title}」）`, a.mapId);
        } else log(d, 'note', `撤销「${n.title}」：${o.name}${a.rev === undefined ? '是旧版记录，确认不了之后有没有被改过' : '后来又被改过'}（现在是${o.states[o.state]}），没有改回去`, a.mapId);
      }
      delete n.applied;
      delete n.via;
    }
  });
}

/** 主持人改"实际从哪条连线过来的"。 */
export function setNodeVia(flowId: string, nodeId: string, via: string) {
  update((d) => { const n = findFlow(d, flowId)?.nodes.find((x) => x.id === nodeId); if (n) n.via = via; });
}

/** 从某个事件接出一个新事件（预测时是虚线；带团时是"意外分支"，直接算发生了）。 */
export function addChildNode(flowId: string, fromId: string | null, record: boolean, pos?: { x: number; y: number }) {
  const id = uid();
  update((d) => {
    const f = findFlow(d, flowId);
    if (!f) return;
    const from = fromId ? f.nodes.find((n) => n.id === fromId) : null;
    const siblings = from ? f.edges.filter((e) => e.from === from.id).length : 0;
    f.nodes.push({
      id, title: record ? '意外分支' : '新事件',
      x: pos?.x ?? (from ? from.x + siblings * (NODE_W + 30) : 40),
      y: pos?.y ?? (from ? from.y + NODE_H + 60 : 40),
      kind: 'event', effect: null, origin: record ? 'record' : 'predicted',
      status: record ? 'happened' : 'predicted', at: record ? Date.now() : undefined, session: record ? d.session : undefined,
    });
    if (from) f.edges.push({ id: uid(), from: from.id, to: id, label: '', condition: '', chance: null });
    if (record) log(d, 'step', `［${f.name}］意外分支（接在「${from?.title ?? '开头'}」后面）`);
  });
  return id;
}

/** 自动排列：从开场往下分层（像底特律的流程图那样从上往下长）。 */
export function autoLayout(flowId: string) {
  update((d) => {
    const f = findFlow(d, flowId);
    if (!f) return;
    const incoming = new Set(f.edges.map((e) => e.to));
    const depth = new Map<string, number>();
    const roots = f.nodes.filter((n) => n.kind === 'start' || !incoming.has(n.id));
    roots.forEach((n) => depth.set(n.id, 0));
    // 最长路径分层（有环时最多迭代 n 次）
    for (let it = 0; it < f.nodes.length; it++) {
      let changed = false;
      for (const e of f.edges) {
        const dv = depth.get(e.from);
        if (dv === undefined || dv + 1 > f.nodes.length) continue;
        if ((depth.get(e.to) ?? -1) < dv + 1) { depth.set(e.to, dv + 1); changed = true; }
      }
      if (!changed) break;
    }
    const rows = new Map<number, typeof f.nodes>();
    f.nodes.forEach((n) => { const k = depth.get(n.id) ?? 0; rows.set(k, [...(rows.get(k) ?? []), n]); });
    const widest = Math.max(...[...rows.values()].map((r) => r.length));
    rows.forEach((row, k) => {
      row.sort((a, b) => a.x - b.x);
      const offset = ((widest - row.length) * (NODE_W + 30)) / 2;
      row.forEach((n, i) => { n.x = 40 + offset + i * (NODE_W + 30); n.y = 40 + k * (NODE_H + 60); });
    });
  });
}

// ---------- 地图 ----------

/**
 * 改画布：左上右下各加（负数就是减）几格。内容整体平移，物件、棋子、房间、连接点、迷雾和记忆都跟着走。
 * 传多张图就一起改，楼层之间保持对齐。
 */
export function reshapeMaps(mapIds: string[], left: number, top: number, right: number, bottom: number) {
  // 先整批检查：四个数都得是整数，每张图改完都得在 2–200 格之间；有一张不行就整批不改（楼层之间要保持对齐）
  if (![left, top, right, bottom].every(Number.isInteger)) return toast('扩展的格数要是整数');
  const w0 = getWorld();
  const maps = mapIds.map((id) => findMap(w0, id)).filter((m): m is GameMap => !!m);
  const bad = maps.filter((m) => { const W = m.width + left + right, H = m.height + top + bottom; return W < 2 || H < 2 || W > 200 || H > 200; });
  if (bad.length) return toast(`改不了：${bad.map((m) => `「${m.name}」`).join('')}改完会小于 2 格或大于 200 格，整批都没改`);
  if (!maps.length || (left === 0 && top === 0 && right === 0 && bottom === 0)) return;
  const ids = new Set(maps.map((m) => m.id));
  let droppedConns: string[] = [];
  update((d) => {
    for (const id of ids) {
      const m = findMap(d, id)!;
      const W = m.width + left + right, H = m.height + top + bottom;
      const remap = <T,>(arr: T[], fill: T) => {
        const out: T[] = [];
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            const sx = x - left, sy = y - top;
            out.push(sx >= 0 && sy >= 0 && sx < m.width && sy < m.height ? arr[sy * m.width + sx] : fill);
          }
        return out;
      };
      m.cells = remap(m.cells, '');
      m.d100 = remap(m.d100, 0);
      m.roomCells = remap(m.roomCells, '');
      m.fog = remap(m.fog, 0);
      m.seen.cells = remap(m.seen.cells, '');
      const inside = (r: { x: number; y: number; w?: number; h?: number }) => r.x >= 0 && r.y >= 0 && r.x + (r.w ?? 1) <= W && r.y + (r.h ?? 1) <= H;
      for (const L of Object.values(m.views)) {
        L.fog = remap(L.fog, 0);
        L.seen.cells = remap(L.seen.cells, '');
        for (const o of L.seen.objects) { o.x += left; o.y += top; }
        L.seen.objects = L.seen.objects.filter(inside);
      }
      if (m.spawn) { m.spawn = { x: m.spawn.x + left, y: m.spawn.y + top }; if (!inside(m.spawn)) m.spawn = null; } // 出生点被裁掉了：回到"自动"
      for (const o of [...m.objects, ...m.tokens, ...m.seen.objects]) { o.x += left; o.y += top; }
      m.objects = m.objects.filter(inside);
      m.tokens = m.tokens.filter(inside);
      m.seen.objects = m.seen.objects.filter(inside);
      m.width = W;
      m.height = H;
    }
    for (const c of d.connections)
      for (const e of [c.a, c.b]) if (ids.has(e.mapId)) { e.x += left; e.y += top; }
    const fits = (mapId: string, x: number, y: number) => { const m = findMap(d, mapId); return !!m && x >= 0 && y >= 0 && x < m.width && y < m.height; };
    // 端点被裁到图外的连接点没法再用了：删掉，并提示
    const cut = d.connections.filter((c) => [c.a, c.b].some((e) => ids.has(e.mapId) && !fits(e.mapId, e.x, e.y)));
    if (cut.length) { d.connections = d.connections.filter((c) => !cut.includes(c)); droppedConns = cut.map((c) => c.label || CONN_LABEL[c.kind]); }
    for (const n of d.npcs ?? [])
      if (n.place && ids.has(n.place.mapId)) {
        n.place.x += left; n.place.y += top;
        if (!fits(n.place.mapId, n.place.x, n.place.y)) n.place = null;
      }
    for (const k of d.marks) if (ids.has(k.mapId)) { k.x += left; k.y += top; }
    d.marks = d.marks.filter((k) => !ids.has(k.mapId) || fits(k.mapId, k.x, k.y));
  });
  setUI((s) => { const v = { ...s.views }; ids.forEach((i) => delete v[i]); return { views: v, selection: null }; });
  if (droppedConns.length) toast(`这些连接点被裁到图外，已删除（可以撤销）：${droppedConns.join('、')}`);
}

export function resizeMap(mapId: string, w: number, h: number) {
  const m = findMap(getWorld(), mapId);
  if (m && Number.isFinite(w) && Number.isFinite(h)) reshapeMaps([mapId], 0, 0, Math.round(w) - m.width, Math.round(h) - m.height);
}

/** 把一张图上所有空白格铺成某种地形（例如建筑外圈的空地）。 */
export function fillEmptyCells(mapId: string, terrainId: string) {
  update((d) => {
    const m = findMap(d, mapId);
    if (m) m.cells = m.cells.map((c) => c || terrainId);
  });
}

export function duplicateMap(mapId: string, layer?: string) {
  const src = findMap(getWorld(), mapId);
  if (!src) return;
  const copy: GameMap = structuredClone(src);
  copy.id = uid();
  copy.variantOf = src.id;
  copy.objects = copy.objects.map((o) => ({ ...o, id: uid() }));
  copy.tokens = [];
  copy.fog = copy.fog.map(() => 0);
  copy.seen = { cells: copy.cells.map(() => ''), objects: [] };
  copy.views = {}; // 每个人的旧记忆也不能带过去（物件已经换了 ID）
  if (layer) copy.layer = layer;
  else copy.name = src.name + '（副本）';
  update((d) => { d.maps.push(copy); });
  setUI({ mapId: copy.id, selection: null });
}

export function deleteMap(mapId: string) {
  const w = getWorld();
  if (w.maps.length <= 1) return toast('至少要留一张地图');
  update((d) => {
    d.maps = d.maps.filter((m) => m.id !== mapId);
    d.connections = d.connections.filter((c) => c.a.mapId !== mapId && c.b.mapId !== mapId);
    if (d.playerMapId === mapId) d.playerMapId = null;
  });
  setUI({ mapId: getWorld().maps[0].id, selection: null });
}

/** 切到另一张图并把视图对准某一格（画布拿到尺寸后执行对准）。 */
export function jumpTo(mapId: string, x: number, y: number) {
  pendingFocus = { mapId, x, y };
  setUI({ mapId, selection: { type: 'cell', mapId, x, y } });
}
export let pendingFocus: { mapId: string; x: number; y: number } | null = null;
export const clearPendingFocus = () => { pendingFocus = null; };

// ---------- 导入 / 导出 ----------
//
// 媒体文件写进浏览器后永远不改（见 media.ts）：导入只"添"新文件，不覆盖任何已有的。
// 所以世界和它引用的文件天然对得上：导入中途失败、恢复、两个标签页开着不同版本，都不会出现"世界是 A、媒体是 B"。
// 导入、恢复、保存、导出一次只做一件（同一个标签页里），导入期间也不能开始试玩。

let busy: string | null = null;
/** 正在导入 / 恢复 / 保存吗（试玩按钮看这个）。 */
export const ioBusy = () => busy;

/** 新建空白世界 / 载入示例：也要等导入、保存做完（否则做完的导入会把新世界换掉）。 */
export function startFreshWorld(w: World, what: string) {
  if (busy) return toast(`正在${busy}，完成后再${what}`);
  if (getUI().trial) return toast(`试玩中不能${what}，先结束试玩`);
  if (!confirm(`${what}？当前内容请先导出。`)) return;
  cancelPendingPlay(); stopMedia();
  replaceWorld(w);
  setUI({ mapId: w.maps[0].id, selection: null, views: {}, flowId: w.flows[0]?.id ?? null });
}
async function exclusive<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (busy) { toast(`正在${busy}，请稍等`); return undefined; }
  busy = what;
  try { return await fn(); } finally { busy = null; }
}

class MissingMedia extends Error {}

/**
 * 打包工程。先过一遍和导入一样的校验（存出去的东西一定能再导进来）；缺了哪个媒体文件就列出来（不再悄悄跳过）。
 * 世界在开始时就固定下来，媒体按那一刻的存储名去读（文件不会被改，所以读到的一定是那个版本）。
 */
async function buildProjectZip(allowMissing = false) {
  const w = getWorld();
  checkWorld(w);
  const zip = new JSZip();
  zip.file('world.json', JSON.stringify(w, null, 2));
  const missing: string[] = [];
  for (const m of w.media) {
    const b = await readRaw(m.key ?? m.id);
    if (b) zip.file(`media/${m.id}`, b);
    else missing.push(m.name);
  }
  if (missing.length && !allowMissing) throw new MissingMedia(`这几个媒体文件在浏览器里找不到：${missing.join('、')}`);
  return zip.generateAsync({ type: 'blob' });
}

export async function exportProject() {
  if (getUI().trial) return toast('试玩中不能导出，先结束试玩');
  const name = `${getWorld().name || '世界'}.tsmap.zip`;
  await exclusive('导出', async () => {
    try {
      download(name, await buildProjectZip());
    } catch (e) {
      if (!(e instanceof MissingMedia)) return toast('导出失败：' + (e as Error).message);
      if (confirm(`${e.message}\n\n还要导出吗？（导出的工程里会缺这些文件）`)) {
        try { download(name, await buildProjectZip(true)); } catch (e2) { toast('导出失败：' + (e2 as Error).message); }
      }
    }
  });
}

/** 用命令行带文件启动时才有：存回硬盘（见 scripts/open.mjs）。 */
export async function checkDiskTarget() {
  try {
    const r = await fetch('/__save-target');
    if (r.ok) { const j = await r.json(); saveToken = j.token ?? ''; setUI({ diskTarget: j.path as string }); }
  } catch { /* 不是用启动器开的 */ }
}

let saveToken = '';

export async function saveToDisk() {
  if (getUI().trial) return toast('试玩中不能保存（试玩的改动不该进正式工程），先结束试玩');
  if (!getUI().diskTarget) return exportProject();
  await exclusive('保存', async () => {
    try {
      const r = await fetch('/__save', { method: 'POST', headers: { 'X-Save-Token': saveToken }, body: await buildProjectZip() });
      if (!r.ok) throw new Error(await r.text());
      const { path } = await r.json();
      setUI({ diskTarget: path });
      toast(`已保存到 ${path}`);
    } catch (e) {
      toast('保存失败：' + (e as Error).message);
    }
  });
}

/** 导入前的校验：任何写入（媒体、世界）之前先过这一关（和命令行共用 schema.js）。 */
function parseWorld(text: string): World {
  let w: unknown;
  try { w = JSON.parse(text); } catch { throw new Error('world.json 不是有效的 JSON'); }
  repairWorld(w); // 旧版允许过的超范围数值先夹回来
  checkWorld(w);
  migrateWorld(w);
  checkWorld(w, true); // 补完旧字段以后再严格查一遍，确保交给编辑器的是完整的工程
  return w;
}

/** 读一个媒体文件。读出错就报错（不当作"没有"）。 */
async function readRaw(key: string): Promise<Blob | undefined> {
  try { return await getRaw(key); } catch (e) { throw new Error(`读不了浏览器里的媒体文件（${(e as Error)?.message ?? e}）`); }
}

// ---------- 导入前备份 ----------
// 备份就是导入前的那份世界。它引用的媒体文件都还在（文件从不覆盖），所以恢复只换世界。
// 旧版备份另外记着"被覆盖的媒体"（swapped），那时文件会被覆盖；恢复这种旧备份时照旧版的办法换一次文件。

const OLD_BACKUP_MEDIA_KEY = 'ts-map-media-backup'; // 更旧的版本把"被覆盖的媒体"清单单独存
const BACKUP_MEDIA_PREFIX = '__backup__/';
interface Backup { world: World; swapped?: string[] }

/** 读这个标签页的备份（persist.ts 按标签页分槽；旧版的单份备份也认）。 */
function readBackup(): Backup | null {
  try {
    const s = loadSlot('backup');
    if (!s) return null;
    const j = JSON.parse(s);
    if (j && Array.isArray(j.maps)) { // 最旧的格式：直接是世界
      let swapped: string[] = [];
      try { swapped = JSON.parse(localStorage.getItem(OLD_BACKUP_MEDIA_KEY) ?? '[]'); } catch { /* 没有 */ }
      return { world: j, swapped };
    }
    return j && j.world ? { world: j.world, swapped: Array.isArray(j.swapped) ? j.swapped : [] } : null;
  } catch { return null; }
}
/** 写备份；写不下（太大）返回 false，这时原来那条备份不受影响。 */
function writeBackup(world: World): boolean {
  if (!saveSlot('backup', JSON.stringify({ world }))) return false;
  try { localStorage.removeItem(OLD_BACKUP_MEDIA_KEY); } catch { /* 留着也无妨 */ }
  return true;
}
function dropBackup() {
  dropSlot('backup');
  try { localStorage.removeItem(OLD_BACKUP_MEDIA_KEY); } catch { /* 无能为力 */ }
}
export function hasBackup() {
  return !!loadSlot('backup');
}

/**
 * 清理浏览器里用不到的媒体文件：文件从不覆盖，旧版本会越攒越多。
 * 只要还有任何地方可能用到就不删：这个标签页现在的世界和撤销记录、所有标签页的自动保存和导入前的备份、旧版备份里换下来的文件。
 */
export async function cleanupMedia() {
  if (getUI().trial) return toast('试玩中不能清理，先结束试玩');
  await exclusive('清理媒体文件', async () => {
    try {
      const keep = new Set<string>();
      const add = (w: unknown) => {
        const media = (w as World | null)?.media;
        if (Array.isArray(media)) for (const m of media) { if (m?.id) keep.add(m.id); if (m?.key) keep.add(m.key); }
      };
      reachableWorlds().forEach(add);
      for (const text of allSlots()) {
        try {
          const j = JSON.parse(text);
          if (Array.isArray(j?.maps)) add(j);
          else { add(j?.world); for (const id of Array.isArray(j?.swapped) ? j.swapped : []) keep.add(BACKUP_MEDIA_PREFIX + id); }
        } catch { /* 坏的存档不管 */ }
      }
      try { for (const id of JSON.parse(localStorage.getItem(OLD_BACKUP_MEDIA_KEY) ?? '[]')) keep.add(BACKUP_MEDIA_PREFIX + id); } catch { /* 没有 */ }
      const junk = (await listStored()).filter((f) => !keep.has(f.key));
      if (!junk.length) return toast('没有用不到的文件');
      const mb = (junk.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1);
      if (!confirm(`浏览器里有 ${junk.length} 个文件（共 ${mb} MB）没有任何工程、自动保存、备份或撤销记录用到。删除吗？\n\n（如果别的标签页还开着编辑器、并且打算撤销回很早以前删掉的媒体，那份媒体会找不到。导出过的工程包里都有自己的文件，不受影响。）`)) return;
      await putBlobs(junk.map((f) => ({ id: f.key, blob: null })));
      mediaChanged();
      toast(`清理了 ${junk.length} 个文件，腾出 ${mb} MB`);
    } catch (e) {
      toast('清理失败：' + (e as Error).message);
    }
  });
}

/** 把一批新文件存进浏览器（只添不改），给世界里的媒体写上存储名。 */
async function storeMedia(w: World, files: { id: string; blob: Blob }[]) {
  const keys = new Map<string, string>();
  const ops: { id: string; blob: Blob }[] = [];
  for (const f of files) {
    const key = await contentKey(f.blob);
    keys.set(f.id, key);
    if (!(await readRaw(key)) && !ops.some((o) => o.id === key)) ops.push({ id: key, blob: f.blob });
  }
  await putBlobs(ops); // 一个事务：要么全写上，要么一个不写；写上的也只是新文件，不影响任何正在用的
  if (ops.length) mediaChanged(); // 原来缺的文件现在有了：正在等它的预览重新读
  for (const m of w.media) { const k = keys.get(m.id); if (k) m.key = k; }
}

/**
 * 导入的最后一步，所有导入方式（工程、JSON、Rabbithole、恢复备份）共用：
 * 存新文件 → 把现在的世界写成备份（写不下就问一句，取消的话什么都不变）→ 换世界。
 * 导入期间不能进试玩；万一进了，就不换世界（试玩结束时会还原成进试玩前的世界，换了也白换）。
 */
async function commitImport(w: World, files: { id: string; blob: Blob }[], ctx = worldContext()): Promise<boolean> {
  await storeMedia(w, files);
  if (getUI().trial) throw new Error('导入途中开始了试玩，没有替换世界。请结束试玩后重新导入');
  if (ctx !== worldContext()) throw new Error('导入途中换了工程，没有替换世界');
  if (!writeBackup(getWorld())) {
    if (!confirm('当前内容太大，没法留"导入前的备份"。继续导入的话，之后就不能一键恢复了。继续吗？')) return false;
    dropBackup(); // 继续的话，旧备份已经不是"这次导入前"的内容了，不能留着误导
  }
  cancelPendingPlay(); stopMedia(); // 旧世界正在放的、还没发出去的，都停掉
  replaceWorld(w);
  return true;
}

async function importProject(file: File, ctx: string) {
  try {
    let w: World;
    const files: { id: string; blob: Blob }[] = [];
    if (/\.json$/i.test(file.name)) {
      w = parseWorld(await file.text()); // 单独的 JSON 不带媒体文件：浏览器里有的照用
    } else {
      const zip = await JSZip.loadAsync(file);
      const json = zip.file('world.json');
      if (!json) throw new Error('压缩包里没有 world.json');
      w = parseWorld(await json.async('string'));
      for (const m of w.media) {
        const f = zip.file(`media/${m.id}`);
        if (f) files.push({ id: m.id, blob: new Blob([await f.async('arraybuffer')], { type: m.mime }) });
      }
    }
    // 缺哪些文件，提交之前就算好（提交以后只做不会失败的事）
    const have = new Set(files.map((f) => f.id));
    const missing: string[] = [];
    for (const m of w.media) if (!have.has(m.id) && !(await readRaw(m.key ?? m.id))) missing.push(m.name);
    if (!(await commitImport(w, files, ctx))) return;
    setUI({ mapId: w.maps[0].id, selection: null, views: {}, flowId: w.flows[0]?.id ?? null });
    toast(`已导入：${w.name}${missing.length ? `（缺 ${missing.length} 个媒体文件：${missing.join('、')}）` : ''}`);
  } catch (e) {
    toast('导入失败：' + (e as Error).message);
  }
}

export function exportSessionMarkdown() {
  const w = getWorld();
  const s = w.session;
  const out: string[] = [`# ${w.name} · 第 ${s} 场记录`, ''];
  out.push('## 走过的事件', '');
  for (const f of w.flows) {
    const hit = f.nodes.filter((n) => n.session === s && n.status === 'happened').sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    if (!hit.length) continue;
    out.push(`### ${f.name}`);
    hit.forEach((n) => out.push(`- ${n.title}${n.origin === 'record' ? '（意外分支）' : ''}`));
    out.push('');
  }
  out.push('## 时间线', '');
  const d = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  w.log.filter((e) => e.session === s).forEach((e) => out.push(`- ${d(e.at)} ${e.text}`));
  download(`${w.name}-第${s}场记录.md`, out.join('\n'), 'text/markdown');
}

async function importRabbitholeFile(file: File, ctx: string) {
  try {
    const { importRabbithole } = await import('./importRabbithole');
    const { world, blobs, summary } = await importRabbithole(file);
    checkWorld(world, true);
    if (!(await commitImport(world, blobs, ctx))) return;
    setUI({ mapId: world.maps[0].id, selection: null, views: {}, flowId: world.flows[0]?.id ?? null, mode: 'edit', tool: 'select' });
    toast(summary);
  } catch (e) {
    toast('Rabbithole 导入失败：' + (e as Error).message);
  }
}

/** 换回上一次导入前的内容。现在的内容又成了备份，所以可以来回切换。 */
export async function restoreBackup() {
  if (getUI().trial) return toast('试玩中不能恢复，先结束试玩');
  await exclusive('恢复', async () => {
    const ctx = worldContext();
    try {
      const b = readBackup();
      if (!b) return;
      const w = parseWorld(JSON.stringify(b.world));
      if (b.swapped?.length) {
        // 旧版备份：那时导入会覆盖同 ID 的文件，旧文件存在 __backup__/ 里。把它们存成新文件（不再覆盖），世界改为引用新文件
        const files: { id: string; blob: Blob }[] = [];
        const lost: string[] = [];
        for (const id of b.swapped) {
          const bak = await readRaw(BACKUP_MEDIA_PREFIX + id);
          if (bak) files.push({ id, blob: bak }); else lost.push(w.media.find((m) => m.id === id)?.name ?? id);
        }
        if (lost.length) throw new Error(`备份里的这些媒体文件找不到了：${lost.join('、')}。没有恢复，现在的内容不变`);
        await storeMedia(w, files);
      } else {
        // 新版备份：引用的文件都还在，检查一下
        const lost: string[] = [];
        for (const m of w.media) if (!(await readRaw(m.key ?? m.id))) lost.push(m.name);
        if (lost.length && !confirm(`备份里的这些媒体文件在浏览器里找不到：${lost.join('、')}。仍然恢复吗？`)) return;
      }
      if (!(await commitImport(w, [], ctx))) return;
      setUI({ mapId: w.maps[0].id, selection: null, views: {}, flowId: w.flows[0]?.id ?? null });
      toast(`已恢复：${w.name}`);
    } catch (e) {
      toast('恢复失败：' + (e as Error).message);
    }
  });
}

/** 自动认出文件类型：本编辑器的工程，或 Rabbithole 的地图。 */
export async function importAnyFile(file: File) {
  if (getUI().trial) return toast('试玩中不能导入，先结束试玩');
  await exclusive('导入', async () => { // 从读文件的第一步就占住：这期间不能试玩、保存、再导入
    const ctx = worldContext();
    let rabbithole = false;
    try {
      if (/\.json$/i.test(file.name)) {
        const j = JSON.parse(await file.text());
        rabbithole = Array.isArray(j.levels) && !Array.isArray(j.maps);
      } else {
        const zip = await JSZip.loadAsync(file);
        rabbithole = !zip.file('world.json') && !!zip.file('map.json');
      }
    } catch (e) {
      return toast('读不了这个文件：' + (e as Error).message);
    }
    await (rabbithole ? importRabbitholeFile(file, ctx) : importProject(file, ctx));
  });
}

/** 用命令行带文件启动时（npm start -- 文件），打开页面就自动导入。 */
export async function autoLoadFromLauncher() {
  const name = new URLSearchParams(location.search).get('load');
  if (!name) return;
  history.replaceState(null, '', location.pathname); // 刷新页面时不再重复导入
  try {
    const res = await fetch('/__load');
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || `启动器没有提供文件（${res.status}）`);
    await importAnyFile(new File([await res.blob()], name));
  } catch (e) {
    toast('自动导入失败：' + (e as Error).message);
  }
}

// ---------- 视野：共享 / 各自独立；拿到地图；标记 ----------

export const MARK_LIFE = 20; // 标记默认能留多少分钟（战斗里 = 4 回合）。依据：遗忘曲线在头 20 分钟掉得最快

/** 切到"各自独立"时，每个人从全队已知的那份开始（之前一起看到的大家都知道）。 */
export function setVisionMode(mode: World['visionMode']) {
  update((d) => {
    if (d.visionMode === mode) return;
    d.visionMode = mode;
    if (mode === 'individual')
      for (const m of d.maps) {
        m.views = {};
        for (const p of d.party) m.views[p.id] = { fog: [...m.fog], seen: { cells: [...m.seen.cells], objects: m.seen.objects.map((o) => ({ ...o })) } };
      }
  });
}

/** 玩家拿到了这张图的地图：没去过的地方都变成灰色记忆，只记得地形（墙、门、房间），不记得里面有什么。 */
export function giveMapKnowledge(mapId: string, pcIds?: string[]) {
  update((d) => {
    const m = findMap(d, mapId);
    if (!m) return;
    const learn = (L: { fog: number[]; seen: { cells: string[] } }) => {
      L.fog.forEach((f, k) => { if (!f) { L.fog[k] = 2; L.seen.cells[k] = m.cells[k]; } });
    };
    if (d.visionMode === 'individual') {
      const who = pcIds ?? d.party.map((p) => p.id);
      for (const id of who) { m.views[id] ??= emptyLayer(m.width * m.height); learn(m.views[id]); }
    }
    learn(m);
    log(d, 'reveal', `玩家拿到了「${m.name}」的地图`, mapId);
  });
}

export function addMark(mapId: string, author: string, x: number, y: number, symbol: string, text: string) {
  update((d) => {
    const now = Date.now();
    d.marks = d.marks.filter((k) => now - k.createdAt < k.life * 60000); // 顺手清掉过期的
    d.marks.push({ id: uid(), mapId, x, y, author, symbol, text, createdAt: now, life: MARK_LIFE });
  });
}
