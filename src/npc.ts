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

/** 导入：一份 NPC 的 JSON 数组（别的模组也能用这个格式）。同名的覆盖，进度保留。 */
export function importNpcs(list: Partial<Npc>[]) {
  update((d) => {
    for (const raw of list) {
      const base = newNpc();
      const n: Npc = {
        ...base, ...raw, id: raw.id ?? base.id,
        topics: (raw.topics ?? []).map((t) => ({ ...t, id: t.id ?? uid() })),
        beats: (raw.beats ?? []).map((b) => ({ ...b, id: b.id ?? uid() })),
        outcomes: (raw.outcomes ?? base.outcomes).map((o) => ({ ...o, id: o.id ?? uid() })),
        progress: raw.progress ?? base.progress,
      };
      const i = d.npcs.findIndex((x) => x.name === n.name);
      if (i >= 0) {
        const old = d.npcs[i];
        // 进度里记着结果和近况的 ID：结果按名字（好结果 / 漂亮解……）、近况按顺序沿用旧 ID，引用就不会断
        n.outcomes = n.outcomes.map((o) => ({ ...o, id: old.outcomes.find((x) => x.label === o.label)?.id ?? o.id }));
        n.beats = n.beats.map((b, k) => ({ ...b, id: old.beats[k]?.id ?? b.id }));
        d.npcs[i] = { ...n, id: old.id, progress: old.progress };
      } else d.npcs.push(n);
    }
    log(d, 'note', `导入了 ${list.length} 位 NPC`);
  });
}

export function exportNpcs(w: World) {
  const data = w.npcs.map(({ progress: _p, ...rest }) => rest);
  download(`${w.name || '世界'}-NPC.json`, JSON.stringify(data, null, 2), 'application/json');
}
