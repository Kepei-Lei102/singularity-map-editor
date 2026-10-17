import type { MediaMeta, World } from './types';
export function safeId(id: unknown): boolean;
/** 检查整份工程，有问题就抛出一句能看懂的错误。 */
export function checkWorld(w: unknown): asserts w is World;
/** 工程里声明了、却没有对应文件的媒体。 */
export function missingMedia(w: World, has: (id: string) => boolean): MediaMeta[];
