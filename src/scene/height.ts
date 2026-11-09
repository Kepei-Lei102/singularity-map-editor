// 地形高度：每格相对本层地面高几格。
//
// 作者的口径：
// - 1 格 = 0.75 米
// - 两层之间默认挑高 8 格（= 6 米）
// - 跳跃、攀爬、高度恐惧全按这个算
//
// heights 不填就是整层平地，所有地方都是 0。
import type { GameMap } from '../core/types';

/** 一层楼挑多高（格）。作者定：8 格 = 6 米。 */
export const FLOOR_HEIGHT_CELLS = 8;
/** 一格多少米。 */
export const CELL_METERS = 0.75;

/** 某格相对本层地面的高度（格）。没填就是 0。 */
export function heightAt(m: GameMap, x: number, y: number): number {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return 0;
  if (x < 0 || y < 0 || x >= m.width || y >= m.height) return 0;
  const v = m.heights?.[y * m.width + x];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 某格高度的米数。 */
export function metersAt(m: GameMap, x: number, y: number): number {
  return heightAt(m, x, y) * CELL_METERS;
}

/** 两格之间的落差（目标高度 − 起始高度）。正数是往上，负数是往下。 */
export function heightDiff(m: GameMap, from: { x: number; y: number }, to: { x: number; y: number }): number {
  return heightAt(m, to.x, to.y) - heightAt(m, from.x, from.y);
}

/** 整层是不是平的（没填过 heights 就是平的）。 */
export function isFlat(m: GameMap): boolean {
  return !m.heights || m.heights.every((v) => !v);
}

/** 写一格高度。0 就是平地，跟没填一样。返回是否真的改了。 */
export function setHeight(m: GameMap, x: number, y: number, cells: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= m.width || y >= m.height) return false;
  if (!Number.isFinite(cells)) return false;
  const i = y * m.width + x;
  if (!m.heights) {
    // 第一次写的时候补一个整层 0 的数组，之后按索引读写。
    if (cells === 0) return false;
    m.heights = new Array(m.width * m.height).fill(0);
  }
  m.heights[i] = cells;
  return true;
}

/** 清掉整层高度，回到平地。 */
export function clearHeights(m: GameMap): void {
  delete m.heights;
}

// ---------- 高度恐惧 ----------

/**
 * 高度恐惧的四档。作者口径：
 * - 2 格（1.5 米）：不触发
 * - 4 格（3 米）：优势意志检定
 * - 8 格（6 米）：意志检定
 * - 12 格（9 米）：劣势意志检定
 *
 * 「往下看」和「跳上去」都算——作者说两样都有。
 */
export type FearTier = 'none' | 'advantage' | 'normal' | 'disadvantage';

export function fearTier(cells: number): FearTier {
  const h = Math.abs(cells);
  if (h >= 12) return 'disadvantage';
  if (h >= 8) return 'normal';
  if (h >= 4) return 'advantage';
  return 'none';
}

/** 这一档要不要掷骰。 */
export function fearNeedsRoll(tier: FearTier): boolean {
  return tier !== 'none';
}

/** 优势/劣势怎么掷：优势掷两次取高的，劣势掷两次取低的。没优势劣势就掷一次。 */
export function fearRollMode(tier: FearTier): 'single' | 'advantage' | 'disadvantage' {
  if (tier === 'advantage') return 'advantage';
  if (tier === 'disadvantage') return 'disadvantage';
  return 'single';
}

/** 给人看的一句话。 */
export function describeFear(cells: number): string {
  const tier = fearTier(cells);
  const m = Math.abs(cells);
  switch (tier) {
    case 'advantage': return `${m} 格（${(m * CELL_METERS).toFixed(1)} 米）：优势意志检定`;
    case 'normal': return `${m} 格（${(m * CELL_METERS).toFixed(1)} 米）：意志检定`;
    case 'disadvantage': return `${m} 格（${(m * CELL_METERS).toFixed(1)} 米）：劣势意志检定`;
    default: return `${m} 格（${(m * CELL_METERS).toFixed(1)} 米）：不用检定`;
  }
}
