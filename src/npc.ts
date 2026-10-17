import { current } from 'immer';
import type { Npc, NpcProgress, World } from './types';
import { update } from './store';
import { log } from './actions';
import { download, uid } from './util';

// 普通人 NPC 的"现在该怎么办"：全按现实日期算（奇点之后的游戏时间和现实时间绑定）。

const DAY = 24 * 60 * 60 * 1000;
export const MONTH_NAMES = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

export const inSeason = (n: Npc, now = new Date()) => n.months.length === 0 || n.months.includes(now.getMonth() + 1);

/** 主持人现在要知道的一件事。due = 现在就可以出现；wait = 还要等；idle = 不在季节或已结束。 */
export interface NpcNext {
  kind: 'appear' | 'season' | 'present' | 'beat' | 'return' | 'done' | 'off';
  label: string;
  due: boolean;
  at?: number; // 最早出现的时间（毫秒）
  beatId?: string;
}

export function nextStep(n: Npc, now = Date.now()): NpcNext {
  const p = n.progress;
  if (p.status === 'done') return { kind: 'done', label: '已结束', due: false };
  if (p.status === 'met') return { kind: 'present', label: '在场：等玩家出主意', due: true };
  if (p.status === 'waiting') {
    if (!inSeason(n, new Date(now))) return { kind: 'off', label: `不在季节（${n.months.map((m) => MONTH_NAMES[m - 1]).join('、')}）`, due: false };
    return p.cast ? { kind: 'appear', label: '本场安排出场', due: true } : { kind: 'season', label: '这个月可以安排', due: false };
  }
  // advised：先过完近况，再回访
  const from = p.advisedAt ?? now;
  const beat = [...n.beats].sort((a, b) => a.afterDays - b.afterDays).find((b) => !p.beatsDone.includes(b.id));
  if (beat) {
    const at = from + beat.afterDays * DAY;
    return { kind: 'beat', label: at <= now ? '可以出现：说一句近况' : `近况：还要 ${daysLeft(at, now)}`, due: at <= now, at, beatId: beat.id };
  }
  const at = from + n.returnAfterDays * DAY;
  return { kind: 'return', label: at <= now ? '可以回访：说结果' : `回访：还要 ${daysLeft(at, now)}`, due: at <= now, at };
}

function daysLeft(at: number, now: number) {
  const d = (at - now) / DAY;
  return d >= 1 ? `${Math.ceil(d)} 天` : `${Math.max(1, Math.ceil(d * 24))} 小时`;
}

/** 列表排序：现在就能出场的在前，然后是等着的，最后是不在季节和已结束的。 */
export function npcOrder(w: World, now = Date.now()) {
  const rank = (n: Npc) => {
    const s = nextStep(n, now);
    if (s.due) return s.kind === 'present' ? 0 : s.kind === 'return' || s.kind === 'beat' ? 1 : 2;
    return s.kind === 'beat' || s.kind === 'return' ? 3 : s.kind === 'season' ? 4 : s.kind === 'off' ? 5 : 6;
  };
  return [...w.npcs].sort((a, b) => rank(a) - rank(b));
}

export function newNpc(): Npc {
  return {
    id: uid(), name: '新的 NPC', summary: '', icon: '🙂', color: '#c9a36b', months: [], place: null,
    persona: '', request: '', topics: [], notes: '', beats: [], returnAfterDays: 7, extra: '', outcomes: [
      { id: uid(), label: '好结果', text: '', reward: '' },
      { id: uid(), label: '坏结果', text: '', reward: '' },
    ],
    progress: { status: 'waiting', beatsDone: [] },
  };
}

function setProgress(id: string, fn: (p: NpcProgress, n: Npc) => void, text: string) {
  update((d) => {
    const n = d.npcs.find((x) => x.id === id);
    if (!n) return;
    fn(n.progress, n);
    log(d, 'note', `【${n.name}】${text}`);
  });
}

/** 这场要不要出场（备团时挑）。 */
export const npcCast = (id: string, on: boolean) =>
  setProgress(id, (p) => { p.cast = on; }, on ? '本场安排出场' : '本场不出场');
/** 在场、或者有事还没了结的，地图上要画、带团列表里要列。 */
export const npcActive = (n: Npc) => n.progress.status === 'met' || n.progress.status === 'advised' || (n.progress.status === 'waiting' && !!n.progress.cast);

export const npcMet = (id: string) => setProgress(id, (p) => { p.status = 'met'; p.metAt = Date.now(); }, '出现了');
export const npcAdvised = (id: string, advice: string, outcomeId: string, label: string) =>
  setProgress(id, (p) => { p.status = 'advised'; p.advisedAt = Date.now(); p.advice = advice; p.outcomeId = outcomeId; p.beatsDone = []; },
    `玩家的主意：${advice || '（没写）'}　→ 预计${label}`);
export const npcBeatDone = (id: string, beatId: string) =>
  setProgress(id, (p) => { if (!p.beatsDone.includes(beatId)) p.beatsDone.push(beatId); }, '来说了一句近况');
export const npcReturned = (id: string, label: string) =>
  setProgress(id, (p) => { p.status = 'done'; p.cast = false; p.doneAt = Date.now(); }, `回访：${label}`);
export const npcReset = (id: string) =>
  setProgress(id, (p) => { p.status = 'waiting'; p.cast = false; delete p.metAt; delete p.advisedAt; delete p.advice; delete p.outcomeId; delete p.doneAt; p.beatsDone = []; }, '进度重置');
/** 主持人兜底：把要等的时间往前挪，当作已经到日子了（比如这周临时加了一场）。 */
export const npcSkipWait = (id: string, at: number) =>
  setProgress(id, (p) => { if (p.advisedAt) p.advisedAt -= Math.max(0, at - Date.now()); }, '主持人跳过了等待');

/** 导入前检查一位 NPC：缺名字、字段类型不对就报错（一位都不导入）。 */
function checkNpc(raw: unknown, i: number): asserts raw is Partial<Npc> & { name: string } {
  const bad = (what: string) => { throw new Error(`第 ${i + 1} 位 NPC ${what}`); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('不是对象');
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || !r.name.trim()) bad('没有名字');
  for (const k of ['summary', 'icon', 'color', 'persona', 'request', 'notes', 'extra'])
    if (r[k] !== undefined && typeof r[k] !== 'string') bad(`的 ${k} 应该是文字`);
  if (r.months !== undefined && (!Array.isArray(r.months) || !r.months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12))) bad('的 months 应该是 1–12 的整数列表');
  if (r.returnAfterDays !== undefined && !(typeof r.returnAfterDays === 'number' && r.returnAfterDays >= 0)) bad('的 returnAfterDays 应该是不小于 0 的数字');
  if (r.place != null) {
    const p = r.place as Record<string, unknown>;
    if (typeof p !== 'object' || typeof p.mapId !== 'string' || !Number.isInteger(p.x) || !Number.isInteger(p.y)) bad('的 place 应该是 { mapId, x, y }（整数格子）');
  }
  for (const k of ['topics', 'beats', 'outcomes'])
    if (r[k] !== undefined && (!Array.isArray(r[k]) || !(r[k] as unknown[]).every((x) => x && typeof x === 'object'))) bad(`的 ${k} 应该是对象列表`);
  if (Array.isArray(r.beats) && !r.beats.every((b) => typeof b.afterDays === 'number' && typeof (b.text ?? '') === 'string')) bad('的 beats 每一条都要有 afterDays（天数）和 text');
}

/**
 * 导入：一份 NPC 的 JSON 数组（别的模组也能用这个格式）。同名的覆盖，进度保留。
 * 进度里记着结果和近况的 ID，所以覆盖时要把新内容对到旧 ID 上：
 *   有 ID 的按 ID（导出再导入、改了顺序都对得上）；没 ID 的，结果按名字、近况按原文，必须唯一才对上；对不上的算新的。
 * 旧进度引用的结果或近况在新内容里没了：近况从"已讲过"里去掉，结果清掉并在返回的提示里说一声。
 */
export function importNpcs(input: unknown[]): string[] {
  input.forEach(checkNpc);
  const list = input as (Partial<Npc> & { name: string })[];
  const warnings: string[] = [];
  update((d) => {
    for (const raw of list) {
      const base = newNpc();
      const fresh = <T extends { id?: string }>(xs: T[]) => { const seen = new Set<string>(); return xs.map((x) => { const id = typeof x.id === 'string' && x.id && !seen.has(x.id) ? x.id : uid(); seen.add(id); return { ...x, id }; }); };
      const n: Npc = {
        ...base, ...raw, id: base.id,
        topics: fresh(raw.topics ?? []),
        beats: fresh(raw.beats ?? []),
        outcomes: fresh(raw.outcomes ?? base.outcomes),
        progress: raw.progress && typeof raw.progress === 'object' ? { ...base.progress, ...raw.progress, beatsDone: Array.isArray(raw.progress.beatsDone) ? raw.progress.beatsDone : [] } : base.progress,
      };
      const i = d.npcs.findIndex((x) => x.name === n.name);
      if (i < 0) {
        if (raw.id && !d.npcs.some((x) => x.id === raw.id)) n.id = raw.id;
        d.npcs.push(n);
        continue;
      }
      const old = d.npcs[i];
      const match = <T extends { id: string }>(news: T[], olds: T[], given: (x: T) => boolean, key: (x: T) => string) => {
        const taken = new Set<string>();
        return news.map((x) => {
          if (given(x) && olds.some((o) => o.id === x.id)) { taken.add(x.id); return x; } // 带着旧 ID 来的
          const same = olds.filter((o) => key(o) === key(x) && !taken.has(o.id));
          const others = news.filter((y) => y !== x && key(y) === key(x));
          if (same.length === 1 && !others.length) { taken.add(same[0].id); return { ...x, id: same[0].id }; }
          return x;
        });
      };
      const hadId = (xs: { id?: string }[] | undefined) => new Set((xs ?? []).map((x) => x.id).filter(Boolean));
      const outIds = hadId(raw.outcomes), beatIds = hadId(raw.beats);
      n.outcomes = match(n.outcomes, old.outcomes, (o) => outIds.has(o.id), (o) => o.label);
      n.beats = match(n.beats, old.beats, (b) => beatIds.has(b.id), (b) => (b.text ?? '').trim());
      const progress = structuredClone(current(old.progress)) as NpcProgress; // old 是 immer 的草稿，先取出普通对象
      const lostBeats = progress.beatsDone.filter((id) => !n.beats.some((b) => b.id === id));
      if (lostBeats.length) { progress.beatsDone = progress.beatsDone.filter((id) => !lostBeats.includes(id)); warnings.push(`${n.name}：${lostBeats.length} 条已讲过的近况在新内容里找不到了`); }
      if (progress.outcomeId && !n.outcomes.some((o) => o.id === progress.outcomeId)) {
        const label = old.outcomes.find((o) => o.id === progress.outcomeId)?.label ?? '';
        delete progress.outcomeId;
        warnings.push(`${n.name}：之前判的结果「${label}」在新内容里没有了，需要重新判`);
      }
      d.npcs[i] = { ...n, id: old.id, progress };
    }
    log(d, 'note', `导入了 ${list.length} 位 NPC`);
  });
  return warnings;
}

export function exportNpcs(w: World) {
  const data = w.npcs.map(({ progress: _p, ...rest }) => rest);
  download(`${w.name || '世界'}-NPC.json`, JSON.stringify(data, null, 2), 'application/json');
}
