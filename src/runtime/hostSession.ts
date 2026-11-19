import { identityKnown, playerSeen, UNKNOWN_OBJECT } from '../scene/identity';
import { objectEnabled } from '../core/objectData.js';
import { isArchitectureObject, clipArchitecture, fogAt, tokenPosition } from '../scene/architecture';
import { anyVisible } from '../scene/memory';
import type { CellGroup, CodeRequest, CombatNotice, DiceJudgment, Endpoint, GameMap, PendingJudgment, PlayerClue, VisionLayer, World } from '../core/types';
import { visibleMarks } from '../scene/perception';
import { viewerOf, visiblePoint } from '../scene/sight';
import { numbering } from '../scene/render';
import { getUI, projectContext, worldContext } from '../core/store';
import { SESSION } from '../core/session';
import { groupBounds } from '../core/grid';
import { effectiveLayer, emptyVision } from '../scene/vision';

// 主持端算给玩家的载荷。纯函数：不碰 transport、不碰 asset、不写世界。
// sync.ts 仍是公开门面，playerWorld/playerMap/playerDiceMode 由它 re-export。
// 其余 export 只给 sync.ts 组装玩家载荷用，不是对外 API。

/** 一个玩家窗口的绑定：pcId 是身份也是视角；试玩窗口多带一个试玩上下文，和真实窗口互相不认。 */
export type PlayerBinding = { pcId: string; context: number; trialContext?: string };
// Binding is held only by the host; the URL carries an opaque reconnect capability, never a selectable pcId.
const players = new Map<string, PlayerBinding>();
const bindingsKey = () => `ts-player-bindings-${SESSION}`;
try {
  const saved = JSON.parse(sessionStorage.getItem(bindingsKey()) ?? '{}') as Record<string, string>;
  for (const [binding, pcId] of Object.entries(saved)) if (typeof pcId === 'string') players.set(binding, { pcId, context: projectContext() });
} catch { /* no reconnect state */ }
function saveBindings() {
  try { sessionStorage.setItem(bindingsKey(), JSON.stringify(Object.fromEntries([...players].filter(([, p]) => !p.trialContext).map(([key, p]) => [key, p.pcId])))); } catch { /* unavailable */ }
}
export function bindPlayer(binding: string, pcId: string, trialContext?: string): void {
  players.set(binding, { pcId, context: projectContext(), ...(trialContext ? { trialContext } : {}) });
  saveBindings();
}
export function unbindPlayer(binding: string): void {
  players.delete(binding);
  saveBindings();
}
export function clearPlayerBindings(): void {
  players.clear();
  saveBindings();
}
export function playerEntry(binding: string): PlayerBinding | undefined { return players.get(binding); }
export function hasPlayerBinding(binding: string): boolean { return players.has(binding); }
export function playerEntries(): IterableIterator<[string, PlayerBinding]> { return players.entries(); }
export function playerBindingKeys(): string[] { return [...players.keys()]; }
export function trialBindings(): Array<[string, PlayerBinding]> { return [...players].filter(([, p]) => !!p.trialContext); }
export function pcIdForBinding(binding: string): string | null { return players.get(binding)?.pcId ?? null; }

/**
 * 试玩里刚发生的攻击，推给跟他有关的玩家。
 * 打人的和挨打的都要知道；旁人只在同一张图、视野内才给提示 —— 这里先只推给当事人，
 * 免得把「谁在哪个角落打谁」漏出去。
 */
export function combatNoticeFor(pcId: string): CombatNotice | null {
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
export function forPlayer(p: PendingJudgment): PendingJudgment {
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

export function pendingForPlayer(pcId: string, trialContext?: string): PendingJudgment | null {
  const p = pendingFor(pcId, trialContext);
  return p ? forPlayer(p) : null;
}

export function pendingFor(pcId: string, trialContext?: string): PendingJudgment | null {
  const p = getUI().pendingJudgment;
  if (!p || p.subjectId !== pcId) return null;
  // 试玩判定只给试玩窗口，真实判定只给真实窗口：同一个角色两边都开着也不串。
  const pendingTrial = !!p.context && p.context.endsWith(':trial');
  if (!!trialContext !== pendingTrial) return null;
  if (trialContext && p.context !== trialContext) return null;
  return p;
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

/** 玩家载荷里的密码请求：只给门名和谁在输，不带作者密码、不带已输入原文。 */
export function codeForPlayer(pcId: string): CodeRequest | null {
  const p = getUI().pendingCode;
  if (!p || p.pcId !== pcId || p.context !== worldContext()) return null;
  return { id: p.id, mapId: p.mapId, objectId: p.objectId, name: p.name, pcId: p.pcId, at: p.at, submitted: !!p.code };
}

/** 试玩里这个角色自己的处境：被暂停了吗、轮到他了吗。 */
export function trialFlagsFor(pcId: string): { paused: boolean; isCurrent: boolean } | null {
  const t = getUI().trial;
  if (!t) return null;
  const idx = t.players.findIndex((x) => x.pcId === pcId);
  if (idx < 0) return null;
  return { paused: !!t.players[idx].paused, isCurrent: idx === t.current };
}
