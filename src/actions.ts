import type { Draft } from 'immer';
import JSZip from 'jszip';
import { getUI, getWorld, replaceWorld, setUI, toast, update, type Selection } from './store';
import { pcWithin } from './perception';
import type { GameMap, LogEntry, MediaAttach, Tier, World } from './types';
import { NODE_H, NODE_W } from './flow';
export { NODE_H, NODE_W, reachable } from './flow';
import { CONN_LABEL } from './types';
import { TIER_LABEL } from './types';
import { download, uid } from './util';
import { getBlob, mediaChanged, putBlob } from './media';
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

export function revealSecret(mapId: string, objId: string, secretId: string, tier: Tier, scope: 'party' | 'private', to?: string) {
  const o = findObj(getWorld(), mapId, objId);
  const s = o?.secrets.find((x) => x.id === secretId);
  if (!o || !s) return;
  update((d) => {
    const ds = findObj(d, mapId, objId)!.secrets.find((x) => x.id === secretId)!;
    ds.revealed = { tier, scope, to, at: Date.now() };
    const how = s.kind === 'auto' ? '浮现' : `${s.check}${TIER_LABEL[tier]}`;
    log(d, 'reveal', `${o.name}·${s.label}（${how}${scope === 'private' ? `，私密给 ${to || '?'}` : '，全队'}）：${s.tiers[tier]}`, mapId);
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

export function playMedia(mediaId: string, label: string, broadcast: boolean) {
  const meta = getWorld().media.find((m) => m.id === mediaId);
  if (!meta) return toast('找不到这个媒体文件');
  setUI({ nowPlaying: { mediaId, label, broadcast } });
  // 文件本身也一起发过去：玩家窗口不一定能读到本地存储（例如双击 html 打开时）
  if (broadcast) getBlob(mediaId).catch(() => undefined).then((blob) => send({ type: 'play', mediaId, label, mime: meta.mime, blob }));
  update((d) => log(d, 'media', `播放：${label || meta.name}${broadcast ? '（同步给玩家）' : '（仅主持人）'}`), { history: false });
}

export function stopMedia() {
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

/** 标记一个事件发生了（描成实线），并执行它绑定的物件变化。 */
export function setNodeStatus(flowId: string, nodeId: string, status: 'predicted' | 'happened') {
  update((d) => {
    const f = findFlow(d, flowId);
    const n = f?.nodes.find((x) => x.id === nodeId);
    if (!f || !n || n.status === status) return;
    n.status = status;
    n.at = Date.now();
    n.session = d.session;
    if (status === 'happened') {
      log(d, 'step', `［${f.name}］${n.title}`);
      const e = n.effect;
      const o = e && findObj(d, e.mapId, e.objectId);
      if (e && o && o.state !== e.toState && o.states[e.toState] !== undefined) {
        const from = o.states[o.state];
        o.state = e.toState;
        log(d, 'state', `${o.name}：${from} → ${o.states[e.toState]}`, e.mapId);
      }
    } else log(d, 'step', `［${f.name}］撤销：${n.title}`);
  });
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
  const ids = new Set(mapIds);
  update((d) => {
    for (const id of ids) {
      const m = findMap(d, id);
      if (!m) continue;
      const W = Math.min(200, m.width + left + right), H = Math.min(200, m.height + top + bottom);
      if (W < 2 || H < 2) continue;
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
      for (const L of Object.values(m.views)) {
        L.fog = remap(L.fog, 0);
        L.seen.cells = remap(L.seen.cells, '');
        for (const o of L.seen.objects) { o.x += left; o.y += top; }
      }
      if (m.spawn) m.spawn = { x: m.spawn.x + left, y: m.spawn.y + top };
      const inside = (r: { x: number; y: number; w?: number; h?: number }) => r.x >= 0 && r.y >= 0 && r.x + (r.w ?? 1) <= W && r.y + (r.h ?? 1) <= H;
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
    for (const n of d.npcs ?? [])
      if (n.place && ids.has(n.place.mapId)) {
        n.place.x += left; n.place.y += top;
        if (!fits(n.place.mapId, n.place.x, n.place.y)) n.place = null;
      }
    for (const k of d.marks) if (ids.has(k.mapId)) { k.x += left; k.y += top; }
    d.marks = d.marks.filter((k) => !ids.has(k.mapId) || fits(k.mapId, k.x, k.y));
  });
  setUI((s) => { const v = { ...s.views }; ids.forEach((i) => delete v[i]); return { views: v, selection: null }; });
}

export function resizeMap(mapId: string, w: number, h: number) {
  const m = findMap(getWorld(), mapId);
  if (m) reshapeMaps([mapId], 0, 0, Math.round(w) - m.width, Math.round(h) - m.height);
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

/** 打包工程。缺了哪个媒体文件就列出来（不再悄悄跳过）。 */
async function buildProjectZip(allowMissing = false) {
  const w = getWorld();
  const zip = new JSZip();
  zip.file('world.json', JSON.stringify(w, null, 2));
  const missing: string[] = [];
  for (const m of w.media) {
    const b = await getBlob(m.id).catch(() => undefined);
    if (b) zip.file(`media/${m.id}`, b);
    else missing.push(m.name);
  }
  if (missing.length && !allowMissing) throw new Error(`这几个媒体文件在浏览器里找不到：${missing.join('、')}`);
  return zip.generateAsync({ type: 'blob' });
}

export async function exportProject() {
  if (getUI().trial) return toast('试玩中不能导出，先结束试玩');
  try {
    download(`${getWorld().name || '世界'}.tsmap.zip`, await buildProjectZip());
  } catch (e) {
    if (confirm(`${(e as Error).message}\n\n还要导出吗？（导出的工程里会缺这些文件）`))
      download(`${getWorld().name || '世界'}.tsmap.zip`, await buildProjectZip(true));
  }
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
  try {
    const r = await fetch('/__save', { method: 'POST', headers: { 'X-Save-Token': saveToken }, body: await buildProjectZip() });
    if (!r.ok) throw new Error(await r.text());
    const { path } = await r.json();
    setUI({ diskTarget: path });
    toast(`已保存到 ${path}`);
  } catch (e) {
    toast('保存失败：' + (e as Error).message);
  }
}

/** 导入前的校验：任何写入（媒体、世界）之前先过这一关。 */
function checkWorld(w: World) {
  if (!w || w.version !== 1 || !Array.isArray(w.maps) || w.maps.length === 0) throw new Error('不是这个编辑器的工程文件（或者没有地图）');
  for (const m of w.maps) {
    if (!(m.width > 0 && m.height > 0) || !Array.isArray(m.cells) || m.cells.length !== m.width * m.height)
      throw new Error(`地图「${m.name}」的尺寸和格子数对不上`);
  }
  if (!Array.isArray(w.media ?? [])) throw new Error('媒体列表坏了');
}

export async function importProject(file: File) {
  try {
    let w: World;
    let zip: JSZip | null = null;
    if (file.name.endsWith('.json')) {
      w = JSON.parse(await file.text());
    } else {
      zip = await JSZip.loadAsync(file);
      const json = zip.file('world.json');
      if (!json) throw new Error('压缩包里没有 world.json');
      w = JSON.parse(await json.async('string'));
    }
    checkWorld(w);
    migrateWorld(w);
    if (zip) {  // 校验通过才写媒体；同 ID 但内容不同的旧文件先存一份，"恢复导入前的内容"时换回来
      const swapped: string[] = [];
      for (const m of w.media) {
        const f = zip.file(`media/${m.id}`);
        if (!f) continue;
        const buf = await f.async('arraybuffer');
        const old = await getBlob(m.id).catch(() => undefined);
        if (old && !(await sameBytes(old, buf))) { await putBlob(BACKUP_MEDIA_PREFIX + m.id, old); swapped.push(m.id); }
        await putBlob(m.id, new Blob([buf], { type: m.mime }));
      }
      try { localStorage.setItem(BACKUP_MEDIA_KEY, JSON.stringify(swapped)); } catch { /* 存不下就算了 */ }
      mediaChanged();
    }
    replaceWorld(w);
    setUI({ mapId: w.maps[0].id, selection: null, views: {} });
    toast(`已导入：${w.name}`);
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

export async function importRabbitholeFile(file: File) {
  try {
    const { importRabbithole } = await import('./importRabbithole');
    const { world, blobs, summary } = await importRabbithole(file);
    for (const b of blobs) await putBlob(b.id, b.blob);
    try { localStorage.setItem(BACKUP_MEDIA_KEY, '[]'); } catch { /* 存不下就算了 */ } // Rabbithole 导入的都是新 ID，没覆盖任何文件
    mediaChanged();
    replaceWorld(world);
    setUI({ mapId: world.maps[0].id, selection: null, views: {}, flowId: world.flows[0]?.id ?? null, mode: 'edit', tool: 'select' });
    toast(summary);
  } catch (e) {
    toast('Rabbithole 导入失败：' + (e as Error).message);
  }
}

// ---------- 导入前备份 / 自动导入 ----------

const BACKUP_KEY = 'ts-map-world-backup';
const BACKUP_MEDIA_KEY = 'ts-map-media-backup'; // 上一次导入时被覆盖掉的媒体 ID
const BACKUP_MEDIA_PREFIX = '__backup__/';

async function sameBytes(a: Blob, b: ArrayBuffer) {
  if (a.size !== b.byteLength) return false;
  const x = new Uint8Array(await a.arrayBuffer()), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** 导入时被覆盖的媒体：和备份那份互换（来回切换都对）。 */
async function swapBackupMedia() {
  let ids: string[] = [];
  try { ids = JSON.parse(localStorage.getItem(BACKUP_MEDIA_KEY) ?? '[]'); } catch { /* 没有 */ }
  for (const id of ids) {
    const cur = await getBlob(id).catch(() => undefined);
    const bak = await getBlob(BACKUP_MEDIA_PREFIX + id).catch(() => undefined);
    if (!bak) continue;
    await putBlob(id, bak);
    if (cur) await putBlob(BACKUP_MEDIA_PREFIX + id, cur);
  }
  mediaChanged();
}

/** 导入会替换当前内容，所以先把当前内容存一份，"文件"菜单里可以恢复。 */
export function backupCurrent() {
  try { localStorage.setItem(BACKUP_KEY, JSON.stringify(getWorld())); } catch { /* 存不下就算了 */ }
}
export function hasBackup() {
  try { return !!localStorage.getItem(BACKUP_KEY); } catch { return false; }
}
export async function restoreBackup() {
  try {
    const s = localStorage.getItem(BACKUP_KEY);
    if (!s) return;
    await swapBackupMedia();
    const w = migrateWorld(JSON.parse(s));
    localStorage.setItem(BACKUP_KEY, JSON.stringify(getWorld())); // 来回切换：恢复后，被替换掉的那份又成了备份
    replaceWorld(w);
    setUI({ mapId: w.maps[0].id, selection: null, views: {}, flowId: w.flows[0]?.id ?? null });
    toast(`已恢复：${w.name}`);
  } catch (e) {
    toast('恢复失败：' + (e as Error).message);
  }
}

/** 自动认出文件类型：本编辑器的工程，或 Rabbithole 的地图。 */
export async function importAnyFile(file: File) {
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
  backupCurrent();
  return rabbithole ? importRabbitholeFile(file) : importProject(file);
}

/** 用命令行带文件启动时（npm start -- 文件），打开页面就自动导入。 */
export async function autoLoadFromLauncher() {
  const name = new URLSearchParams(location.search).get('load');
  if (!name) return;
  history.replaceState(null, '', location.pathname); // 刷新页面时不再重复导入
  try {
    const res = await fetch('/__load');
    if (!res.ok) throw new Error(`启动器没有提供文件（${res.status}）`);
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
