// 这个标签页的会话标识（编辑器之间、编辑器和玩家窗口之间认人用；自动保存也按它分槽）。
// 存在 sessionStorage：刷新页面不变；新开一个标签页就是新的。复制标签页会把它一起复制，
// sync.ts 发现撞车时由后打开的那个调用 renewSession() 换新的。

const KEY = 'ts-sync-session';
export const rand = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

export let SESSION = (() => {
  try {
    let s = sessionStorage.getItem(KEY);
    if (!s) { s = rand(); sessionStorage.setItem(KEY, s); }
    return s;
  } catch { return rand(); }
})();

const listeners = new Set<() => void>();
/** 会话标识换了（复制标签页撞车）时通知（自动保存要换到新槽里存一份）。 */
export function onSessionRenewed(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }

export function renewSession() {
  SESSION = rand();
  try { sessionStorage.setItem(KEY, SESSION); } catch { /* 存不了就只在这次有效 */ }
  listeners.forEach((l) => l());
}
