import type { ArchitectureDoor, ArchitectureFragment, GameMap, MapObject, Wall } from './types';
export function isArchitectureObject(o: Pick<MapObject, 'geometry' | 'opening'>): boolean;
export function openingIsOpen(o: MapObject): boolean;
export function architectureWalls(m: Pick<GameMap, 'objects' | 'architecture'>): Wall[];
export function architectureDoors(m: Pick<GameMap, 'objects' | 'architecture'>): ArchitectureDoor[];
export function architectureObjectBounds(m: GameMap, o: MapObject): { x: number; y: number; w: number; h: number };
export function normalizeArchitectureBounds(m: GameMap): void;
export function migrateArchitecture(m: GameMap): GameMap;
export interface PhysicalFragment extends ArchitectureFragment { objectId: string; hidden: boolean; blocksMove: boolean; blocksSight: boolean }
export function architectureGeometry(m: Pick<GameMap, 'objects' | 'architecture'>, includeOpen?: boolean): PhysicalFragment[];
