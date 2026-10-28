import { architectureWalls, architectureDoors, architectureGeometry, isArchitectureObject, architectureObjectBounds } from './architectureData.js';
export { migrateArchitecture } from './architectureData.js';
// 工程文件的结构校验。浏览器（导入、恢复备份、NPC 导入）和命令行（scripts/tsmap.mjs、open.mjs 保存）共用这一份。
// 原则：编辑器会读、会画出来的字段都要查，类型不对就拒绝（文字被换成对象会让界面崩溃，坐标太大会让循环停不下来）。
// 旧存档缺的、migrateWorld 会补上的字段（seen、views、rooms、marks、npcs、线索的 kind/range……）有就查，没有不算错。
// 纯 JS、不依赖任何东西，所以 node 和 vite 都能直接 import。

/** 媒体 ID 只能是一段安全的文件名（编辑器生成的都是这样），防止 ../ 之类越出工程目录。 */
export const safeId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);

export const MAX_SIDE = 200; // 地图、物件的边长上限（格）
export const MAX_COORD = 10000; // 坐标的绝对值上限：再大一定是坏数据（还能防止循环因为精度停不下来）

function checker(prefix) {
  const fail = (where, what) => { throw new Error(`${prefix}${where} ${what}`); };
  const c = {
    fail,
    obj(v, where) { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(where, '不是对象'); return v; },
    arr(v, where, len) {
      if (!Array.isArray(v)) fail(where, '不是列表');
      if (len !== undefined && v.length !== len) fail(where, `长度是 ${v.length}，应该是 ${len}`);
      return v;
    },
    str(v, where) { if (typeof v !== 'string') fail(where, `应该是文字，现在是 ${JSON.stringify(v)?.slice(0, 40)}`); },
    optStr(v, where) { if (v !== undefined && v !== null) c.str(v, where); },
    bool(v, where) { if (typeof v !== 'boolean') fail(where, '应该是 true / false'); },
    optBool(v, where) { if (v !== undefined) c.bool(v, where); },
    id(v, where) { if (typeof v !== 'string' || !v) fail(where, '缺少 ID'); },
    int(v, where, min = -MAX_COORD, max = MAX_COORD) {
      if (!Number.isSafeInteger(v) || v < min || v > max) fail(where, `应该是 ${min} 到 ${max} 之间的整数，现在是 ${JSON.stringify(v)}`);
    },
    num(v, where, min = -Number.MAX_VALUE, max = Number.MAX_VALUE) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(where, `应该是 ${min > -1e300 ? min : ''}${max < 1e300 ? ' 到 ' + max + ' 之间的' : ''}数字，现在是 ${JSON.stringify(v)}`);
    },
    optNum(v, where, min, max) { if (v !== undefined && v !== null) c.num(v, where, min, max); },
    oneOf(v, list, where) { if (!list.includes(v)) fail(where, `只能是 ${list.join(' / ')}，现在是 ${JSON.stringify(v)}`); },
    unique(list, where) {
      const seen = new Set();
      for (const x of list) { if (seen.has(x.id)) fail(where, `里有重复的 ID：${x.id}`); seen.add(x.id); }
    },
    strings(v, where, len) { c.arr(v, where, len).forEach((s, i) => c.str(s, `${where}[${i}]`)); },
  };
  return c;
}

/** 检查一位 NPC（整份工程里的，或者单独导入的 JSON 里的）。partial：单独导入时 id、progress 等可以缺，编辑器会补。 */
export function checkNpc(n, where, partial = false, c = checker(partial ? '' : '工程文件有问题：')) {
  c.obj(n, where);
  if (!partial) c.id(n.id, `${where}.id`); else c.optStr(n.id, `${where}.id`);
  c.str(n.name, `${where}.name`);
  for (const k of ['summary', 'icon', 'color', 'persona', 'request', 'notes', 'extra']) (partial ? c.optStr : c.str)(n[k], `${where}.${k}`);
  if (!partial || n.months !== undefined) c.arr(n.months, `${where}.months`).forEach((m, i) => c.int(m, `${where}.months[${i}]`, 1, 12));
  if (n.place != null) { c.obj(n.place, `${where}.place`); c.id(n.place.mapId, `${where}.place.mapId`); c.int(n.place.x, `${where}.place.x`); c.int(n.place.y, `${where}.place.y`); }
  if (!partial || n.returnAfterDays !== undefined) c.num(n.returnAfterDays, `${where}.returnAfterDays`, 0, 36500);
  const list = (k, fields, extra) => {
    if (partial && n[k] === undefined) return;
    c.arr(n[k], `${where}.${k}`).forEach((x, i) => {
      const at = `${where}.${k}[${i}]`;
      c.obj(x, at);
      if (!partial) c.id(x.id, `${at}.id`); else c.optStr(x.id, `${at}.id`);
      fields.forEach((f) => (partial ? c.optStr : c.str)(x[f], `${at}.${f}`));
      extra?.(x, at);
    });
    if (!partial) c.unique(n[k], `${where}.${k}`);
  };
  list('topics', ['ask', 'answer']);
  list('beats', ['text'], (b, at) => c.num(b.afterDays, `${at}.afterDays`, 0, 36500));
  list('outcomes', ['label', 'text', 'reward']);
  if (n.progress !== undefined || !partial) {
    const p = c.obj(n.progress, `${where}.progress`);
    c.oneOf(p.status, ['waiting', 'met', 'advised', 'done'], `${where}.progress.status`);
    if (partial && p.beatsDone === undefined) { /* 单独导入时可以不写，编辑器会补 */ } else c.strings(p.beatsDone, `${where}.progress.beatsDone`);
    c.optBool(p.cast, `${where}.progress.cast`);
    for (const k of ['metAt', 'advisedAt', 'doneAt']) c.optNum(p[k], `${where}.progress.${k}`);
    c.optStr(p.advice, `${where}.progress.advice`);
    c.optStr(p.outcomeId, `${where}.progress.outcomeId`);
  }
}

/**
 * 旧版输入框允许过、现在不允许的值（高度过千、楼层带小数、物件边长超过 200……）：夹回范围内，返回改了什么。
 * 只动数值范围，不动结构；结构不对的仍交给 checkWorld 报错。命令行和浏览器导入都先过这一步。
 */
export function repairWorld(w) {
  const fixed = [];
  if (!w || typeof w !== 'object' || !Array.isArray(w.maps)) return fixed;
  const clampNum = (o, k, lo, hi, what, round = false) => {
    if (!o || typeof o[k] !== 'number' || !Number.isFinite(o[k])) return;
    const v = Math.min(hi, Math.max(lo, round ? Math.round(o[k]) : o[k]));
    if (v !== o[k]) { fixed.push(`${what}：${o[k]} → ${v}`); o[k] = v; }
  };
  for (const t of Array.isArray(w.terrains) ? w.terrains : []) clampNum(t, 'visionCoef', 0, 1000, `地形「${t?.name}」的视野衰减`);
  for (const m of w.maps) {
    if (!m || typeof m !== 'object') continue;
    clampNum(m, 'floor', -1000, 1000, `地图「${m.name}」的楼层`, true);
    for (const o of Array.isArray(m.objects) ? m.objects : []) {
      clampNum(o, 'height', 0, 1000, `「${o?.name}」的高度`);
      clampNum(o, 'w', 1, MAX_SIDE, `「${o?.name}」的宽`, true);
      clampNum(o, 'h', 1, MAX_SIDE, `「${o?.name}」的高`, true);
      for (const s of Array.isArray(o?.secrets) ? o.secrets : []) clampNum(s, 'range', 0, MAX_SIDE * 2, `「${o?.name}」线索的距离`, true);
    }
    // 记忆里的快照（全队的、每个人的）是旧版本存下的，同样可能超范围
    const memories = [m.seen, ...Object.values(m.views && typeof m.views === 'object' ? m.views : {}).map((L) => L?.seen)];
    for (const mem of memories) for (const r of Array.isArray(mem?.objects) ? mem.objects : []) {
      clampNum(r, 'height', 0, 1000, `记忆里「${r?.name}」的高度`);
      clampNum(r, 'w', 1, MAX_SIDE, `记忆里「${r?.name}」的宽`, true);
      clampNum(r, 'h', 1, MAX_SIDE, `记忆里「${r?.name}」的高`, true);
    }
  }
  for (const n of Array.isArray(w.npcs) ? w.npcs : []) {
    clampNum(n, 'returnAfterDays', 0, 36500, `NPC「${n?.name}」的回访天数`);
    for (const b of Array.isArray(n?.beats) ? n.beats : []) clampNum(b, 'afterDays', 0, 36500, `NPC「${n?.name}」近况的天数`);
  }
  return fixed;
}

/** 纯 JS 建筑校验，命令行与编辑器都拒绝悬空门洞和未细分墙。 */
export function checkArchitecture(m) {
  const c = checker('建筑数据有问题：');
  const subs = new Set();
  for (const i of m.subdivisions ?? []) { c.int(i, 'subdivisions', 0, m.width * m.height - 1); if (subs.has(i)) c.fail('subdivisions', '索引重复'); subs.add(i); }
  if (m.architecture) { c.obj(m.architecture, 'architecture'); c.arr(m.architecture.walls, 'walls'); c.arr(m.architecture.doors, 'doors'); }
  const walls = architectureWalls(m), doors = architectureDoors(m);
  c.unique([...(m.objects ?? []), ...(m.architecture?.walls ?? []), ...(m.architecture?.doors ?? [])], 'objects / architecture');
  c.unique(walls, 'walls'); c.unique(doors, 'doors');
  for (const w of walls) {
    c.obj(w, 'wall'); c.id(w.id, 'wall.id'); c.oneOf(w.material, ['wall', 'glass'], 'material'); c.num(w.thickness, 'thickness', 1, 750);
    for (const p of [w.a, w.b]) { c.obj(p, '端点'); c.int(p.x, '端点.x', 0, m.width * 3); c.int(p.y, '端点.y', 0, m.height * 3); }
    if ((w.a.x !== w.b.x && w.a.y !== w.b.y) || (w.a.x === w.b.x && w.a.y === w.b.y)) c.fail(w.id, '墙必须是非零轴对齐线段');
    const len = Math.abs(w.b.x - w.a.x) + Math.abs(w.b.y - w.a.y);
    for (let i = 0; i < len; i++) {
      const x = w.a.x + (i + .5) * Math.sign(w.b.x - w.a.x), y = w.a.y + (i + .5) * Math.sign(w.b.y - w.a.y);
      const candidates = w.a.x === w.b.x ? [[Math.floor(x / 3 - 1e-7), Math.floor(y / 3)], [Math.floor(x / 3), Math.floor(y / 3)]] : [[Math.floor(x / 3), Math.floor(y / 3 - 1e-7)], [Math.floor(x / 3), Math.floor(y / 3)]];
      if (!candidates.some(([cx, cy]) => cx >= 0 && cy >= 0 && cx < m.width && cy < m.height && subs.has(cy * m.width + cx))) c.fail(w.id, '墙经过未细分区域');
    }
  }
  for (const d of doors) {
    c.obj(d, 'door'); c.id(d.id, 'door.id'); c.id(d.wallId, 'door.wallId'); c.int(d.offset, 'door.offset', 0); c.int(d.width, 'door.width', 1); c.bool(d.open, 'door.open');
    const w = walls.find(w => w.id === d.wallId);
    if (!w) c.fail(d.id, '门洞找不到所属墙');
    const len = Math.abs(w.b.x - w.a.x) + Math.abs(w.b.y - w.a.y);
    if (d.offset + d.width > len) c.fail(d.id, '门洞超出墙段');
    if (doors.some(b => b !== d && b.wallId === d.wallId && d.offset < b.offset + b.width && b.offset < d.offset + d.width)) c.fail(d.id, '门洞重叠');
  }
}

/** 校验整批快照的最终摆位；先投影所有物件，再查滑块，允许互换位置。 */
export function checkRoomObjects(map, snapshots) {
  const c = checker('房间排布有问题：');
  const list = c.arr(snapshots, 'objects');
  c.unique(list, 'objects');
  const changes = new Map();
  for (const s of list) {
    c.obj(s, '物件快照'); c.id(s.id, '物件快照.id');
    const o = map.objects.find((o) => o.id === s.id && o.kind === 'object');
    if (!o) c.fail('objects', `找不到本图物件：${s.id}`);
    c.int(s.x, `${o.name}.x`, 0); c.int(s.y, `${o.name}.y`, 0);
    c.int(s.state, `${o.name}.state`, 0, o.states.length - 1);
    if (s.x + o.w > map.width || s.y + o.h > map.height) c.fail(o.name, '完整尺寸超出地图边界');
    if (isArchitectureObject(o) && (s.x !== o.x || s.y !== o.y)) c.fail(o.name, '静态建筑不能按家具移动');
    changes.set(s.id, s);
  }
  const objects = map.objects.map((o) => ({ ...o, ...changes.get(o.id) }));
  for (const snap of list) {
    const o = objects.find(o => o.id === snap.id);
    if (!(o.physical?.blocksMove ?? (o.blocksWhen ? o.blocksWhen.includes(o.state) : o.height >= .5))) continue;
    if (isArchitectureObject(o)) continue;
    for (const r of architectureGeometry({ ...map, objects }).filter(r => r.blocksMove)) {
      if (o.x < r.x + r.w && o.x + o.w > r.x && o.y < r.y + r.h && o.y + o.h > r.y) c.fail(o.name, '排布与建筑墙/关闭的门相交');
    }
  }
  const members = new Set(map.slidingPuzzles?.flatMap((p) => p.objectIds));
  const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  for (const p of map.slidingPuzzles ?? []) for (const id of p.objectIds) {
    const o = objects.find((o) => o.id === id);
    if (!o || o.x < p.x || o.y < p.y || o.x + o.w > p.x + p.w || o.y + o.h > p.y + p.h ||
      o.x < 0 || o.y < 0 || o.x + o.w > map.width || o.y + o.h > map.height) c.fail(p.name, '滑块超出棋盘边界');
    if (objects.some((b) => b.id !== o.id && b.kind === 'object' && !isArchitectureObject(b) &&
      (members.has(b.id) || (b.physical?.blocksMove ?? (b.blocksWhen ? b.blocksWhen.includes(b.state) : b.height >= 0.5))) && overlap(o, b))) c.fail(p.name, '滑块与其它滑块或挡路物件相交');
  }
}

/**
 * 检查整份工程，有问题就抛出一句能看懂的错误（带出错的位置）。
 * migrated = true：浏览器里迁移（补旧字段）之后再查一遍，这时旧字段都必须在（编辑器直接用它们）。
 */
export function checkWorld(w, migrated = false) {
  const c = checker('工程文件有问题：');
  const { fail, obj, arr, str, optStr, bool, optBool, id, int, num, optNum, oneOf, unique, strings } = c;
  const fogs = (v, where, len) => arr(v, where, len).forEach((f, i) => { if (f !== 0 && f !== 1 && f !== 2) fail(`${where}[${i}]`, `迷雾只能是 0/1/2，现在是 ${JSON.stringify(f)}`); });
  const endpoint = (e, where) => { obj(e, where); str(e.mapId, `${where}.mapId`); int(e.x, `${where}.x`); int(e.y, `${where}.y`); };
  const seenObjects = (v, where) => arr(v, where).forEach((o, i) => {
    const at = `${where}[${i}]`;
    obj(o, at); id(o.id, `${at}.id`); str(o.name, `${at}.name`); str(o.icon, `${at}.icon`); str(o.color, `${at}.color`);
    int(o.x, `${at}.x`); int(o.y, `${at}.y`); int(o.w, `${at}.w`, 1, MAX_SIDE); int(o.h, `${at}.h`, 1, MAX_SIDE); num(o.height, `${at}.height`, 0, 1000);
    if (o.stateLabel !== null) str(o.stateLabel, `${at}.stateLabel`);
  });
  const fragments = (v, where) => arr(v, where).forEach(r => { obj(r, where); for (const k of ['x', 'y', 'w', 'h']) num(r[k], `${where}.${k}`, k === 'w' || k === 'h' ? .0000001 : -MAX_COORD, MAX_COORD); oneOf(r.material, ['wall', 'glass', 'door', 'opening'], where); });
  const memory = (v, where, n) => {
    obj(v, where); strings(v.cells, `${where}.cells`, n); seenObjects(v.objects, `${where}.objects`);
    if (v.cellRevs !== undefined) arr(v.cellRevs, `${where}.cellRevs`).forEach(r => int(r, `${where}.cellRevs`, 0, Number.MAX_SAFE_INTEGER));
    for (const field of ['observed', 'objectRevs', 'subRevs', 'architectureRevs']) if (v[field] !== undefined) for (const [key, value] of Object.entries(obj(v[field], `${where}.${field}`))) {
      if (field !== 'objectRevs') int(+key, `${where}.observed key`, 0, n * 9 - 1);
      int(value, `${where}.${field}`, 0, Number.MAX_SAFE_INTEGER);
    }
    if (v.architecture !== undefined) fragments(v.architecture, `${where}.architecture`);
    if (v.subCells !== undefined) for (const [key, value] of Object.entries(obj(v.subCells, `${where}.subCells`))) { int(+key, `${where}.subCells key`, 0, n * 9 - 1); str(value, `${where}.subCells value`); }
  };

  obj(w, '工程');
  if (w.version !== 1) fail('version', '不是 1（不是这个编辑器的工程文件）');
  str(w.name, 'name');
  arr(w.terrains, 'terrains').forEach((t, i) => {
    const at = `terrains[${i}]`;
    obj(t, at); id(t.id, `${at}.id`); str(t.name, `${at}.name`); str(t.color, `${at}.color`); bool(t.blocksMove, `${at}.blocksMove`); num(t.visionCoef, `${at}.visionCoef`, 0, 1000);
  });
  unique(w.terrains, 'terrains');
  if (!arr(w.maps, 'maps').length) fail('maps', '是空的（至少要有一张地图）');
  unique(w.maps, 'maps');
  w.maps.forEach((m, mi) => {
    const at = `地图「${typeof m?.name === 'string' ? m.name : mi}」`;
    obj(m, at); id(m.id, `${at}.id`); str(m.name, `${at}.name`); str(m.layer, `${at}.layer`); int(m.floor, `${at}.floor`, -1000, 1000); str(m.notes, `${at}.notes`);
    int(m.width, `${at}.width`, 1, MAX_SIDE); int(m.height, `${at}.height`, 1, MAX_SIDE);
    const n = m.width * m.height;
    if (m.subdivisions !== undefined) arr(m.subdivisions, `${at}.subdivisions`);
    checkArchitecture(m);
    if (m.architectureFragments !== undefined) fragments(m.architectureFragments, `${at}.architectureFragments`);
    const checkSubFog = (L, at) => {
      if (L.subFog !== undefined) for (const [key, v] of Object.entries(obj(L.subFog, at))) {
        const k = +key; int(k, at, 0, n * 9 - 1);
        if (![0, 1, 2].includes(v)) fail(at, '子格迷雾只能是 0/1/2');
        const sx = k % (m.width * 3), sy = Math.floor(k / (m.width * 3));
        if (!m.subdivisions?.includes(Math.floor(sy / 3) * m.width + Math.floor(sx / 3))) fail(at, '子格迷雾不在细分区域');
      }
    };
    checkSubFog(m, `${at}.subFog`);
    for (const L of Object.values(m.views ?? {})) checkSubFog(L, `${at}.views.subFog`);
    strings(m.cells, `${at}.cells`, n);
    arr(m.d100, `${at}.d100`, n).forEach((v, i) => num(v, `${at}.d100[${i}]`));
    fogs(m.fog, `${at}.fog`, n);
    optBool(m.autoFog, `${at}.autoFog`);
    if (migrated) for (const k of ['roomCells', 'seen', 'views', 'rooms']) if (m[k] === undefined) fail(`${at}.${k}`, '缺失');
    if (m.roomCells !== undefined) strings(m.roomCells, `${at}.roomCells`, n);
    if (m.seen !== undefined) memory(m.seen, `${at}.seen`, n);
    if (m.views !== undefined) Object.entries(obj(m.views, `${at}.views`)).forEach(([pc, L]) => {
      obj(L, `${at}.views.${pc}`); fogs(L.fog, `${at}.views.${pc}.fog`, n); memory(L.seen, `${at}.views.${pc}.seen`, n);
    });
    if (m.rooms !== undefined) {
      arr(m.rooms, `${at}.rooms`).forEach((r, i) => {
        const ra = `${at}.rooms[${i}]`; obj(r, ra); id(r.id, `${ra}.id`); str(r.name, `${ra}.name`); str(r.color, `${ra}.color`); str(r.note, `${ra}.note`); strings(r.tags, `${ra}.tags`);
        if (r.reset !== undefined) {
          const rs = `${ra}.reset`;
          obj(r.reset, rs); num(r.reset.at, `${rs}.at`, 0);
          if (r.reset.doors !== undefined) { arr(r.reset.doors, `${rs}.doors`).forEach(d => { obj(d, rs); id(d.id, rs); bool(d.open, rs); }); unique(r.reset.doors, `${rs}.doors`); }
          arr(r.reset.objects, `${rs}.objects`).forEach((s, k) => {
            const sa = `${rs}.objects[${k}]`;
            obj(s, sa); id(s.id, `${sa}.id`); int(s.x, `${sa}.x`); int(s.y, `${sa}.y`); int(s.state, `${sa}.state`, 0);
          });
        }
      });
      unique(m.rooms, `${at}.rooms`);
    }
    if (m.spawn != null) { obj(m.spawn, `${at}.spawn`); int(m.spawn.x, `${at}.spawn.x`); int(m.spawn.y, `${at}.spawn.y`); }
    optStr(m.variantOf, `${at}.variantOf`);
    arr(m.objects, `${at}.objects`).forEach((o, i) => {
      const oa = `${at}.objects[${i}]（${typeof o?.name === 'string' ? o.name : ''}）`;
      obj(o, oa); id(o.id, `${oa}.id`); str(o.name, `${oa}.name`); oneOf(o.kind, ['object', 'zone'], `${oa}.kind`);
      int(o.x, `${oa}.x`); int(o.y, `${oa}.y`); int(o.w, `${oa}.w`, 1, MAX_SIDE); int(o.h, `${oa}.h`, 1, MAX_SIDE);
      num(o.height, `${oa}.height`, 0, 1000); str(o.color, `${oa}.color`); str(o.icon, `${oa}.icon`); str(o.notes, `${oa}.notes`); bool(o.hidden, `${oa}.hidden`);
      strings(o.states, `${oa}.states`);
      if (!o.states.length) fail(`${oa}.states`, '是空的（至少要有一个状态）');
      int(o.state, `${oa}.state`, 0, o.states.length - 1);
      if (o.blocksWhen !== undefined) arr(o.blocksWhen, `${oa}.blocksWhen`).forEach((v, k) => int(v, `${oa}.blocksWhen[${k}]`, 0, o.states.length - 1));
      if (o.geometry !== undefined) {
        obj(o.geometry, `${oa}.geometry`); oneOf(o.geometry.kind, ['wall'], `${oa}.geometry.kind`);
      }
      if (o.opening !== undefined) {
        obj(o.opening, `${oa}.opening`);
        arr(o.opening.openStates, `${oa}.opening.openStates`).forEach(i => int(i, `${oa}.opening.openStates`, 0, o.states.length - 1));
        if (new Set(o.opening.openStates).size !== o.opening.openStates.length) fail(oa, '打开状态重复');
      }
      if (isArchitectureObject(o) && (o.kind !== 'object' || o.geometry && o.opening || o.pushable || o.heavy)) fail(oa, '建筑组件必须是静态物件，不能同时是墙和门洞');
      if (o.physical !== undefined) { obj(o.physical, `${oa}.physical`); optBool(o.physical.blocksMove, `${oa}.physical.blocksMove`); optBool(o.physical.blocksSight, `${oa}.physical.blocksSight`); }
      optBool(o.pushable, `${oa}.pushable`);
      optBool(o.heavy, `${oa}.heavy`);
      optNum(o.stateRev, `${oa}.stateRev`);
      arr(o.secrets, `${oa}.secrets`).forEach((s, k) => {
        const sa = `${oa}.secrets[${k}]`;
        obj(s, sa); id(s.id, `${sa}.id`); str(s.label, `${sa}.label`); str(s.check, `${sa}.check`);
        if (s.kind !== undefined) oneOf(s.kind, ['auto', 'roll'], `${sa}.kind`);
        if (s.range !== undefined) int(s.range, `${sa}.range`, 0, MAX_SIDE * 2);
        obj(s.tiers, `${sa}.tiers`); for (const t of ['crit', 'success', 'fail', 'fumble']) str(s.tiers[t], `${sa}.tiers.${t}`);
        if (s.discoveries !== undefined) for (const value of Object.values(obj(s.discoveries, `${sa}.discoveries`))) { obj(value, sa); oneOf(value.tier, ['crit', 'success', 'fail', 'fumble'], sa); num(value.at, sa); }
        if (s.revealed !== undefined) {
          obj(s.revealed, `${sa}.revealed`); oneOf(s.revealed.tier, ['crit', 'success', 'fail', 'fumble'], `${sa}.revealed.tier`);
          if (s.revealed.recipients !== undefined) strings(s.revealed.recipients, `${sa}.revealed.recipients`);
          oneOf(s.revealed.scope, ['party', 'private'], `${sa}.revealed.scope`); optStr(s.revealed.to, `${sa}.revealed.to`); num(s.revealed.at, `${sa}.revealed.at`);
        }
      });
      unique(o.secrets, `${oa}.secrets`);
      arr(o.media, `${oa}.media`).forEach((a, k) => {
        const aa = `${oa}.media[${k}]`;
        obj(a, aa); id(a.id, `${aa}.id`); id(a.mediaId, `${aa}.mediaId`); str(a.label, `${aa}.label`); oneOf(a.trigger, ['manual', 'enter'], `${aa}.trigger`);
        bool(a.broadcast, `${aa}.broadcast`); bool(a.once, `${aa}.once`); optBool(a.fired, `${aa}.fired`);
      });
    });
    unique(m.objects, `${at}.objects`);
    if (m.slidingPuzzles !== undefined) {
      const puzzles = arr(m.slidingPuzzles, `${at}.slidingPuzzles`);
      const members = new Set(), gates = new Set();
      const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      const within = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
      const mapBox = { x: 0, y: 0, w: m.width, h: m.height };
      puzzles.forEach((p, i) => {
        const pa = `${at}.slidingPuzzles[${i}]`;
        obj(p, pa); id(p.id, `${pa}.id`); str(p.name, `${pa}.name`);
        int(p.x, `${pa}.x`, 0); int(p.y, `${pa}.y`, 0); int(p.w, `${pa}.w`, 1, MAX_SIDE); int(p.h, `${pa}.h`, 1, MAX_SIDE);
        if (!within(p, mapBox)) fail(pa, '棋盘超出地图边界');
        strings(p.objectIds, `${pa}.objectIds`);
        if (!p.objectIds.length) fail(`${pa}.objectIds`, '至少需要一个滑块');
        const goalFields = [p.targetId, p.goal, p.gateId].filter((v) => v !== undefined).length;
        if (goalFields !== 0 && goalFields !== 3) fail(pa, 'targetId、goal、gateId 必须全有或全无');
        if (goalFields === 3) {
          id(p.targetId, `${pa}.targetId`); id(p.gateId, `${pa}.gateId`);
          obj(p.goal, `${pa}.goal`); int(p.goal.x, `${pa}.goal.x`, 0); int(p.goal.y, `${pa}.goal.y`, 0);
        }
        const blocks = p.objectIds.map((oid) => {
          const block = m.objects.find((o) => o.id === oid && o.kind === 'object');
          if (!block || isArchitectureObject(block)) fail(`${pa}.objectIds`, `找不到本图的物件：${oid}`);
          if (members.has(oid)) fail(`${pa}.objectIds`, `滑块重复或属于多个棋盘：${oid}`);
          members.add(oid);
          if (!within(block, p)) fail(pa, `滑块「${block.name}」超出棋盘边界`);
          return block;
        });
        if (goalFields === 3) {
          const target = blocks.find((o) => o.id === p.targetId);
          if (!target) fail(`${pa}.targetId`, '目标必须是棋盘里的滑块');
          if (!within({ ...target, ...p.goal }, p)) fail(`${pa}.goal`, '目标位置放不下目标块');
          const gate = m.objects.find((o) => o.id === p.gateId && o.kind === 'object');
          if (!gate || gate.states.length < 2 || gate.blocksWhen?.length !== 1 || gate.blocksWhen[0] !== 0) fail(`${pa}.gateId`, '门必须是本图物件，具有状态 0/1 且 blocksWhen=[0]');
          if (gates.has(p.gateId)) fail(`${pa}.gateId`, '不同棋盘不能共用一扇门');
          gates.add(p.gateId);
          if (overlaps(p, isArchitectureObject(gate) ? architectureObjectBounds(m, gate) : gate)) fail(`${pa}.gateId`, '门必须放在棋盘外');
        }
        blocks.forEach((block, j) => {
          if (blocks.slice(j + 1).some((o) => overlaps(block, o))) fail(pa, '滑块不能相交');
        });
        if (m.objects.some((o) => o.kind === 'object' && !isArchitectureObject(o) && !p.objectIds.includes(o.id) &&
          (o.physical?.blocksMove ?? (o.blocksWhen ? o.blocksWhen.includes(o.state) : o.height >= 0.5)) && overlaps(p, o))) fail(pa, '棋盘范围内不能有其它挡路物件');
      });
      unique(puzzles, `${at}.slidingPuzzles`);
      if ([...gates].some((gid) => members.has(gid))) fail(`${at}.slidingPuzzles`, '门不能同时是滑块');
    }
    const owners = new Map();
    for (const r of m.rooms ?? []) {
      const ra = `${at}.rooms「${r.name}」`;
      const snapshots = [];
      if (r.reset) snapshots.push(r.reset.objects);
      if (r.layouts !== undefined) {
        arr(r.layouts, `${ra}.layouts`).forEach((layout, i) => {
          const la = `${ra}.layouts[${i}]`;
          obj(layout, la); id(layout.id, `${la}.id`); str(layout.name, `${la}.name`);
          if (layout.description !== undefined) str(layout.description, `${la}.description`);
          if (layout.doors !== undefined) { arr(layout.doors, `${la}.doors`).forEach(d => { obj(d, la); id(d.id, la); bool(d.open, la); }); unique(layout.doors, `${la}.doors`); }
          arr(layout.objects, `${la}.objects`);
          snapshots.push(layout.objects);
        });
        unique(r.layouts, `${ra}.layouts`);
      }
      if (r.activeLayoutId !== undefined) {
        id(r.activeLayoutId, `${ra}.activeLayoutId`);
        if (!r.layouts?.some((l) => l.id === r.activeLayoutId)) fail(`${ra}.activeLayoutId`, '找不到本房间的排布');
      }
      for (const objects of snapshots) {
        const doorStates = r.reset?.objects === objects ? r.reset.doors : r.layouts?.find(l => l.objects === objects)?.doors;
        const projected = doorStates && m.architecture ? { ...m, architecture: { ...m.architecture, doors: m.architecture.doors.map(d => ({ ...d, open: doorStates.find(s => s.id === d.id)?.open ?? d.open })) } } : m;
        try { checkRoomObjects(projected, objects); } catch (e) { fail(ra, e.message); }
        for (const s of objects) {
          if (owners.has(s.id) && owners.get(s.id) !== r.id) fail(ra, `物件被其它房间的排布或复位点共用：${s.id}`);
          owners.set(s.id, r.id);
        }
      }
    }
    arr(m.tokens, `${at}.tokens`).forEach((t, i) => {
      const ta = `${at}.tokens[${i}]`;
      obj(t, ta); id(t.id, `${ta}.id`); str(t.name, `${ta}.name`); str(t.color, `${ta}.color`); int(t.x, `${ta}.x`); int(t.y, `${ta}.y`);
      if (t.subcell !== undefined) {
        obj(t.subcell, `${ta}.subcell`); int(t.subcell.x, `${ta}.subcell.x`, 0, m.width * 3 - 1); int(t.subcell.y, `${ta}.subcell.y`, 0, m.height * 3 - 1);
        if (Math.floor(t.subcell.x / 3) !== t.x || Math.floor(t.subcell.y / 3) !== t.y || !m.subdivisions?.includes(t.y * m.width + t.x)) fail(ta, '子格位置与主格锚点/细分范围不一致');
      }
      if (t.pcId !== null) str(t.pcId, `${ta}.pcId`);
      if (t.status !== undefined) { obj(t.status, `${ta}.status`); str(t.status.label, `${ta}.status.label`); optNum(t.status.endsAt, `${ta}.status.endsAt`); optNum(t.status.roundsLeft, `${ta}.status.roundsLeft`); }
    });
    unique(m.tokens, `${at}.tokens`);
  });
  arr(w.connections, 'connections').forEach((cn, i) => {
    const ca = `connections[${i}]`;
    obj(cn, ca); id(cn.id, `${ca}.id`); oneOf(cn.kind, ['stairs', 'portal', 'door', 'other'], `${ca}.kind`); str(cn.label, `${ca}.label`); bool(cn.hidden, `${ca}.hidden`);
    endpoint(cn.a, `${ca}.a`); endpoint(cn.b, `${ca}.b`);
  });
  unique(w.connections, 'connections');
  arr(w.party, 'party').forEach((p, i) => { obj(p, `party[${i}]`); id(p.id, `party[${i}].id`); str(p.name, `party[${i}].name`); str(p.color, `party[${i}].color`); strings(p.tags, `party[${i}].tags`); });
  unique(w.party, 'party');
  if (w.visionGroups !== undefined) {
    arr(w.visionGroups, 'visionGroups').forEach(g => { obj(g, 'visionGroups'); id(g.id, 'visionGroups.id'); str(g.name, 'visionGroups.name'); });
    unique(w.visionGroups, 'visionGroups');
  }
  for (const p of w.party) if (p.visionGroupId !== undefined && p.visionGroupId !== null) {
    id(p.visionGroupId, 'party.visionGroupId');
    if (!(w.visionGroups ?? []).some(g => g.id === p.visionGroupId)) fail('party.visionGroupId', '视野组不存在');
  }
  if (w.observationSeq !== undefined) int(w.observationSeq, 'observationSeq', 0, Number.MAX_SAFE_INTEGER);
  if (w.flows !== undefined || w.lines === undefined) {
    arr(w.flows, 'flows').forEach((f, i) => {
      const fa = `流程图「${typeof f?.name === 'string' ? f.name : i}」`;
      obj(f, fa); id(f.id, `${fa}.id`); str(f.name, `${fa}.name`); if (f.mapId !== null) str(f.mapId, `${fa}.mapId`);
      arr(f.nodes, `${fa}.nodes`).forEach((n, k) => {
        const na = `${fa}.nodes[${k}]`;
        obj(n, na); id(n.id, `${na}.id`); str(n.title, `${na}.title`); num(n.x, `${na}.x`, -1e6, 1e6); num(n.y, `${na}.y`, -1e6, 1e6);
        oneOf(n.kind, ['start', 'event', 'ending'], `${na}.kind`); oneOf(n.origin, ['predicted', 'record'], `${na}.origin`); oneOf(n.status, ['predicted', 'happened'], `${na}.status`);
        if (n.source !== undefined) oneOf(n.source, ['ai'], `${na}.source`);
        optNum(n.at, `${na}.at`); optNum(n.session, `${na}.session`); optStr(n.via, `${na}.via`);
        if (n.effect != null) { obj(n.effect, `${na}.effect`); str(n.effect.mapId, `${na}.effect.mapId`); str(n.effect.objectId, `${na}.effect.objectId`); int(n.effect.toState, `${na}.effect.toState`, 0, 10000); }
        if (n.applied !== undefined) { const a = obj(n.applied, `${na}.applied`); str(a.mapId, `${na}.applied.mapId`); str(a.objectId, `${na}.applied.objectId`); int(a.from, `${na}.applied.from`, 0, 10000); int(a.to, `${na}.applied.to`, 0, 10000); optNum(a.rev, `${na}.applied.rev`); }
      });
      unique(f.nodes, `${fa}.nodes`);
      arr(f.edges, `${fa}.edges`).forEach((e, k) => {
        const ea = `${fa}.edges[${k}]`;
        obj(e, ea); id(e.id, `${ea}.id`); id(e.from, `${ea}.from`); id(e.to, `${ea}.to`); str(e.label, `${ea}.label`); str(e.condition, `${ea}.condition`);
        if (e.chance !== null) num(e.chance, `${ea}.chance`, 0, 100);
      });
      unique(f.edges, `${fa}.edges`);
    });
    unique(w.flows, 'flows');
  }
  arr(w.log, 'log').forEach((e, i) => {
    obj(e, `log[${i}]`); id(e.id, `log[${i}].id`); num(e.at, `log[${i}].at`); num(e.session, `log[${i}].session`); str(e.kind, `log[${i}].kind`); str(e.text, `log[${i}].text`); optStr(e.mapId, `log[${i}].mapId`);
  });
  arr(w.media, 'media').forEach((m, i) => {
    obj(m, `media[${i}]`);
    if (!safeId(m.id)) fail(`media[${i}].id`, `不合法：${JSON.stringify(m.id)}`);
    str(m.name, `media[${i}].name`); str(m.mime, `media[${i}].mime`); num(m.size, `media[${i}].size`, 0);
    if (m.key !== undefined && !(typeof m.key === 'string' && /^v:[A-Za-z0-9]{1,80}$/.test(m.key))) fail(`media[${i}].key`, `不合法：${JSON.stringify(m.key)}`);
  });
  unique(w.media, 'media');
  num(w.session, 'session');
  if (w.playerMapId !== null && w.playerMapId !== undefined) str(w.playerMapId, 'playerMapId');
  if (w.visionMode !== undefined) oneOf(w.visionMode, ['shared', 'individual', 'grouped'], 'visionMode');
  if (w.marks !== undefined) arr(w.marks, 'marks').forEach((k, i) => {
    const ka = `marks[${i}]`;
    obj(k, ka); id(k.id, `${ka}.id`); str(k.mapId, `${ka}.mapId`); int(k.x, `${ka}.x`); int(k.y, `${ka}.y`); str(k.author, `${ka}.author`);
    str(k.symbol, `${ka}.symbol`); str(k.text, `${ka}.text`); num(k.createdAt, `${ka}.createdAt`); num(k.life, `${ka}.life`, 0);
  });
  if (migrated) for (const k of ['marks', 'npcs', 'flows']) if (w[k] === undefined) fail(k, '缺失');
  if (w.npcs !== undefined) {
    arr(w.npcs, 'npcs').forEach((n, i) => checkNpc(n, `NPC「${typeof n?.name === 'string' ? n.name : i}」`, !migrated, c)); // 迁移前宽一点（旧存档缺的字段迁移会补），迁移后严格
    unique(w.npcs, 'npcs');
  }
}

/** 工程里声明了、却没有对应文件的媒体（has(id) 判断文件在不在）。 */
export function missingMedia(w, has) {
  return (w.media ?? []).filter((m) => !has(m.id));
}
