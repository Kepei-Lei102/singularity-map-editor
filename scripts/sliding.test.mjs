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
  stdin: { contents: `export * from './src/sliding'; export * from './src/defaults'; export * from './src/schema.js'; export * from './src/store'; export * from './src/actions'; export * from './src/trial'; export { playerWorld } from './src/sync';`, resolveDir: root },
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
