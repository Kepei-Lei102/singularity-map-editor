import type { MediaMeta, Npc, World } from './types';
export const MAX_SIDE: number;
export const MAX_COORD: number;
export function safeId(id: unknown): boolean;
/** 检查整份工程，有问题就抛出一句能看懂的错误。 */
export function checkWorld(w: unknown, migrated?: boolean): asserts w is World;
/** 旧版允许过、现在不允许的数值夹回范围，返回改了什么。 */
export function repairWorld(w: unknown): string[];
/** 检查一位 NPC；partial = 单独导入的 JSON（id、progress 等可以缺）。 */
export function checkNpc(n: unknown, where: string, partial?: boolean): asserts n is Partial<Npc> & { name: string };
/** 工程里声明了、却没有对应文件的媒体。 */
export function missingMedia(w: World, has: (id: string) => boolean): MediaMeta[];
