import type { GameMap, World } from './types';
import { objectStateError, isArchitectureObject, furnitureSweepBlocked, isSubdivided, tokenPosition } from './architecture';
import { blocksMovement, seesPoint, sightCosts } from './perception';

/** 当前操控者确实看见家具的一部分，记忆与队友视野不算。 */
export function seesSlidingObject(world: World, map: GameMap, objectId: string, tokenId: string): boolean {
  const o = map.objects.find(o => o.id === objectId), t = map.tokens.find(t => t.id === tokenId);
  if (!o || o.hidden || !t) return false;
  const cost = sightCosts(world, map);
  for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++)
    { const n = isSubdivided(map, x, y) ? 3 : 1; for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) if (seesPoint(cost, map, t, { x: x + (sx + .5) / n, y: y + (sy + .5) / n })) return true; }
  return false;
}

export const slidingPuzzleForObject = (map: GameMap, objectId: string) =>
  map.slidingPuzzles?.find((p) => p.objectIds.includes(objectId));

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** 按单格检查整条直线路径；GM 拖远也不能穿过块、墙、人物或棋盘边界。 */
export function checkSlidingMove(world: World, map: GameMap, objectId: string, x: number, y: number): string | null {
  const puzzle = slidingPuzzleForObject(map, objectId);
  const block = map.objects.find((o) => o.id === objectId);
  if (!puzzle || !block || isArchitectureObject(block)) return '找不到这个滑块棋盘或物件';
  if (![x, y].every(Number.isSafeInteger)) return '滑块只能按整格移动';
  const dx = x - block.x, dy = y - block.y;
  if (dx !== 0 && dy !== 0) return '滑块只能沿上下左右平移，不能斜移';
  if (x < puzzle.x || y < puzzle.y || x + block.w > puzzle.x + puzzle.w || y + block.h > puzzle.y + puzzle.h ||
      x < 0 || y < 0 || x + block.w > map.width || y + block.h > map.height) return '不能移出棋盘边界';
  const goalFields = [puzzle.targetId, puzzle.goal, puzzle.gateId].filter((v) => v !== undefined).length;
  if (goalFields !== 0 && goalFields !== 3) return '目标、目标位置和关联门必须一起设置';
  if (goalFields === 3) {
    const gate = map.objects.find((o) => o.id === puzzle.gateId);
    const target = map.objects.find((o) => o.id === puzzle.targetId);
    if (!gate || gate.states.length < 2 || !target) return '棋盘缺少目标块或门的关闭／打开状态';
  }
  if (furnitureSweepBlocked(map, block, x, y)) return '被建筑薄墙或关闭的门挡住了';
  const members = new Set(map.slidingPuzzles?.flatMap((p) => p.objectIds));
  const steps = Math.abs(dx || dy);
  for (let i = 1; i <= steps; i++) {
    const box = { ...block, x: block.x + Math.sign(dx) * i, y: block.y + Math.sign(dy) * i };
    if (map.tokens.some((t) => overlaps(box, { x: tokenPosition(t).x - 1 / 3, y: tokenPosition(t).y - 1 / 3, w: 2 / 3, h: 2 / 3 }))) return '人物站在移动路径上，请先让开';
    if (map.objects.some((o) => o.id !== block.id && o.kind === 'object' &&
      (members.has(o.id) || blocksMovement(o)) && overlaps(box, o))) return '被其它滑块或挡路物件挡住了';
    for (let cy = box.y; cy < box.y + box.h; cy++) for (let cx = box.x; cx < box.x + box.w; cx++) {
      const terrain = world.terrains.find((t) => t.id === map.cells[cy * map.width + cx]);
      if (!terrain || terrain.blocksMove) return '被不可通行的地形挡住了';
    }
  }
  if (puzzle.goal) {
    const objects = map.objects.map(o => o.id === block.id ? { ...o, x, y } : o);
    const target = objects.find(o => o.id === puzzle.targetId)!;
    const error = objectStateError({ ...map, objects }, puzzle.gateId!, target.x === puzzle.goal.x && target.y === puzzle.goal.y ? 1 : 0);
    if (error) return error;
  }
  return null;
}

/** 在同一次 store update 中调用，位置和门状态一起进入撤销／试演沙盒。错误时完全不修改。 */
export function applySlidingMove(world: World, map: GameMap, objectId: string, x: number, y: number): string | null {
  const error = checkSlidingMove(world, map, objectId, x, y);
  if (error) return error;
  const puzzle = slidingPuzzleForObject(map, objectId)!;
  const block = map.objects.find((o) => o.id === objectId)!;
  block.x = x; block.y = y;
  if (puzzle.goal) {
    const target = map.objects.find((o) => o.id === puzzle.targetId)!;
    const gate = map.objects.find((o) => o.id === puzzle.gateId)!;
    gate.state = target.x === puzzle.goal.x && target.y === puzzle.goal.y ? 1 : 0;
  }
  return null;
}
