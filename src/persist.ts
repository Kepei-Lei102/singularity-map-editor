import { SESSION } from './session';

// 浏览器里的存档槽（localStorage）：自动保存（world）和"导入前的备份"（backup）各一类。
// 每个标签页（会话）各存一份，所以同时开两个标签页编两个工程，互相不会覆盖：
//   - 刷新页面：读自己这个标签页的那份；
//   - 新开标签页：自动保存读最近一次保存的那份（接着干活）；"导入前的备份"只认自己的（是这个标签页导入前的内容）。
// 每类最多留 MAX 份（按最近使用），空间不够时先挤掉别的标签页最旧的那份。

export type SlotKind = 'world' | 'backup';
const MAX = 3;
const LEGACY: Record<SlotKind, string> = { world: 'ts-map-world-v1', backup: 'ts-map-world-backup' }; // 旧版只有一份
const slotKey = (kind: SlotKind, s: string) => `ts-map-${kind}:${s}`;
const indexKey = (kind: SlotKind) => `ts-map-${kind}-index`;
type Entry = { s: string; at: number };

function readIndex(kind: SlotKind): Entry[] {
  try {
    const j = JSON.parse(localStorage.getItem(indexKey(kind)) ?? '[]');
    return Array.isArray(j) ? j.filter((e) => e && typeof e.s === 'string' && typeof e.at === 'number') : [];
  } catch { return []; }
}
function writeIndex(kind: SlotKind, idx: Entry[]) {
  try { localStorage.setItem(indexKey(kind), JSON.stringify(idx)); } catch { /* 索引写不下就算了，槽本身还在 */ }
}

/** 存进这个标签页的槽。写不下（空间不够）时先挤掉别的标签页最旧的，再不行返回 false（原来那份不受影响）。 */
export function saveSlot(kind: SlotKind, text: string): boolean {
  const me = SESSION;
  let idx = [{ s: me, at: Date.now() }, ...readIndex(kind).filter((e) => e.s !== me)];
  for (const e of idx.slice(MAX)) try { localStorage.removeItem(slotKey(kind, e.s)); } catch { /* 删不掉就算了 */ }
  idx = idx.slice(0, MAX);
  for (;;) {
    try {
      localStorage.setItem(slotKey(kind, me), text);
      writeIndex(kind, idx);
      try { localStorage.removeItem(LEGACY[kind]); } catch { /* 旧版的那份留着也无妨 */ }
      return true;
    } catch {
      const victim = [...idx].reverse().find((e) => e.s !== me);
      if (!victim) return false;
      try { localStorage.removeItem(slotKey(kind, victim.s)); } catch { /* 删不掉 */ }
      idx = idx.filter((e) => e !== victim);
    }
  }
}

/** 读：自己这个标签页的；没有的话，自动保存读最近的那份，备份只认自己的。都没有就看旧版的那一份。 */
export function loadSlot(kind: SlotKind): string | null {
  try {
    const own = localStorage.getItem(slotKey(kind, SESSION));
    if (own) return own;
    if (kind === 'world') for (const e of readIndex(kind)) { const t = localStorage.getItem(slotKey(kind, e.s)); if (t) return t; }
    return localStorage.getItem(LEGACY[kind]);
  } catch { return null; }
}

export function dropSlot(kind: SlotKind) {
  try {
    localStorage.removeItem(slotKey(kind, SESSION));
    localStorage.removeItem(LEGACY[kind]);
    writeIndex(kind, readIndex(kind).filter((e) => e.s !== SESSION));
  } catch { /* 无能为力 */ }
}

/** 所有标签页存下的全部内容（清理媒体时用：只要还有一份存档引用某个文件，就不删）。 */
export function allSlots(): string[] {
  const out: string[] = [];
  try {
    for (const kind of ['world', 'backup'] as SlotKind[]) {
      for (const e of readIndex(kind)) { const t = localStorage.getItem(slotKey(kind, e.s)); if (t) out.push(t); }
      const legacy = localStorage.getItem(LEGACY[kind]);
      if (legacy) out.push(legacy);
    }
    // 索引丢了也不漏：按前缀扫一遍
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /^ts-map-(world|backup):/.test(k)) { const t = localStorage.getItem(k); if (t && !out.includes(t)) out.push(t); }
    }
  } catch { /* 读不了 */ }
  return out;
}
