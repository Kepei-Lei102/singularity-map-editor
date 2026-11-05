import type { GameMap, MapObject } from './types';
export function objectEnabled(map: Pick<GameMap, 'objects'>, object: Pick<MapObject, 'enabled' | 'opening'> | undefined): boolean;
