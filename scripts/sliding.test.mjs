import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// Bundle the actual TS entry points without a browser or dev server. Only browser persistence/timers are stubbed.
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-sliding-test-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/sliding'; export * from './src/architecture'; export * from './src/perception'; export * from './src/defaults'; export * from './src/schema.js'; export * from './src/store'; export * from './src/actions'; export * from './src/trial'; export { playerWorld } from './src/sync';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.location = { search: '', origin: 'http://localhost' };
globalThis.window = { setTimeout: () => 0 };
globalThis.BroadcastChannel = class { postMessage() {} };
const api = createRequire(import.meta.url)(bundle);
after(() => rm(temp, { recursive: true, force: true }));

function fixture() {
  const world = api.emptyWorld();
  const map = api.newMap('通用棋盘', '测试', 0, 10, 10, 'floor', false);
  map.autoFog = false;
  const block = { ...api.newObject('object', 2, 2, 2, 1), id: 'target', name: '目标块', pushable: true, heavy: true };
  const other = { ...api.newObject('object', 4, 3, 1, 2), id: 'other', name: '另一块', height: 0, blocksWhen: [] };
  const gate = { ...api.newObject('object', 8, 7, 1, 1), id: 'gate', name: '门', states: ['关', '开'], blocksWhen: [0] };
  map.objects = [block, other, gate];
  map.slidingPuzzles = [{ id: 'puzzle', name: '滑块', x: 1, y: 1, w: 6, h: 6, objectIds: ['target', 'other'], targetId: 'target', goal: { x: 3, y: 2 }, gateId: 'gate' }];
  world.maps = [map];
  return { world, map, block, other, gate };
}

function install(world) {
  // Eyes represent registered characters; orphan pcIds must never become knowledge sources.
  for (const t of world.maps.flatMap(m => m.tokens)) if (t.pcId && !world.party.some(p => p.id === t.pcId)) world.party.push({ id: t.pcId, name: t.name, color: t.color, tags: [] });
  api.replaceWorld(world);
  api.setUI({ mapId: world.maps[0].id, trial: null, selection: null, mode: 'edit' });
}

test('legal single steps translate without rotating or requiring a person/helper', () => {
  const { world, map, block } = fixture();
  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const x = block.x, y = block.y;
    assert.equal(api.applySlidingMove(world, map, block.id, x + dx, y + dy), null);
    assert.deepEqual([block.w, block.h], [2, 1]);
    assert.equal(api.applySlidingMove(world, map, block.id, x, y), null);
  }
});

test('trial cannot move unseen furniture using buttons or stale selection; current eye ignores shared fog', () => {
  const { world, map } = fixture();
  map.spawn = { x: 0, y: 2 };
  map.objects.push({ ...api.newObject('object', 1, 0, 1, 10), id: 'screen', height: 2 });
  install(world); api.startTrial();
  const tokenId = api.getUI().trial.players[0].tokenId;
  assert.equal(api.seesSlidingObject(api.getWorld(), api.getWorld().maps[0], 'target', tokenId), false);
  const before = JSON.stringify(api.getWorld());
  assert.match(api.moveSlidingObject(map.id, 'target', 2, 1), /看不见/);
  assert.equal(JSON.stringify(api.getWorld()), before);
  api.update(d => { d.maps[0].tokens.find(t => t.id === tokenId).x = 2; d.maps[0].tokens.find(t => t.id === tokenId).y = 4; });
  assert.equal(api.seesSlidingObject(api.getWorld(), api.getWorld().maps[0], 'target', tokenId), true);
  assert.equal(api.moveSlidingObject(map.id, 'target', 2, 1), null);
  api.endTrial();
});

test('bounds account for whole block and reject all four edges without mutation', () => {
  const { world, map, block } = fixture();
  for (const [x, y] of [[0, 2], [6, 2], [2, 0], [2, 7]]) {
    const before = structuredClone(world);
    assert.match(api.applySlidingMove(world, map, block.id, x, y), /边界/);
    assert.deepEqual(world, before);
  }
});

test('blocks cannot intersect, including blocks which are low or nonblocking', () => {
  const { world, map, block, other } = fixture();
  other.y = 2;
  assert.match(api.checkSlidingMove(world, map, block.id, 4, 2), /滑块/);
});

test('drag path rejects crossing an intervening block even if the destination is clear', () => {
  const { world, map, block, other } = fixture();
  other.x = 4; other.y = 2; other.w = 1; other.h = 1;
  assert.match(api.checkSlidingMove(world, map, block.id, 5, 2), /挡住/);
});

test('diagonal and fractional movement is rejected', () => {
  const { world, map, block } = fixture();
  assert.match(api.checkSlidingMove(world, map, block.id, 3, 3), /斜移/);
  assert.match(api.checkSlidingMove(world, map, block.id, 2.5, 2), /整格/);
});

test('terrain blocks every cell swept by a multi-cell block', () => {
  const { world, map, block } = fixture();
  map.cells[2 * map.width + 4] = 'wall';
  assert.match(api.checkSlidingMove(world, map, block.id, 5, 2), /地形/);
});

test('external objects use blocksMovement and ignore triggers; people must leave the swept path', () => {
  const { world, map, block } = fixture();
  const obstacle = { ...api.newObject('object', 4, 2, 1, 1), states: ['关', '开'], blocksWhen: [0] };
  map.objects.push(obstacle, api.newObject('zone', 3, 2, 1, 1));
  assert.match(api.checkSlidingMove(world, map, block.id, 3, 2), /挡路/);
  obstacle.state = 1;
  map.tokens.push({ id: 'person', pcId: null, name: '人', color: '#fff', x: 3, y: 2 });
  const before = structuredClone(world);
  assert.match(api.applySlidingMove(world, map, block.id, 3, 2), /人物/);
  assert.deepEqual(world, before);
  map.tokens[0].x = 4; map.tokens[0].y = 2;
  const swept = structuredClone(world);
  assert.match(api.applySlidingMove(world, map, 'other', 4, 1), /人物/);
  assert.deepEqual(world, swept);
  map.tokens[0].x = 0;
  assert.equal(api.applySlidingMove(world, map, block.id, 3, 2), null);
});

test('target goal opens the associated gate; moving away closes it; other blocks do not solve it', () => {
  const { world, map, block, other, gate } = fixture();
  assert.equal(api.applySlidingMove(world, map, other.id, 5, 3), null);
  assert.equal(gate.state, 0);
  assert.equal(api.applySlidingMove(world, map, block.id, 3, 2), null);
  assert.equal(gate.state, 1);
  assert.equal(api.applySlidingMove(world, map, block.id, 2, 2), null);
  assert.equal(gate.state, 0);
});

test('store makes move and gate one undo/redo step with state revisions', () => {
  const { world, map } = fixture(); install(world);
  assert.equal(api.moveSlidingObject(map.id, 'target', 3, 2), null);
  assert.equal(api.getWorld().maps[0].objects[2].stateRev, 1);
  api.undo();
  assert.deepEqual([api.getWorld().maps[0].objects[0].x, api.getWorld().maps[0].objects[2].state], [2, 0]);
  api.redo();
  assert.deepEqual([api.getWorld().maps[0].objects[0].x, api.getWorld().maps[0].objects[2].state], [3, 1]);
});

test('trial uses sandbox and rejects another map; ending it restores block and gate', () => {
  const { world, map } = fixture();
  world.maps.push(api.newMap('别处', '测试', 0, 10, 10, 'floor', false));
  install(world); api.startTrial();
  assert.ok(api.getUI().trial);
  assert.equal(api.moveSlidingObject(map.id, 'target', 3, 2), null);
  api.setUI({ mapId: world.maps[1].id });
  const before = api.getWorld();
  assert.match(api.moveSlidingObject(world.maps[1].id, 'target', 3, 2), /当前地图/);
  assert.equal(api.getWorld(), before);
  api.endTrial();
  assert.deepEqual([api.getWorld().maps[0].objects[0].x, api.getWorld().maps[0].objects[2].state], [2, 0]);
});

test('ordinary trial push cannot bypass a sliding puzzle even with helper present', () => {
  const { world, map } = fixture(); map.spawn = { x: 1, y: 2 }; install(world); api.startTrial();
  api.addTrialPlayer(); api.switchTrialPlayer(0);
  const before = api.getWorld();
  api.trialMove(1, 0);
  assert.equal(api.getWorld(), before);
  assert.match(api.getUI().trial.msg, /滑块/);
  api.endTrial();
});

test('existing room reset restores gate state and block position together', () => {
  const { world, map } = fixture();
  map.rooms.push({ id: 'room', name: '房间', color: '#fff', note: '', tags: [] });
  map.roomCells.fill('room'); install(world);
  api.captureRoomReset(map.id, 'room');
  api.moveSlidingObject(map.id, 'target', 3, 2);
  api.resetRoom(map.id, 'room');
  assert.deepEqual([api.getWorld().maps[0].objects[0].x, api.getWorld().maps[0].objects[2].state], [2, 0]);
});

test('copy remaps puzzle references and resets; reshape shifts board, goal and reset', () => {
  const { world, map } = fixture(); install(world);
  api.duplicateMap(map.id);
  let copy = api.getWorld().maps[1], p = copy.slidingPuzzles[0];
  assert.notEqual(p.id, 'puzzle');
  assert.ok(p.objectIds.every((id) => copy.objects.some((o) => o.id === id)));
  assert.equal(p.targetId, copy.objects[0].id); assert.equal(p.gateId, copy.objects[2].id);
  api.checkWorld(api.getWorld(), true);
  api.reshapeMaps([copy.id], 1, 1, 0, 0);
  copy = api.getWorld().maps[1]; p = copy.slidingPuzzles[0];
  assert.deepEqual([p.x, p.y, p.goal.x, p.goal.y], [2, 2, 4, 3]);
  api.checkWorld(api.getWorld(), true);
  const before = api.getWorld(); api.reshapeMaps([copy.id], -3, 0, 0, 0);
  assert.equal(api.getWorld(), before);
});

test('player payload omits puzzle metadata and hidden solution coordinates', () => {
  const { world, map } = fixture(); world.playerMapId = map.id;
  assert.equal(api.playerWorld(world).maps[0].slidingPuzzles, undefined);
});

function roomFixture() {
  const data = fixture();
  const room = { id: 'room', name: '房间', color: '#fff', note: '', tags: [], layouts: [] };
  data.map.rooms = [room]; data.map.roomCells.fill(room.id);
  return { ...data, room };
}

function saveLayout(data, name = '初始') {
  assert.equal(api.saveRoomLayout(data.map.id, 'room', name, '备团说明'), null);
  return api.getWorld().maps[0].rooms[0].layouts.at(-1).id;
}

test('free sliding schema accepts no goal fields, never changes any door, and keeps collisions', () => {
  const { world, map, block, gate } = fixture();
  for (const k of ['targetId', 'goal', 'gateId']) delete map.slidingPuzzles[0][k];
  api.checkWorld(world, true);
  assert.equal(api.applySlidingMove(world, map, block.id, 3, 2), null);
  assert.equal(gate.state, 0);
  assert.match(api.applySlidingMove(world, map, block.id, 0, 2), /边界/);
  for (const k of ['targetId', 'goal', 'gateId']) {
    const partial = structuredClone(world);
    partial.maps[0].slidingPuzzles[0][k] = k === 'goal' ? { x: 3, y: 2 } : k === 'targetId' ? 'target' : 'gate';
    assert.throws(() => api.checkWorld(partial, true), /必须全有或全无/);
  }
  install(world); api.duplicateMap(map.id);
  const copy = api.getWorld().maps[1];
  assert.equal(copy.slidingPuzzles[0].goal, undefined);
  assert.equal(copy.slidingPuzzles[0].targetId, undefined);
  api.reshapeMaps([copy.id], 1, 1, 0, 0);
  api.checkWorld(api.getWorld(), true);
  const before = api.getWorld();
  api.deleteMapObject(copy.id, copy.objects[0].id);
  assert.equal(api.getWorld(), before);
});

test('prep selection atomically applies a room and reset in one undo step; same choice can be reapplied', () => {
  const data = roomFixture(); install(data.world);
  const id = saveLayout(data);
  api.moveSlidingObject(data.map.id, 'target', 3, 2);
  api.setUI({ mode: 'prep' });
  assert.equal(api.applyRoomLayout(data.map.id, 'room', id), null);
  let map = api.getWorld().maps[0], room = map.rooms[0];
  assert.deepEqual([map.objects[0].x, map.objects[2].state, room.activeLayoutId], [2, 0, id]);
  assert.deepEqual(room.reset.objects, room.layouts[0].objects);
  api.undo(); map = api.getWorld().maps[0];
  assert.deepEqual([map.objects[0].x, map.objects[2].state, map.rooms[0].activeLayoutId], [3, 1, undefined]);
  api.redo();
  api.moveSlidingObject(data.map.id, 'target', 3, 2);
  assert.equal(api.applyRoomLayout(data.map.id, 'room', id), null);
  assert.equal(api.getWorld().maps[0].objects[0].x, 2);
  api.setUI({ mode: 'run', unlock: true });
  const before = api.getWorld();
  assert.match(api.applyRoomLayout(data.map.id, 'room', id), /只能在备团/);
  assert.equal(api.getWorld(), before);
  api.setUI({ mode: 'prep' }); api.startTrial();
  const sandbox = api.getWorld();
  assert.match(api.applyRoomLayout(data.map.id, 'room', id), /非试玩/);
  assert.equal(api.getWorld(), sandbox); api.endTrial();
});

test('layout validation uses final batch positions so blocks can swap without partial collision', () => {
  const data = roomFixture(); data.block.w = 1; data.other.w = 1; data.other.h = 1;
  const objects = data.map.objects.map(({ id, x, y, state }) => ({ id, x, y, state }));
  [objects[0].x, objects[1].x] = [objects[1].x, objects[0].x];
  [objects[0].y, objects[1].y] = [objects[1].y, objects[0].y];
  data.room.layouts = [{ id: 'swap', name: '互换', objects }];
  install(data.world); api.setUI({ mode: 'prep' });
  assert.equal(api.applyRoomLayout(data.map.id, 'room', 'swap'), null);
  assert.deepEqual(api.getWorld().maps[0].objects.slice(0, 2).map((o) => [o.x, o.y]), [[4, 3], [2, 2]]);
  api.checkWorld(api.getWorld(), true);
});

test('invalid bounds, state, missing references and overlapping blocks reject entire application', () => {
  const mutations = [
    (s) => s[2].x = 10,
    (s) => s[0].state = 99,
    (s) => s[0].id = 'missing',
    (s) => { s[1].x = s[0].x; s[1].y = s[0].y; },
    (s) => s[0].x = 6, // top-left fits map but full block exceeds board
  ];
  for (const mutate of mutations) {
    const data = roomFixture();
    const objects = data.map.objects.map(({ id, x, y, state }) => ({ id, x, y, state }));
    mutate(objects); data.room.layouts = [{ id: 'bad', name: '坏排布', objects }];
    install(data.world); api.setUI({ mode: 'prep' });
    const before = api.getWorld();
    assert.equal(typeof api.applyRoomLayout(data.map.id, 'room', 'bad'), 'string');
    assert.equal(api.getWorld(), before);
    assert.throws(() => api.checkWorld(before, true), /房间/);
  }
});

test('save and capture include tracked furniture moved outside the room; cross-room sharing is rejected', () => {
  const data = roomFixture(); delete data.map.slidingPuzzles;
  data.map.roomCells.fill(''); data.map.roomCells[2 * data.map.width + 2] = 'room';
  install(data.world); api.captureRoomReset(data.map.id, 'room');
  api.update((d) => { d.maps[0].objects[0].x = 6; });
  const first = saveLayout(data, '挪出房间');
  assert.deepEqual(api.getWorld().maps[0].rooms[0].layouts[0].objects.map((o) => [o.id, o.x]), [['target', 6]]);
  api.setUI({ mode: 'prep' }); api.applyRoomLayout(data.map.id, 'room', first);
  api.update((d) => { delete d.maps[0].rooms[0].reset; d.maps[0].objects[0].x = 5; });
  api.setUI({ mode: 'edit' }); saveLayout(data, '仍在跟踪');
  api.captureRoomReset(data.map.id, 'room');
  assert.equal(api.getWorld().maps[0].rooms[0].reset.objects[0].x, 5);
  api.update((d) => {
    d.maps[0].rooms.push({ id: 'other-room', name: '另一间', color: '#fff', note: '', tags: [] });
    d.maps[0].roomCells[2 * d.maps[0].width + 5] = 'other-room';
  });
  const before = api.getWorld();
  assert.match(api.saveRoomLayout(data.map.id, 'other-room', '冲突'), /不能跨房间共用/);
  assert.equal(api.getWorld(), before);
  api.checkWorld(before, true);
});

test('copy remaps every layout/reset object reference and preserves selected layout', () => {
  const data = roomFixture(); install(data.world); const id = saveLayout(data);
  api.setUI({ mode: 'prep' }); api.applyRoomLayout(data.map.id, 'room', id);
  api.duplicateMap(data.map.id);
  const copy = api.getWorld().maps[1], room = copy.rooms[0];
  assert.equal(room.activeLayoutId, id);
  assert.deepEqual(room.layouts[0].objects.map((o) => o.id), copy.objects.map((o) => o.id));
  assert.deepEqual(room.reset.objects, room.layouts[0].objects);
  assert.ok(room.layouts[0].objects.every((s) => !data.map.objects.some((o) => o.id === s.id)));
  api.checkWorld(api.getWorld(), true);
});

test('reshape shifts all alternatives and removes clipped full-size snapshots and deleted references', () => {
  const data = roomFixture(); delete data.map.slidingPuzzles;
  data.block.w = 2; install(data.world); const first = saveLayout(data);
  api.update((d) => { d.maps[0].objects[0].x = 8; }); saveLayout(data, '未选边缘排布');
  api.update((d) => { d.maps[0].objects[0].x = 2; });
  api.captureRoomReset(data.map.id, 'room');
  api.reshapeMaps([data.map.id], 1, 1, -2, 0);
  let map = api.getWorld().maps[0], room = map.rooms[0];
  assert.equal(room.layouts[0].id, first);
  assert.deepEqual([room.layouts[0].objects[0].x, room.layouts[0].objects[0].y], [3, 3]);
  assert.ok(!room.layouts[1].objects.some((o) => o.id === 'target'));
  assert.equal(room.reset.objects.find((o) => o.id === 'target').x, 3);
  api.deleteMapObject(map.id, 'other'); map = api.getWorld().maps[0]; room = map.rooms[0];
  assert.ok(room.layouts.every((l) => !l.objects.some((o) => o.id === 'other')));
  assert.ok(!room.reset.objects.some((o) => o.id === 'other'));
  api.checkWorld(api.getWorld(), true);
});

test('state list remapping updates all snapshots, then deleting selected layout clears active reference only', () => {
  const data = roomFixture(); delete data.map.slidingPuzzles;
  data.gate.state = 1; install(data.world); const id = saveLayout(data);
  api.setUI({ mode: 'prep' }); api.applyRoomLayout(data.map.id, 'room', id); api.setUI({ mode: 'edit' });
  api.setObjectStates(data.map.id, 'gate', ['开', '关']);
  let room = api.getWorld().maps[0].rooms[0];
  assert.equal(room.layouts[0].objects.find((o) => o.id === 'gate').state, 0);
  assert.equal(room.reset.objects.find((o) => o.id === 'gate').state, 0);
  api.setObjectStates(data.map.id, 'gate', ['关']);
  api.checkWorld(api.getWorld(), true);
  api.deleteRoomLayout(data.map.id, 'room', id); room = api.getWorld().maps[0].rooms[0];
  assert.equal(room.activeLayoutId, undefined); assert.equal(room.layouts.length, 0); assert.ok(room.reset);
});

test('schema checks layout IDs, active IDs, unique objects, state indices and cross-room ownership; players see none', () => {
  const data = roomFixture(); install(data.world); saveLayout(data);
  const valid = structuredClone(api.getWorld());
  for (const mutate of [
    (r) => r.layouts.push(structuredClone(r.layouts[0])),
    (r) => r.activeLayoutId = 'missing',
    (r) => r.layouts[0].objects.push(structuredClone(r.layouts[0].objects[0])),
    (r) => r.layouts[0].objects[0].state = 99,
    (r) => r.layouts[0].objects[0].id = 'missing',
    (r) => r.layouts[0].objects[0].x = 10,
  ]) {
    const bad = structuredClone(valid); mutate(bad.maps[0].rooms[0]);
    assert.throws(() => api.checkWorld(bad, true), /房间|rooms/);
  }
  const shared = structuredClone(valid), second = structuredClone(shared.maps[0].rooms[0]); second.id = 'second';
  shared.maps[0].rooms.push(second); assert.throws(() => api.checkWorld(shared, true), /共用/);
  valid.playerMapId = data.map.id;
  assert.deepEqual(api.playerWorld(valid).maps[0].rooms, []);
  assert.ok(!JSON.stringify(api.playerWorld(valid)).includes('备团说明'));
});

test('schema accepts valid metadata and older maps without puzzles', () => {
  const { world, map } = fixture(); api.checkWorld(world, true);
  delete map.slidingPuzzles; api.checkWorld(world, true);
});

test('schema rejects malformed metadata, bad references, overlapping blocks and external blockers', () => {
  const cases = [
    (m) => m.slidingPuzzles[0].x = 1.5,
    (m) => m.slidingPuzzles[0].w = 20,
    (m) => m.slidingPuzzles[0].goal.x = 7,
    (m) => m.slidingPuzzles[0].objectIds.push('missing'),
    (m) => m.slidingPuzzles[0].objectIds.push('target'),
    (m) => m.slidingPuzzles[0].targetId = 'gate',
    (m) => m.slidingPuzzles[0].gateId = 'missing',
    (m) => m.objects[2].blocksWhen = [1],
    (m) => { m.objects[2].x = 3; m.objects[2].y = 3; },
    (m) => { m.objects[1].x = 2; m.objects[1].y = 2; },
    (m) => m.objects.push(api.newObject('object', 6, 6, 1, 1)),
    (m) => m.slidingPuzzles.push(structuredClone(m.slidingPuzzles[0])),
  ];
  for (const mutate of cases) {
    const { world, map } = fixture(); mutate(map);
    assert.throws(() => api.checkWorld(world, true), /slidingPuzzles/);
  }
});


function fineFixture() {
  const world = api.emptyWorld(), map = api.newMap('细格', '测试', 0, 8, 8, 'floor', false);
  map.autoFog = false; world.maps = [map];
  map.subdivisions = Array.from({ length: 64 }, (_, i) => i);
  map.architecture = { walls: [{ id: 'wall', a: { x: 12, y: 0 }, b: { x: 12, y: 24 }, thickness: 100, material: 'wall' }], doors: [{ id: 'door', wallId: 'wall', offset: 9, width: 3, open: false }] };
  return { world, map };
}
test('old maps never subdivide automatically; rectangle and undo are one transaction', () => {
  const { world, map } = fineFixture(); delete map.subdivisions; delete map.architecture; install(world);
  assert.equal(api.getWorld().maps[0].subdivisions, undefined);
  assert.equal(api.subdivideRegion(map.id, { x: 2, y: 2, w: 2, h: 2 }), null);
  assert.deepEqual(api.getWorld().maps[0].subdivisions, [18, 19, 26, 27]);
  api.undo(); assert.equal(api.getWorld().maps[0].subdivisions, undefined);
  api.redo(); assert.equal(api.getWorld().maps[0].subdivisions.length, 4);
});
test('architecture schema rejects fractional diagonal out of range uncovered and orphan/overlap doors', () => {
  const { world } = fineFixture(); api.checkWorld(world);
  for (const mutate of [m => m.architecture.walls[0].a.x = 1.5, m => m.architecture.walls[0].b.x = 13, m => m.architecture.walls[0].b.y = 25,
    m => m.subdivisions = [], m => m.architecture.doors[0].wallId = 'missing', m => m.architecture.doors[0].offset = 23,
    m => m.architecture.doors.push({ ...m.architecture.doors[0], id: 'other' })]) {
    const w = structuredClone(world); mutate(w.maps[0]); assert.throws(() => api.checkWorld(w));
  }
});
test('thin wall and closed door block swept people and furniture; glass transmits only sight', () => {
  const { world, map } = fineFixture(); const a = { x: 3.5, y: 3.5 }, b = { x: 4.5, y: 3.5 };
  assert.equal(api.characterPathClear(world, map, a, b), false);
  assert.equal(api.architectureBlocksSight(map, a, b), true);
  map.architecture.walls[0].material = 'glass';
  assert.equal(api.architectureBlocksSight(map, { x: 3.5, y: 1.5 }, { x: 4.5, y: 1.5 }), false);
  assert.equal(api.characterPathClear(world, map, a, b), false); // solid door in glass wall
  map.architecture.doors[0].open = true;
  assert.equal(api.characterPathClear(world, map, a, b), true);
  assert.equal(api.furnitureSweepBlocked(map, { x: 2, y: 1, w: 1, h: 1 }, 5, 1), true);
  map.architecture.doors[0].width = 1;
  assert.equal(api.characterPathClear(world, map, { x: 3.5, y: 19 / 6 }, { x: 4.5, y: 19 / 6 }), false);
});
test('shared subcell wall has no corner leak and does not reveal opposite side of same main cell', () => {
  const { world, map } = fineFixture(); map.architecture.walls[0].a.x = 11; map.architecture.walls[0].b.x = 11;
  map.tokens = [{ id: 'eye', pcId: 'pc', name: '眼睛', color: '#fff', x: 3, y: 1, subcell: { x: 9, y: 4 } }];
  map.autoFog = true; install(world);
  api.update(d => { d.maps[0].tokens[0].subcell.x = 10; });
  const m = api.getWorld().maps[0];
  assert.equal(m.subFog[4 * 24 + 10], 1); assert.equal(m.subFog[4 * 24 + 11], 0);
  assert.equal(api.architectureBlocksSight(m, { x: 3, y: 0 }, { x: 4, y: 1 }), true);
  const payload = api.playerWorld(api.getWorld(), m.id).maps[0];
  assert.equal(payload.architecture, undefined);
  assert.ok(payload.architectureFragments.every(r => r.x + r.w <= 11 / 3 + 1e-8));
});
test('fine trial walk uses integer substeps and rejects full path on return to coarse center', () => {
  const { world, map } = fineFixture(); map.architecture = undefined; map.subdivisions = [27]; map.spawn = { x: 3, y: 3 };
  install(world); api.startTrial(); api.toggleCombat();
  api.trialMove(1, 0);
  let m = api.getWorld().maps[0], token = m.tokens[0];
  assert.deepEqual(token.subcell, { x: 11, y: 10 }); assert.equal(Object.values(api.getUI().trial.moved)[0], 1);
  api.trialMove(1, 0); m = api.getWorld().maps[0]; token = m.tokens[0];
  assert.equal(token.x, 4); assert.equal(token.subcell, undefined); assert.equal(Object.values(api.getUI().trial.moved)[0], 3);
  api.endTrial();
});
test('cancel subdivision refuses walls doors and subcell tokens without mutation', () => {
  const { world, map } = fineFixture(); install(world);
  assert.match(api.subdivideRegion(map.id, { x: 0, y: 0, w: 8, h: 8 }, true), /建筑/);
  api.update(d => { d.maps[0].architecture = undefined; d.maps[0].tokens = [{ id: 't', pcId: null, name: 't', color: '#fff', x: 1, y: 1, subcell: { x: 4, y: 4 } }]; });
  assert.match(api.subdivideRegion(map.id, { x: 1, y: 1, w: 1, h: 1 }, true), /棋子/);
});
test('door toggles update fine vision immediately, grey memory freezes, sandbox restores geometry', () => {
  const { world, map } = fineFixture(); map.spawn = { x: 3, y: 3 }; install(world); api.startTrial();
  assert.equal(api.getWorld().maps[0].subFog[10 * 24 + 13], 0);
  assert.equal(api.toggleArchitectureDoor(map.id, 'door'), null);
  assert.equal(api.getWorld().maps[0].subFog[10 * 24 + 13], 1);
  assert.equal(api.toggleArchitectureDoor(map.id, 'door'), null);
  assert.equal(api.getWorld().maps[0].subFog[10 * 24 + 13], 2);
  assert.ok(api.getWorld().maps[0].seen.architecture.length > 0);
  api.endTrial(); assert.equal(api.openingIsOpen(api.getWorld().maps[0].objects.find(o => o.id === 'door')), false);
});
test('reshape shifts architecture subcells and memory; copy keeps geometry but clears knowledge', () => {
  const { world, map } = fineFixture(); map.tokens = [{ id: 't', pcId: 'pc', name: 't', color: '#fff', x: 2, y: 2, subcell: { x: 7, y: 7 } }];
  map.subFog = { 175: 2 }; map.seen.subCells = { 175: 'floor' }; install(world);
  api.reshapeMaps([map.id], 1, 1, 0, 0);
  const m = api.getWorld().maps[0]; assert.equal(m.objects.find(o => o.id === 'wall').geometry.a.x, 15); assert.deepEqual(m.tokens[0].subcell, { x: 10, y: 10 });
  assert.equal(m.subFog[280], 2); assert.equal(m.seen.subCells[280], 'floor'); api.checkWorld(api.getWorld());
  api.duplicateMap(map.id); const copy = api.getWorld().maps[1];
  assert.deepEqual(copy.objects.find(o => o.geometry).geometry, m.objects.find(o => o.geometry).geometry); assert.equal(copy.objects.find(o => o.opening).opening.wallId, copy.objects.find(o => o.geometry).id); assert.notEqual(copy.objects.find(o => o.geometry).id, 'wall'); assert.deepEqual(copy.subFog, {}); assert.deepEqual(copy.seen.architecture, []);
});

test('independent fine vision uses each eye and unknown architecture never reaches sync', () => {
  const { world, map } = fineFixture(); world.visionMode = 'individual'; map.autoFog = true;
  map.tokens = [{ id: 'l', pcId: 'left', name: 'left', color: '#fff', x: 2, y: 1 }, { id: 'r', pcId: 'right', name: 'right', color: '#fff', x: 5, y: 1 }];
  install(world); api.update(d => { d.maps[0].tokens[0].y = 2; });
  const m = api.getWorld().maps[0]; assert.equal(m.views.left.subFog[4 * 24 + 16], 0); assert.equal(m.views.right.subFog[4 * 24 + 16], 1);
  const w = structuredClone(api.getWorld()); w.maps[0].tokens = [w.maps[0].tokens[0]]; w.maps[0].views = {}; w.visionMode = 'shared';
  w.maps[0].subFog = {}; w.maps[0].fog.fill(0); w.maps[0].seen = { cells: w.maps[0].cells.map(() => ''), objects: [] };
  const hidden = api.playerWorld(w, map.id).maps[0]; assert.equal(hidden.architecture, undefined); assert.deepEqual(hidden.architectureFragments, []); assert.deepEqual(hidden.subdivisions, []); assert.deepEqual(hidden.subFog, {});
});
test('sliding swept path cannot cross a thin wall and still accepts integer movement', () => {
  const { world, map, block } = fixture(); map.subdivisions = Array.from({ length: 100 }, (_, i) => i);
  map.architecture = { walls: [{ id: 'thin', a: { x: 13, y: 3 }, b: { x: 13, y: 18 }, thickness: 50, material: 'glass' }], doors: [] };
  assert.match(api.checkSlidingMove(world, map, block.id, 3, 2), /建筑/);
  assert.equal(api.checkSlidingMove(world, map, block.id, 1, 2), null);
});
test('door closing refuses occupied aperture, snapshots restore only surviving door states', () => {
  const { world, map } = fineFixture(); map.architecture.doors[0].open = true;
  map.tokens = [{ id: 't', pcId: null, name: 't', color: '#fff', x: 4, y: 3, subcell: { x: 12, y: 10 } }]; install(world);
  assert.match(api.toggleArchitectureDoor(map.id, 'door'), /有人/);
  api.update(d => { d.maps[0].tokens = []; d.maps[0].rooms = [{ id: 'room', name: 'room', color: '#fff', note: '', tags: [] }]; d.maps[0].roomCells[28] = 'room'; });
  api.captureRoomReset(map.id, 'room'); assert.equal(api.toggleArchitectureDoor(map.id, 'door'), null);
  api.resetRoom(map.id, 'room'); assert.equal(api.openingIsOpen(api.getWorld().maps[0].objects.find(o => o.id === 'door')), true);
  api.eraseArchitecture(map.id, 'wall'); api.resetRoom(map.id, 'room'); assert.deepEqual(api.getWorld().maps[0].objects.filter(o => o.geometry), []);
});
test('coarse to fine and back movement cannot cross thin walls or corner geometry', () => {
  const { world, map } = fineFixture(); map.subdivisions = [27, 28]; map.architecture = { walls: [{ id: 'w', a: { x: 10, y: 9 }, b: { x: 10, y: 12 }, thickness: 100, material: 'wall' }], doors: [] };
  map.spawn = { x: 2, y: 3 }; install(world); api.startTrial();
  const before = api.getWorld().maps[0].tokens[0]; api.trialMove(1, 0);
  assert.deepEqual(api.getWorld().maps[0].tokens[0], before); api.endTrial();
});

test('room placement rejects true wall geometry but allows nonblocking fixture symbols', () => {
  const { world, map } = fineFixture();
  const o = { ...api.newObject('object', 3, 1, 1, 1), id: 'cabinet', height: 1 }; map.objects = [o];
  assert.throws(() => api.checkRoomObjects(map, [{ id: o.id, x: 3, y: 1, state: 0 }]), /建筑/);
  o.height = 0; o.blocksWhen = [];
  assert.doesNotThrow(() => api.checkRoomObjects(map, [{ id: o.id, x: 3, y: 1, state: 0 }]));
  api.checkWorld(JSON.parse(JSON.stringify(world)));
});
test('saved fine positions and frozen architecture memory survive JSON round trip', () => {
  const { world, map } = fineFixture(); map.autoFog = true;
  map.tokens = [{ id: 't', pcId: 'pc', name: 't', color: '#fff', x: 2, y: 2, subcell: { x: 7, y: 7 } }]; install(world);
  const saved = JSON.parse(JSON.stringify(api.getWorld())); api.checkWorld(saved, true);
  assert.deepEqual(api.tokenPosition(saved.maps[0].tokens[0]), { x: 2.5, y: 2.5 });
  assert.ok(saved.maps[0].seen.architecture.length > 0); install(saved);
  assert.deepEqual(api.getWorld().maps[0].tokens[0].subcell, { x: 7, y: 7 });
});

function nativeFineFixture() {
  const f = fineFixture(); api.migrateArchitecture(f.map); return f;
}
function doorFlow(mapId, toState = 1) {
  return { id: 'door-flow', name: '门事件', mapId, edges: [], nodes: [{ id: 'door-event', title: '开门', x: 0, y: 0, kind: 'event', origin: 'predicted', status: 'predicted', effect: { mapId, objectId: 'door', toState } }] };
}
test('migration keeps stable flow IDs and folds legacy door snapshots without duplicating components', () => {
  const { world, map } = fineFixture(); world.flows = [doorFlow(map.id)];
  map.rooms = [{ id: 'room', name: 'room', color: '#fff', note: '', tags: [], reset: { at: 1, objects: [], doors: [{ id: 'door', open: true }] }, layouts: [{ id: 'l', name: 'l', objects: [], doors: [{ id: 'door', open: false }] }] }];
  install(world); const m = api.getWorld().maps[0];
  assert.equal(m.architecture, undefined); assert.deepEqual(m.objects.map(o => o.id), ['wall', 'door']);
  assert.equal(m.rooms[0].reset.doors, undefined); assert.equal(m.rooms[0].reset.objects[0].state, 1);
  assert.equal(m.rooms[0].layouts[0].objects[0].state, 0);
  api.checkWorld(api.getWorld(), true);
  const copy = structuredClone(m); api.migrateArchitecture(copy); assert.deepEqual(copy, m);
  api.setNodeStatus('door-flow', 'door-event', 'happened');
  assert.equal(api.getWorld().maps[0].objects.find(o => o.id === 'door').state, 1);
  api.setNodeStatus('door-flow', 'door-event', 'predicted');
  assert.equal(api.getWorld().maps[0].objects.find(o => o.id === 'door').state, 0);
});
test('new native door ordinary flow changes real geometry vision revisions and conditional undo', () => {
  const { world, map } = nativeFineFixture(); map.autoFog = true;
  map.tokens = [{ id: 'eye', pcId: 'pc', name: 'eye', color: '#fff', x: 3, y: 3 }]; world.flows = [doorFlow(map.id)]; install(world);
  const a = { x: 3.5, y: 3.5 }, b = { x: 4.5, y: 3.5 };
  api.setNodeStatus('door-flow', 'door-event', 'happened'); let m = api.getWorld().maps[0];
  assert.equal(api.characterPathClear(api.getWorld(), m, a, b, 'eye'), true); assert.equal(m.subFog[10 * 24 + 13], 1);
  assert.equal(m.objects.find(o => o.id === 'door').stateRev, 1); assert.equal(api.getWorld().flows[0].nodes[0].applied.rev, 1);
  api.setObjectState(map.id, 'door', 0); api.setObjectState(map.id, 'door', 1);
  api.setNodeStatus('door-flow', 'door-event', 'predicted');
  assert.equal(api.getWorld().maps[0].objects.find(o => o.id === 'door').state, 1);
});
test('flow closing and undo closing reject an occupied aperture atomically', () => {
  for (const undo of [false, true]) {
    const { world, map } = nativeFineFixture(); const door = map.objects.find(o => o.id === 'door');
    door.state = undo ? 0 : 1; world.flows = [doorFlow(map.id, undo ? 1 : 0)]; install(world);
    if (undo) api.setNodeStatus('door-flow', 'door-event', 'happened');
    api.update(d => { d.maps[0].tokens.push({ id: 't', pcId: null, name: 't', color: '#fff', x: 4, y: 3, subcell: { x: 12, y: 10 } }); });
    const before = JSON.stringify(api.getWorld());
    api.setNodeStatus('door-flow', 'door-event', undo ? 'predicted' : 'happened');
    assert.equal(JSON.stringify(api.getWorld()), before);
    assert.match(api.setObjectState(map.id, 'door', 0), /有人/);
  }
});
test('native walls have no coarse furniture collision or sight costs and open door frees aperture', () => {
  const { world, map } = nativeFineFixture(); map.objects.find(o => o.id === 'door').state = 1;
  assert.ok(api.sightCosts(world, map).every(v => v === 0));
  assert.equal(api.blocksMovement(map.objects.find(o => o.id === 'wall')), false);
  assert.equal(api.characterPathClear(world, map, { x: 4.5, y: 1.5 }, { x: 4.5, y: 2.5 }), true);
  assert.equal(api.characterPathClear(world, map, { x: 3.5, y: 3.5 }, { x: 4.5, y: 3.5 }), true);
  assert.equal(api.characterPathClear(world, map, { x: 3.5, y: 1.5 }, { x: 4.5, y: 1.5 }), false);
});
test('native components reject malformed references duplicate IDs and sliding membership', () => {
  for (const mutate of [m => m.objects[1].opening.wallId = 'missing', m => m.objects[1].opening.openStates = [9], m => m.objects[1].opening.offset = .5,
    m => m.objects[0].geometry.kind = 'diagonal', m => m.objects[0].physical = { blocksSight: 'yes' }, m => m.objects[0].pushable = true,
    m => m.objects[1].geometry = structuredClone(m.objects[0].geometry), m => m.objects[1].id = 'wall']) {
    const { world, map } = nativeFineFixture(); mutate(map); assert.throws(() => api.checkWorld(world));
  }
  const { world, map } = fineFixture(); map.objects.push({ ...api.newObject('object', 0, 0, 1, 1), id: 'wall' });
  assert.throws(() => api.migrateArchitecture(map), /冲突/); assert.throws(() => api.checkWorld(world), /ID/);
});
test('opening custom states and state-list reorder preserve geometry snapshots and flow references', () => {
  const { world, map } = nativeFineFixture(); const door = map.objects.find(o => o.id === 'door');
  door.states = ['锁住', '打开', '关上']; door.state = 1; door.opening.openStates = [1]; door.blocksWhen = [0, 2];
  world.flows = [doorFlow(map.id)]; install(world);
  api.setObjectStates(map.id, 'door', ['打开', '关上', '锁住']);
  const d = api.getWorld().maps[0].objects.find(o => o.id === 'door');
  assert.equal(d.state, 0); assert.deepEqual(d.opening.openStates, [0]); assert.equal(api.getWorld().flows[0].nodes[0].effect.toState, 0);
  assert.equal(api.architectureBlocksSight(api.getWorld().maps[0], { x: 3.5, y: 3.5 }, { x: 4.5, y: 3.5 }), false);
  api.setObjectState(map.id, 'door', 1);
  assert.equal(api.architectureBlocksSight(api.getWorld().maps[0], { x: 3.5, y: 3.5 }, { x: 4.5, y: 3.5 }), true);
});
test('physical overrides govern geometry independently and never restore a coarse blocker', () => {
  const { world, map } = nativeFineFixture(); const wall = map.objects.find(o => o.id === 'wall');
  wall.geometry.material = 'glass'; wall.physical = { blocksMove: false, blocksSight: true };
  const a = { x: 3.5, y: 1.5 }, b = { x: 4.5, y: 1.5 };
  assert.equal(api.characterPathClear(world, map, a, b), true); assert.equal(api.architectureBlocksSight(map, a, b), true);
  wall.physical = { blocksMove: true, blocksSight: false };
  assert.equal(api.characterPathClear(world, map, a, b), false); assert.equal(api.architectureBlocksSight(map, a, b), false);
  api.checkWorld(world);
});
test('native geometry sync contains only anonymous clipped fragments without hidden content or component bounds', () => {
  const { world, map } = nativeFineFixture(); map.fog.fill(1); map.subFog = Object.fromEntries(Array.from({length: 576}, (_, i) => [i, 1]));
  for (const o of map.objects) { o.notes = 'GM-only'; o.secrets = [{ id: 's-' + o.id, label: 'secret', kind: 'roll', range: 1, check: 'check', tiers: {crit:'secret', success:'secret', fail:'secret', fumble:'secret'} }]; }
  install(world); const payload = api.playerWorld(api.getWorld(), map.id).maps[0];
  assert.deepEqual(payload.objects, []); assert.deepEqual(payload.seen.objects, []); assert.ok(payload.architectureFragments.length);
  assert.ok(!JSON.stringify(payload).includes('wallId')); assert.ok(!JSON.stringify(payload).includes('GM-only'));
  assert.ok(payload.architectureFragments.every(r => Object.keys(r).sort().join(',') === 'h,material,w,x,y'));
});
test('JS project reader migrates legacy architecture for command-line consumers', async () => {
  const { writeFile, mkdir } = await import('node:fs/promises'); const { readProject } = await import('./tsmap.mjs');
  const dir = join(temp, 'legacy'); await mkdir(dir); const { world } = fineFixture();
  await writeFile(join(dir, 'world.json'), JSON.stringify(world)); const result = await readProject(dir);
  assert.equal(result.world.maps[0].architecture, undefined); assert.equal(result.world.maps[0].objects[1].opening.wallId, 'wall'); api.checkWorld(result.world);
});

test('native room layouts restore door state atomically and preserve all door content', () => {
  const { world, map } = nativeFineFixture();
  const door = map.objects.find(o => o.id === 'door'); door.notes = '主持人备注';
  const room = { id: 'room', name: 'room', color: '#fff', note: '', tags: [] }; map.rooms = [room]; map.roomCells[28] = 'room'; install(world);
  assert.equal(api.saveRoomLayout(map.id, room.id, 'closed'), null);
  const layout = api.getWorld().maps[0].rooms[0].layouts[0]; assert.deepEqual(layout.objects.map(o => o.id), ['door']);
  api.setObjectState(map.id, 'door', 1);
  api.update(d => { d.maps[0].tokens.push({ id: 't', pcId: null, name: 't', color: '#fff', x: 4, y: 3, subcell: { x: 12, y: 10 } }); });
  api.setUI({ mode: 'prep' }); const before = JSON.stringify(api.getWorld());
  assert.match(api.applyRoomLayout(map.id, room.id, layout.id), /有人/); assert.equal(JSON.stringify(api.getWorld()), before);
  api.update(d => { d.maps[0].tokens = []; }); assert.equal(api.applyRoomLayout(map.id, room.id, layout.id), null);
  assert.equal(api.getWorld().maps[0].objects.find(o => o.id === 'door').notes, '主持人备注');
  api.checkWorld(api.getWorld(), true);
});
test('sliding native door safe close prevents partial furniture and state changes', () => {
  const { world, map } = fixture(); map.subdivisions = Array.from({ length: 100 }, (_, i) => i);
  const wall = { ...api.newObject('object', 8, 0, 1, 10), id: 'wall', geometry: { kind: 'wall', a: {x:24,y:0}, b:{x:24,y:30}, thickness:100, material:'wall' } };
  map.objects.push(wall); const gate = map.objects.find(o => o.id === 'gate');
  gate.opening = { wallId: 'wall', offset: 21, width: 3, openStates: [1] }; api.migrateArchitecture(map);
  assert.equal(api.applySlidingMove(world, map, 'target', 3, 2), null);
  map.tokens.push({ id: 't', pcId: null, name: 't', color: '#fff', x: 8, y: 7, subcell: {x:24,y:22} });
  const before = structuredClone(world); assert.match(api.applySlidingMove(world, map, 'target', 2, 2), /有人/); assert.deepEqual(world, before);
});
test('component edits cannot bypass safe closing and cropped static geometry is never furniture', () => {
  const { world, map } = nativeFineFixture(); map.objects.find(o => o.id === 'door').state = 1;
  map.tokens = [{id:'t',pcId:null,name:'t',color:'#fff',x:4,y:3,subcell:{x:12,y:10}}]; install(world);
  const before = JSON.stringify(api.getWorld()); api.update(d => { d.maps[0].objects.find(o => o.id === 'door').opening.openStates = []; });
  assert.equal(JSON.stringify(api.getWorld()), before);
  api.reshapeMaps([map.id], -5, 0, 0, 0); assert.equal(JSON.stringify(api.getWorld()), before);
});


function interactiveFixture() {
  const world = api.emptyWorld(), map = api.newMap('桌游机关', '现实', 0, 12, 10, 'floor', false);
  map.autoFog = false; world.maps = [map];
  const specs = [['left-table',4,4,2,2],['right-table',6,4,2,2],['chair-a',4,3,1,1],['chair-b',7,3,1,1],['chair-c',4,6,1,1],['chair-d',7,6,1,1]];
  map.objects = specs.map(([id,x,y,w,h]) => ({...api.newObject('object',x,y,w,h),id,height:1,states:['收起','就位'],state:0}));
  const joined = map.objects.map(o=>({id:o.id,x:o.x,y:o.y,state:0}));
  const separateX = [3,7,3,7,3,7];
  const separated = joined.map((s,i)=>({...s,x:separateX[i],state:i===0?1:0}));
  const room = {id:'games',name:'桌游桌',color:'#fff',note:'',tags:[],activeLayoutId:'game-joined',reset:{at:123,objects:structuredClone(joined)},layouts:[
    {id:'game-joined',name:'合桌',interactive:true,objects:joined},
    {id:'game-separated',name:'分桌',interactive:true,objects:separated},
    {id:'prep-only',name:'普通备团排布',objects:joined},
  ]};
  map.rooms=[room]; map.roomCells.fill(room.id);
  return {world,map,room};
}

test('interactive table arrangements run atomically, keep reset, bump state revisions and undo/redo as one action', () => {
  const {world,map}=interactiveFixture(); install(world); api.setUI({mode:'run'});
  const reset=structuredClone(api.getWorld().maps[0].rooms[0].reset);
  assert.equal(api.applyRoomLayout(map.id,'games','game-separated'),null);
  let m=api.getWorld().maps[0];assert.deepEqual(m.objects.map(o=>o.x),[3,7,3,7,3,7]);
  assert.equal(m.rooms[0].activeLayoutId,'game-separated');assert.deepEqual(m.rooms[0].reset,reset);assert.equal(m.objects[0].stateRev,1);
  api.undo();m=api.getWorld().maps[0];assert.deepEqual(m.objects.map(o=>o.x),[4,6,4,7,4,7]);assert.equal(m.rooms[0].activeLayoutId,'game-joined');
  api.redo();assert.equal(api.getWorld().maps[0].objects[0].stateRev,1);
  assert.equal(api.applyRoomLayout(map.id,'games','game-joined'),null);assert.equal(api.getWorld().maps[0].objects[0].stateRev,2);
  assert.deepEqual(api.getWorld().maps[0].rooms[0].reset,reset);
  const before=api.getWorld();assert.match(api.applyRoomLayout(map.id,'games','prep-only'),/备团/);assert.equal(api.getWorld(),before);
  api.setUI({mode:'prep'});assert.equal(api.applyRoomLayout(map.id,'games','game-separated'),null);
  assert.deepEqual(api.getWorld().maps[0].rooms[0].reset.objects,api.getWorld().maps[0].rooms[0].layouts[1].objects);
});

test('interactive destination occupancy rejects the whole batch and allows edge touching and nonblocking decorations', () => {
  for (const obstacle of ['object','person','terrain','geometry']) {
    const {world,map}=interactiveFixture();
    if(obstacle==='object')map.objects.push({...api.newObject('object',3,4,1,1),id:'blocker',height:1});
    if(obstacle==='person')map.tokens.push({id:'person',pcId:null,name:'人',color:'#fff',x:3,y:4});
    if(obstacle==='terrain')map.cells[4*map.width+3]='wall';
    if(obstacle==='geometry'){
      map.subdivisions=Array.from({length:map.width*map.height},(_,i)=>i);
      map.objects.push({...api.newObject('object',3,4,1,1),id:'thin',geometry:{kind:'wall',a:{x:10,y:12},b:{x:10,y:15},thickness:100,material:'wall'}});
    }
    install(world);api.setUI({mode:'run'});const before=api.getWorld();
    assert.ok(api.applyRoomLayout(map.id,'games','game-separated'));assert.equal(api.getWorld(),before,obstacle+' must not partially move tables/chairs');
  }
  const {world,map}=interactiveFixture();
  map.objects.push(api.newObject('zone',3,4,2,2),{...api.newObject('object',3,4,1,1),height:0},
    {...api.newObject('object',3,4,1,1),height:3,blocksWhen:[]},
    {...api.newObject('object',3,4,1,1),height:3,physical:{blocksMove:false}},
    {...api.newObject('object',2,4,1,2),height:1}); // touches destination edge only
  install(world);api.setUI({mode:'run'});assert.equal(api.applyRoomLayout(map.id,'games','game-separated'),null);
  assert.equal(api.applyRoomLayout(map.id,'games','game-joined'),null); // two 2x2 tables touch, not intersect
});

test('interactive final projection permits swaps without carrying-path checks but obeys physical state blockers', () => {
  const {world,map,room}=interactiveFixture();
  room.layouts[1].objects[0].x=6;room.layouts[1].objects[1].x=4;
  install(world);api.setUI({mode:'run'});assert.equal(api.applyRoomLayout(map.id,'games','game-separated'),null);
  for(const blocker of [{height:0,physical:{blocksMove:true}},{height:0,blocksWhen:[0],state:0}]) {
    const f=interactiveFixture();f.map.objects.push({...api.newObject('object',3,4,1,1),...blocker});install(f.world);api.setUI({mode:'run'});
    assert.match(api.applyRoomLayout(f.map.id,'games','game-separated'),/相交/);
  }
});

test('interactive layout works in the current trial sandbox and ending trial restores arrangement and reset', () => {
  const {world,map}=interactiveFixture();map.spawn={x:0,y:0};install(world);api.startTrial();
  assert.equal(api.applyRoomLayout(map.id,'games','game-separated'),null);assert.equal(api.getWorld().maps[0].objects[0].x,3);
  assert.equal(api.getWorld().maps[0].rooms[0].reset.at,123);
  api.endTrial();assert.equal(api.getWorld().maps[0].objects[0].x,4);assert.equal(api.getWorld().maps[0].rooms[0].activeLayoutId,'game-joined');
  api.setUI({mode:'edit'});assert.match(api.applyRoomLayout(map.id,'games','game-separated'),/备团/);
});

test('interactive is an optional boolean in project schema; old ordinary layouts remain compatible', () => {
  const {world}=interactiveFixture();api.checkWorld(world,true);
  const malformed=structuredClone(world);malformed.maps[0].rooms[0].layouts[0].interactive='true';assert.throws(()=>api.checkWorld(malformed,true),/interactive/);
  delete world.maps[0].rooms[0].layouts[0].interactive;api.checkWorld(world,true);
});


test('room reset reconciles the active interactive layout with restored positions and state, or clears it', () => {
  const {world,map}=interactiveFixture();install(world);api.setUI({mode:'run'});
  assert.equal(api.applyRoomLayout(map.id,'games','game-separated'),null);
  api.resetRoom(map.id,'games');let m=api.getWorld().maps[0];
  assert.equal(m.rooms[0].activeLayoutId,'game-joined');assert.equal(m.objects[0].x,4);assert.equal(m.objects[0].state,0);
  api.undo();assert.equal(api.getWorld().maps[0].rooms[0].activeLayoutId,'game-separated');assert.equal(api.getWorld().maps[0].objects[0].x,3);
  api.redo();assert.equal(api.getWorld().maps[0].rooms[0].activeLayoutId,'game-joined');
  api.update(d=>{d.maps[0].rooms[0].reset.objects[0].x=1;});
  api.resetRoom(map.id,'games');m=api.getWorld().maps[0];assert.equal(m.objects[0].x,1);assert.equal(m.rooms[0].activeLayoutId,undefined);
});
