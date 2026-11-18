// 每条线上绑定的 asset 在途账本。单独成模块，方便不经过 ws 直接测上限/引用计数。
// 一个 binding 一个实例：重连、断线、清空时换新实例，旧 serve 的 finally 只会还到旧实例，
// 不会减到新连接上的同名 requestId。

export type AssetCancelEntry = { all: boolean; keys: Set<string> };

export const ASSET_MAX_REFS = 4;
export const ASSET_MAX_ACTIVE = 64;
export const ASSET_MAX_CANCEL_KEYS = 64;
/** 每条 binding 同时在途的 request 数；再多就回 forbidden，避免一个人占多份全局预算。 */
export const ASSET_MAX_FLOWS = 2;

export class AssetSession {
  private active = new Map<string, number>();
  private cancels = new Map<string, AssetCancelEntry>();

  /** requestId 的 serve 引用数。 */
  get(requestId: string): number {
    return this.active.get(requestId) ?? 0;
  }

  /** 总在途 serve 数（同一 requestId 的重复也算）。 */
  get activeCount(): number {
    let total = 0;
    for (const n of this.active.values()) total += n;
    return total;
  }

  /** 排队前先占位；超 refs 或超总量就不占，调用方回 forbidden。 */
  tryAcquire(requestId: string): boolean {
    const refs = this.get(requestId);
    if (refs >= ASSET_MAX_REFS || this.activeCount >= ASSET_MAX_ACTIVE) return false;
    this.active.set(requestId, refs + 1);
    return true;
  }

  /** serve 结束还引用；归零才删这个 requestId 的 cancel。 */
  release(requestId: string): void {
    const refs = this.active.get(requestId);
    if (!refs) return;
    const left = refs - 1;
    if (left <= 0) this.active.delete(requestId);
    else this.active.set(requestId, left);
    if (this.get(requestId) <= 0) this.cancels.delete(requestId);
  }

  /** 只给还在途的 requestId 记 cancel；迟到/木马请求不占表。 */
  cancel(requestId: string, key?: string): boolean {
    if (!this.get(requestId)) return false;
    const entry = this.cancels.get(requestId) ?? { all: false, keys: new Set<string>() };
    if (typeof key === 'string' && key) {
      if (entry.keys.size < ASSET_MAX_CANCEL_KEYS) entry.keys.add(key);
    } else entry.all = true;
    this.cancels.set(requestId, entry);
    return true;
  }

  isCancelled(requestId: string, key?: string): boolean {
    const entry = this.cancels.get(requestId);
    return !!entry && (entry.all || (!!key && entry.keys.has(key)));
  }

  /** 断线/清空后再复用 binding 时换新实例，不把旧账带过去。 */
  static fresh(): AssetSession {
    return new AssetSession();
  }
}
