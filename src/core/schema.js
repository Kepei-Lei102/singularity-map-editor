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
    // 高度数组：长度不对就重建成对的长度，数值超范围/带小数就夹回去。
    if (Array.isArray(m.heights)) {
      const want = (Number(m.width) || 0) * (Number(m.height) || 0);
      if (want > 0 && m.heights.length !== want) {
        fixed.push(`地图「${m.name}」的高度数组长度 ${m.heights.length} → ${want}`);
        const old = m.heights;
        m.heights = Array.from({ length: want }, (_, i) => (typeof old[i] === 'number' && Number.isFinite(old[i]) ? old[i] : 0));
      }
      for (let i = 0; i < m.heights.length; i++) {
        const raw = m.heights[i];
        const v = Math.max(-8, Math.min(24, Math.round(Number.isFinite(raw) ? raw : 0)));
        if (v !== raw) { fixed.push(`地图「${m.name}」第 ${i} 格高度：${raw} → ${v}`); m.heights[i] = v; }
      }
    }
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
  // 事件账本：不是数组就清掉，形状不对的条目丢掉，超过 200 条只留最近的。
  if (w.events !== undefined) {
    if (!Array.isArray(w.events)) { delete w.events; fixed.push('事件账本不是数组，已清空'); }
    else {
      // 丢弃面跟 checkWorld 保持同一张单子：缺字段/枚举错的条目在这里就该掉，别等到校验整份存档时才炸。
      const KINDS = new Set(['hp', 'me', 'moved', 'status', 'points', 'object']);
      const attrsOk = (a) => a && typeof a === 'object' && typeof a.attr === 'string'
        && ['single', 'advantage', 'disadvantage'].includes(a.dice)
        && typeof a.value === 'number'
        && (a.roll === undefined || a.roll === null || typeof a.roll === 'number')
        && (a.used === undefined || a.used === null || typeof a.used === 'number')
        && (a.total === undefined || a.total === null || typeof a.total === 'number')
        && (a.rolls === undefined || (Array.isArray(a.rolls) && a.rolls.every((v) => typeof v === 'number' && Number.isFinite(v))))
        && (a.success === undefined || typeof a.success === 'boolean')
        && (a.tier === undefined || a.tier === null || a.tier === 'crit' || a.tier === 'fumble');
      const checkOk = (c) => c === undefined || (c && typeof c === 'object'
        && Array.isArray(c.attrs) && c.attrs.every(attrsOk));
      const ok = w.events.filter((e) => e && typeof e === 'object' && typeof e.id === 'string'
        && typeof e.at === 'number' && typeof e.session === 'number'
        && e.actor && typeof e.actor === 'object' && ['pc', 'npc', 'object', 'terrain'].includes(e.actor.kind)
        && typeof e.actor.id === 'string'
        && e.action && typeof e.action === 'object' && typeof e.action.name === 'string'
        && ['动作库', '技能', '临场'].includes(e.action.source)
        && Array.isArray(e.deltas)
        && e.deltas.every((d) => d && typeof d === 'object' && KINDS.has(d.kind) && typeof d.id === 'string' && typeof d.name === 'string')
        && checkOk(e.check));
      if (ok.length !== w.events.length) { fixed.push(`事件账本丢了 ${w.events.length - ok.length} 条形状不对的`); w.events = ok; }
      if (w.events.length > 200) { fixed.push(`事件账本裁到最近 200 条（原 ${w.events.length} 条）`); w.events = w.events.slice(-200); }
    }
  }
  fixed.push(...repairDoorOpenStates(w));
  return fixed;
}

/**
 * 旧工程的门可能没有「打开」状态。按状态名补一个；猜不到就别动，让严格校验给出可操作提示。
 * 导出/保存前也要调用：内存里的旧工程不一定跑过加载迁移。
 */
export function repairDoorOpenStates(w, opts = {}) {
  const fixed = [];
  const OPEN = /^(打开|开门|开着|开启|开|已打开|open|opened)$/i;
  for (const m of Array.isArray(w?.maps) ? w.maps : []) {
    for (const o of Array.isArray(m?.objects) ? m.objects : []) {
      const op = o?.opening;
      if (!op) continue;
      if (!Array.isArray(op.openStates)) op.openStates = [];
      const states = Array.isArray(o.states) ? o.states : [];
      const label = typeof o.name === 'string' && o.name ? o.name : (typeof o.id === 'string' ? o.id : '门');
      if (!op.openStates.length) {
        let i = states.findIndex((s) => typeof s === 'string' && OPEN.test(s.trim()));
        // 状态名猜不到时，用 blocksWhen 反推：不在挡路列表里的状态才是能开的。
        const blocks = Array.isArray(o.blocksWhen) ? o.blocksWhen.filter((v) => Number.isInteger(v) && v >= 0 && v < states.length) : [];
        if (i < 0 && blocks.length && blocks.length < states.length) {
          const open = states.map((_, k) => k).filter((k) => !blocks.includes(k));
          const pick = open.includes(o.state) ? o.state : open[0];
          if (pick !== undefined) i = pick;
        }
        if (i < 0 && opts.guess && states.length) {
          // 用户在导入时明确确认过「把最后一个状态当打开」才走到这里，不是静默猜。
          i = states.length ? states.length - 1 : 0;
          fixed.push(`门「${label}」按确认把「${states[i]}」当作打开`);
        }
        if (i < 0) { fixed.push(`门「${label}」没有打开状态，状态名和挡路列表都读不出来，请手工在检查器里勾一个`); continue; }
        op.openStates = [i];
        fixed.push(`门「${label}」没有打开状态，补成「${states[i]}」`);
      }
      if (Array.isArray(o.blocksWhen)) {
        const overlap = o.blocksWhen.filter((v) => op.openStates.includes(v));
        if (overlap.length) {
          o.blocksWhen = o.blocksWhen.filter((v) => !op.openStates.includes(v));
          fixed.push(`门「${label}」的打开状态同时被标成挡路，已从挡路里移除`);
        }
      }
    }
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
    const o = map.objects.find((o) => o.id === s.id);
    if (!o) c.fail('objects', `找不到本图物件：${s.id}`);
    c.int(s.x, `${o.name}.x`, 0); c.int(s.y, `${o.name}.y`, 0);
    c.int(s.state, `${o.name}.state`, 0, o.states.length - 1);
    if (s.enabled !== undefined) c.bool(s.enabled, `${o.name}.enabled`);
    if (s.x + o.w > map.width || s.y + o.h > map.height) c.fail(o.name, '完整尺寸超出地图边界');
    if (isArchitectureObject(o) && (s.x !== o.x || s.y !== o.y)) c.fail(o.name, '静态建筑不能按家具移动');
    changes.set(s.id, s);
  }
  const objects = map.objects.map((o) => ({ ...o, ...changes.get(o.id), ...(changes.has(o.id) ? { enabled: changes.get(o.id).enabled !== false } : {}) }));
  for (const snap of list) {
    const o = objects.find(o => o.id === snap.id);
    if (o.kind !== 'object' || o.enabled === false || !(o.physical?.blocksMove ?? (o.blocksWhen ? o.blocksWhen.includes(o.state) : o.height >= .5))) continue;
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
    if (o.enabled === false) continue;
    if (objects.some((b) => b.enabled !== false && b.id !== o.id && b.kind === 'object' && !isArchitectureObject(b) &&
      (members.has(b.id) || (b.physical?.blocksMove ?? (b.blocksWhen ? b.blocksWhen.includes(b.state) : b.height >= 0.5))) && overlap(o, b))) c.fail(p.name, '滑块与其它滑块或挡路物件相交');
  }
}

/**
 * 检查整份工程，有问题就抛出一句能看懂的错误（带出错的位置）。
 * migrated = true：浏览器里迁移（补旧字段）之后再查一遍，这时旧字段都必须在（编辑器直接用它们）。
 */
/**
 * 旧版「取消细分」只删了记忆，没删地图上的子格覆盖（f6d9758 才补上删除）。
 * 这种存档里会留下 subCells / materialSubCells / 子格迷雾，但父格已经不在 subdivisions 里；
 * 导出前严格校验会报「子格地形只能落在细分过的格子里」。
 *
 * 取消细分本来就是要丢弃这一格的子格数据，所以迁移时把这些找不到父格的键丢掉；
 * 只丢掉孤儿键，不动仍然有效的子格，也不改 subdivisions。
 * 返回丢掉的数量，方便测试和以后做提示。
 */
export function repairOrphanSubcells(w) {
  const maps = Array.isArray(w?.maps) ? w.maps : [];
  let dropped = 0;
  const drop = (data, width, height, subs) => {
    if (!data || typeof data !== 'object') return;
    const n = width * 3, max = width * height * 9;
    for (const key of Object.keys(data)) {
      const k = +key;
      const parent = Number.isSafeInteger(k) && k >= 0 && k < max
        ? Math.floor(Math.floor(k / n) / 3) * width + Math.floor((k % n) / 3)
        : -1;
      if (!subs.has(parent)) { delete data[key]; dropped++; }
    }
  };
  for (const m of maps) {
    if (!m || !Number.isInteger(m.width) || !Number.isInteger(m.height)) continue;
    const subs = new Set(Array.isArray(m.subdivisions) ? m.subdivisions : []);
    drop(m.subCells, m.width, m.height, subs);
    drop(m.materialSubCells, m.width, m.height, subs);
    drop(m.subFog, m.width, m.height, subs);
    const layers = [m, ...Object.values(m.views && typeof m.views === 'object' ? m.views : {})];
    for (const L of layers) {
      if (!L || typeof L !== 'object') continue;
      drop(L.subFog, m.width, m.height, subs);
      const seen = L.seen;
      if (seen && typeof seen === 'object') {
        for (const k of ['subCells', 'materialSubCells', 'observed', 'subRevs', 'architectureRevs']) drop(seen[k], m.width, m.height, subs);
      }
    }
  }
  return dropped;
}

export function checkWorld(w, migrated = false) {
  const c = checker('工程文件有问题：');
  const { fail, obj, arr, str, optStr, bool, optBool, id, int, num, optNum, oneOf, unique, strings } = c;
  const fogs = (v, where, len) => arr(v, where, len).forEach((f, i) => { if (f !== 0 && f !== 1 && f !== 2) fail(`${where}[${i}]`, `迷雾只能是 0/1/2，现在是 ${JSON.stringify(f)}`); });
  const endpoint = (e, where) => { obj(e, where); str(e.mapId, `${where}.mapId`); int(e.x, `${where}.x`); int(e.y, `${where}.y`); };
  const identity = (v, where) => { if (v === undefined) return; obj(v, where); optBool(v.party, `${where}.party`); if (v.recipients !== undefined) strings(v.recipients, `${where}.recipients`); };
  const seenObjects = (v, where) => arr(v, where).forEach((o, i) => {
    const at = `${where}[${i}]`;
    obj(o, at); id(o.id, `${at}.id`); str(o.name, `${at}.name`); str(o.icon, `${at}.icon`); str(o.color, `${at}.color`);
    int(o.x, `${at}.x`); int(o.y, `${at}.y`); int(o.w, `${at}.w`, 1, MAX_SIDE); int(o.h, `${at}.h`, 1, MAX_SIDE); num(o.height, `${at}.height`, 0, 1000);
    if (o.anchor !== undefined) { obj(o.anchor, `${at}.anchor`); int(o.anchor.x, `${at}.anchor.x`, 0, 2); int(o.anchor.y, `${at}.anchor.y`, 0, 2); }
    if (o.stateLabel !== null) str(o.stateLabel, `${at}.stateLabel`);
    identity(o.identity, `${at}.identity`);
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
    if (v.materialCells !== undefined) for (const [key, value] of Object.entries(obj(v.materialCells, `${where}.materialCells`))) { int(+key, `${where}.materialCells key`, 0, n - 1); str(value, `${where}.materialCells value`); }
    if (v.materialSubCells !== undefined) for (const [key, value] of Object.entries(obj(v.materialSubCells, `${where}.materialSubCells`))) { int(+key, `${where}.materialSubCells key`, 0, n * 9 - 1); str(value, `${where}.materialSubCells value`); }
  };

  obj(w, '工程');
  if (w.version !== 1) fail('version', '不是 1（不是这个编辑器的工程文件）');
  str(w.name, 'name');
  arr(w.terrains, 'terrains').forEach((t, i) => {
    const at = `terrains[${i}]`;
    obj(t, at); id(t.id, `${at}.id`); str(t.name, `${at}.name`); str(t.color, `${at}.color`); bool(t.blocksMove, `${at}.blocksMove`); num(t.visionCoef, `${at}.visionCoef`, 0, 1000);
  });
  unique(w.terrains, 'terrains');
  if (w.materials !== undefined) {
    arr(w.materials, 'materials').forEach((m, i) => {
      const at = `materials[${i}]`;
      obj(m, at); id(m.id, `${at}.id`); str(m.name, `${at}.name`); str(m.color, `${at}.color`);
      optStr(m.texture, `${at}.texture`); optStr(m.footstep, `${at}.footstep`);
      if (m.friction !== undefined) num(m.friction, `${at}.friction`, 0, 10);
    });
    unique(w.materials, 'materials');
  }
  if (!arr(w.maps, 'maps').length) fail('maps', '是空的（至少要有一张地图）');
  unique(w.maps, 'maps');
  w.maps.forEach((m, mi) => {
    const at = `地图「${typeof m?.name === 'string' ? m.name : mi}」`;
    obj(m, at); id(m.id, `${at}.id`); str(m.name, `${at}.name`); str(m.layer, `${at}.layer`); int(m.floor, `${at}.floor`, -1000, 1000); str(m.notes, `${at}.notes`);
    int(m.width, `${at}.width`, 1, MAX_SIDE); int(m.height, `${at}.height`, 1, MAX_SIDE);
    if (m.cellCm !== undefined) {
      const bad = !Number.isInteger(m.cellCm) || m.cellCm < 15 || m.cellCm > 1500 || !(75 % m.cellCm === 0 || m.cellCm % 75 === 0);
      if (bad) fail(`${at}.cellCm`, `大格尺寸必须是 75 的整倍数或整因数（15–1500cm），现在是 ${JSON.stringify(m.cellCm)}`);
    }
    const n = m.width * m.height;
    if (m.subdivisions !== undefined) arr(m.subdivisions, `${at}.subdivisions`);
    if (m.subCells !== undefined) {
      for (const [key, value] of Object.entries(obj(m.subCells, `${at}.subCells`))) {
        const k = +key; int(k, `${at}.subCells key`, 0, m.width * m.height * 9 - 1);
        optStr(value, `${at}.subCells value`);
        const x3 = k % (m.width * 3), y3 = Math.floor(k / (m.width * 3));
        const cell = Math.floor(y3 / 3) * m.width + Math.floor(x3 / 3);
        if (!m.subdivisions?.includes(cell)) fail(`${at}.subCells`, '子格地形只能落在细分过的格子里');
      }
    }
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
    // 高度：每格一个整数，负数是往地面以下挖坑。范围跟 scene/height.ts 的 MIN/MAX 对齐。
    if (m.heights !== undefined) arr(m.heights, `${at}.heights`, n).forEach((v, i) => int(v, `${at}.heights[${i}]`, -8, 24));
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
            if (s.anchor !== undefined) { obj(s.anchor, `${sa}.anchor`); int(s.anchor.x, `${sa}.anchor.x`, 0, 2); int(s.anchor.y, `${sa}.anchor.y`, 0, 2); }
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
      if (o.enabled !== undefined) bool(o.enabled, `${oa}.enabled`);
      if (o.anchor !== undefined) {
        obj(o.anchor, `${oa}.anchor`);
        int(o.anchor.x, `${oa}.anchor.x`, 0, 2); int(o.anchor.y, `${oa}.anchor.y`, 0, 2);
        // 锚点偏移不能把物件推出地图
        if ((o.anchor.x && o.x + o.w >= m.width) || (o.anchor.y && o.y + o.h >= m.height)) fail(`${oa}.anchor`, '锚点偏移会把物件推出地图');
      }
      identity(o.identity, `${oa}.identity`);
      if (o.blocksWhen !== undefined) arr(o.blocksWhen, `${oa}.blocksWhen`).forEach((v, k) => int(v, `${oa}.blocksWhen[${k}]`, 0, o.states.length - 1));
      if (o.geometry !== undefined) {
        obj(o.geometry, `${oa}.geometry`); oneOf(o.geometry.kind, ['wall'], `${oa}.geometry.kind`);
      }
      if (o.opening !== undefined) {
        obj(o.opening, `${oa}.opening`);
        arr(o.opening.openStates, `${oa}.opening.openStates`).forEach(i => int(i, `${oa}.opening.openStates`, 0, o.states.length - 1));
        if (new Set(o.opening.openStates).size !== o.opening.openStates.length) fail(oa, '打开状态重复');
        if (o.opening.openStates.length === 0) fail(`${oa}.opening.openStates`, '门至少要有一个打开状态');
        if (Array.isArray(o.blocksWhen) && o.opening.openStates.some(i => o.blocksWhen.includes(i))) fail(`${oa}.opening.openStates`, '打开的状态不能同时在挡路列表里');
      }
      if (isArchitectureObject(o) && (o.kind !== 'object' || o.geometry && o.opening || o.pushable || o.heavy)) fail(oa, '建筑组件必须是静态物件，不能同时是墙和门洞');
      if (o.physical !== undefined) { obj(o.physical, `${oa}.physical`); optBool(o.physical.blocksMove, `${oa}.physical.blocksMove`); optBool(o.physical.blocksSight, `${oa}.physical.blocksSight`); }
      if (o.lock !== undefined) {
        obj(o.lock, `${oa}.lock`);
        oneOf(o.lock.kind, ['physical', 'electronic'], `${oa}.lock.kind`);
        bool(o.lock.locked, `${oa}.lock.locked`); bool(o.lock.keyable, `${oa}.lock.keyable`);
        c.optStr(o.lock.code, `${oa}.lock.code`);
      }
      optBool(o.pushable, `${oa}.pushable`);
      optBool(o.heavy, `${oa}.heavy`);
      if (o.interaction !== undefined) {
        obj(o.interaction, `${oa}.interaction`);
        optStr(o.interaction.material, `${oa}.interaction.material`);
        if (o.interaction.tags !== undefined) strings(o.interaction.tags, `${oa}.interaction.tags`);
        const tiers = ['crit', 'success', 'fail', 'fumble'];
        const usedActions = new Set();
        arr(o.interaction.overrides, `${oa}.interaction.overrides`).forEach((ov, k) => {
          const va = `${oa}.interaction.overrides[${k}]`;
          obj(ov, va); id(ov.actionId, `${va}.actionId`);
          if (usedActions.has(ov.actionId)) fail(`${va}.actionId`, '同一个动作只能有一条效果');
          usedActions.add(ov.actionId);
          const outcomes = obj(ov.outcomes, `${va}.outcomes`);
          for (const key of Object.keys(outcomes)) if (!tiers.includes(key)) fail(`${va}.outcomes.${key}`, '不是有效档位');
          for (const t of tiers) {
            if (outcomes[t] !== undefined) int(outcomes[t], `${va}.outcomes.${t}`, 0, o.states.length - 1);
          }
        });
      }
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
          if (block.enabled !== false && blocks.slice(j + 1).some((o) => o.enabled !== false && overlaps(block, o))) fail(pa, '滑块不能相交');
        });
        if (m.objects.some((o) => o.enabled !== false && o.kind === 'object' && !isArchitectureObject(o) && !p.objectIds.includes(o.id) &&
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
          optBool(layout.interactive, `${la}.interactive`);
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
      if (t.opportunityUsed !== undefined) optBool(t.opportunityUsed, `${ta}.opportunityUsed`);
      if (t.hp !== undefined) num(t.hp, `${ta}.hp`, 0);
      if (t.hpMax !== undefined) num(t.hpMax, `${ta}.hpMax`, 0);
      if (t.down !== undefined) optBool(t.down, `${ta}.down`);
    });
    unique(m.tokens, `${at}.tokens`);
  });
  arr(w.connections, 'connections').forEach((cn, i) => {
    const ca = `connections[${i}]`;
    obj(cn, ca); id(cn.id, `${ca}.id`); oneOf(cn.kind, ['stairs', 'portal', 'door', 'other'], `${ca}.kind`); str(cn.label, `${ca}.label`); bool(cn.hidden, `${ca}.hidden`);
    endpoint(cn.a, `${ca}.a`); endpoint(cn.b, `${ca}.b`);
  });
  unique(w.connections, 'connections');
  arr(w.party, 'party').forEach((p, i) => {
    obj(p, `party[${i}]`); id(p.id, `party[${i}].id`); str(p.name, `party[${i}].name`); str(p.color, `party[${i}].color`); strings(p.tags, `party[${i}].tags`);
    if (p.avatar !== undefined) {
      optStr(p.avatar, `party[${i}].avatar`);
      if (!/^data:image\/(png|jpeg|webp);base64,/.test(p.avatar)) fail(`party[${i}].avatar`, '头像必须是 data:image/…;base64 的小图');
      if (p.avatar.length > 262144) fail(`party[${i}].avatar`, '头像太大（上限 256KB），重新上传小图');
    }
    if (p.me !== undefined) num(p.me, `party[${i}].me`, 0);
    if (p.meMax !== undefined) num(p.meMax, `party[${i}].meMax`, 0);
    if (p.pathway !== undefined) optStr(p.pathway, `party[${i}].pathway`);
    for (const skill of p.skills ?? []) optStr(skill, `party[${i}].skills`);
    if (p.attributes !== undefined) {
      obj(p.attributes, `party[${i}].attributes`);
      for (const [k, v] of Object.entries(p.attributes)) num(v, `party[${i}].attributes.${k}`, 0, 1000);
    }
    if (p.hp !== undefined) num(p.hp, `party[${i}].hp`, 0);
    if (p.hpMax !== undefined) num(p.hpMax, `party[${i}].hpMax`, 0);
    if (p.sharp !== undefined) optBool(p.sharp, `party[${i}].sharp`);
  });
  unique(w.party, 'party');
  if (w.judgments !== undefined) {
    arr(w.judgments, 'judgments').forEach((j, i) => {
      const at = `judgments[${i}]`; obj(j, at); id(j.id, at); str(j.title, at); str(j.ruling, at); strings(j.recipients, at); num(j.at, at); int(j.session, at, 0);
      if (j.subjectId !== undefined && j.subjectId !== null) id(j.subjectId, `${at}.subjectId`);
      if (j.place !== undefined && j.place !== null) {
        const p = obj(j.place, `${at}.place`); id(p.mapId, `${at}.place.mapId`); num(p.x, `${at}.place.x`); num(p.y, `${at}.place.y`);
        const m = (w.maps ?? []).find((x) => x.id === p.mapId);
        if (!m) fail(`${at}.place.mapId`, '判定位置的地图不存在');
        // 跟 publishJudgment / visiblePoint 同一口径：x==width / y==height 已经在图外。
        else if (p.x < 0 || p.y < 0 || p.x >= m.width || p.y >= m.height) fail(`${at}.place`, '判定位置超出地图');
      }
      const r = obj(j.roll, `${at}.roll`); id(r.id, at); oneOf(r.sides, [4,6,8,10,12,20,100], at); int(r.value, at, 1, r.sides); oneOf(r.material, ['wood','plastic','metal','stone','rubber'], at); oneOf(r.persona, ['witness','player'], at); int(r.seed, `${at}.roll.seed`, 0, Number.MAX_SAFE_INTEGER); optStr(r.algorithm, at);
      if (r.sides === 100) { int(r.tens, at, 0, 90); int(r.units, at, 0, 9); if (r.tens % 10 || (r.tens + r.units || 100) !== r.value) fail(at, '百分骰结果不一致'); }
      if (r.values !== undefined) {
        arr(r.values, `${at}.roll.values`).forEach((v, k) => int(v, `${at}.roll.values[${k}]`, 1, r.sides));
        if (r.values.length < 2) fail(`${at}.roll.values`, '多属性判定至少两颗');
        if (!r.values.includes(r.value)) fail(`${at}.roll.values`, '采信值必须在掷出的骰子里');
        if (!Array.isArray(r.attrs) || r.attrs.length !== r.values.length) fail(`${at}.roll.attrs`, '属性名要和骰子一一对应');
        r.attrs.forEach((a, k) => str(a, `${at}.roll.attrs[${k}]`));
      } else if (r.attrs !== undefined) fail(`${at}.roll.attrs`, '没有多颗骰子就不该带属性名');
    });
    unique(w.judgments, 'judgments');
  }
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
  // 事件账本：可以没有；有就得是数组、条目形状对上。上限跟 src/rules/events.ts 的 EVENT_CAP 一致。
  if (w.events !== undefined) {
    arr(w.events, 'events').forEach((e, i) => {
      const ea = `events[${i}]`;
      obj(e, ea); id(e.id, `${ea}.id`); num(e.at, `${ea}.at`); num(e.session, `${ea}.session`);
      obj(e.actor, `${ea}.actor`); oneOf(e.actor.kind, ['pc', 'npc', 'object', 'terrain'], `${ea}.actor.kind`); id(e.actor.id, `${ea}.actor.id`); str(e.actor.name, `${ea}.actor.name`);
      if (e.target !== undefined) {
        obj(e.target, `${ea}.target`); oneOf(e.target.kind, ['pc', 'npc', 'object', 'terrain'], `${ea}.target.kind`);
        id(e.target.id, `${ea}.target.id`); str(e.target.name, `${ea}.target.name`);
      }
      obj(e.action, `${ea}.action`); optStr(e.action.id, `${ea}.action.id`); str(e.action.name, `${ea}.action.name`);
      oneOf(e.action.source, ['动作库', '技能', '临场'], `${ea}.action.source`);
      arr(e.deltas, `${ea}.deltas`).forEach((d, j) => {
        const da = `${ea}.deltas[${j}]`;
        obj(d, da); oneOf(d.kind, ['hp', 'me', 'moved', 'status', 'points', 'object'], `${da}.kind`);
        id(d.id, `${da}.id`); str(d.name, `${da}.name`);
      });
      if (e.check !== undefined) {
        const ca = `${ea}.check`;
        obj(e.check, ca); oneOf(e.check.scale, ['d20', 'd100'], `${ca}.scale`); arr(e.check.attrs, `${ca}.attrs`);
        oneOf(e.check.merge, ['single', 'any', 'all'], `${ca}.merge`);
        if (e.check.kind !== undefined) oneOf(e.check.kind, ['check', 'attack'], `${ca}.kind`);
        if (e.check.band !== undefined) oneOf(e.check.band, ['miss', 'hit', 'great', 'super'], `${ca}.band`);
        optNum(e.check.dc, `${ca}.dc`); optNum(e.check.total, `${ca}.total`); bool(e.check.success, `${ca}.success`);
        e.check.attrs.forEach((a, j) => {
          const aa = `${ca}.attrs[${j}]`;
          obj(a, aa); str(a.attr, `${aa}.attr`);
          oneOf(a.dice, ['single', 'advantage', 'disadvantage'], `${aa}.dice`);
          optNum(a.roll, `${aa}.roll`); optNum(a.used, `${aa}.used`);
          num(a.value, `${aa}.value`); optNum(a.total, `${aa}.total`);
          if (a.rolls !== undefined) arr(a.rolls, `${aa}.rolls`).forEach((v, k) => num(v, `${aa}.rolls[${k}]`));
          optBool(a.success, `${aa}.success`);
          if (a.tier !== undefined && a.tier !== null) oneOf(a.tier, ['crit', 'fumble'], `${aa}.tier`);
        });
        if (e.check.tier !== null && e.check.tier !== undefined) oneOf(e.check.tier, ['crit', 'fumble'], `${ca}.tier`);
        optStr(e.check.outcome, `${ca}.outcome`);
        if (e.check.rolledBy !== undefined) oneOf(e.check.rolledBy, ['player', 'witness', 'host'], `${ca}.rolledBy`);
      }
      if (e.damage !== undefined) {
        const da = `${ea}.damage`;
        obj(e.damage, da); oneOf(e.damage.kind, ['fall', 'impact'], `${da}.kind`);
        if (e.damage.kind === 'fall') {
          oneOf(e.damage.sides, [4, 6, 8, 10, 12, 20], `${da}.sides`);
          oneOf(e.damage.tier, ['light', 'medium', 'heavy', 'brutal'], `${da}.tier`);
        } else {
          // 撞门反伤只有 1D4，没有伤档。
          oneOf(e.damage.sides, [4], `${da}.sides`);
          if (e.damage.tier !== undefined) fail(`${da}.tier`, 'impact 伤害没有伤档');
        }
        int(e.damage.roll, `${da}.roll`, 1, e.damage.sides);
        oneOf(e.damage.by, ['player', 'witness', 'host'], `${da}.by`);
      }
      optStr(e.ruling, `${ea}.ruling`); optStr(e.note, `${ea}.note`);
    });
    if (w.events.length > 200) fail('events', `事件账本最多留 200 条，现在 ${w.events.length} 条`);
  }
  arr(w.log, 'log').forEach((e, i) => {
    obj(e, `log[${i}]`); id(e.id, `log[${i}].id`); num(e.at, `log[${i}].at`); num(e.session, `log[${i}].session`); str(e.kind, `log[${i}].kind`); str(e.text, `log[${i}].text`); optStr(e.mapId, `log[${i}].mapId`); optStr(e.eventId, `log[${i}].eventId`);
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
