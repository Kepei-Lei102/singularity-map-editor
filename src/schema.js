// 工程文件的结构校验。浏览器（导入、恢复备份）和命令行（scripts/tsmap.mjs、open.mjs 保存）共用这一份。
// 只认"会让编辑器出错"的问题：缺字段、类型不对、格子数和尺寸对不上、坐标不是整数、ID 重复、媒体 ID 不安全。
// 旧存档缺的、migrateWorld 会补上的字段（seen、views、rooms、marks、npcs……）有就查，没有不算错。
// 纯 JS、不依赖任何东西，所以 node 和 vite 都能直接 import。

/** 媒体 ID 只能是一段安全的文件名（编辑器生成的都是这样），防止 ../ 之类越出工程目录。 */
export const safeId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);

const MAX_SIDE = 200;

/** 检查整份工程，有问题就抛出一句能看懂的错误（带出错的位置）。 */
export function checkWorld(w) {
  const fail = (where, what) => { throw new Error(`工程文件有问题：${where} ${what}`); };
  const obj = (v, where) => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(where, '不是对象'); return v; };
  const arr = (v, where, len) => {
    if (!Array.isArray(v)) fail(where, '不是列表');
    if (len !== undefined && v.length !== len) fail(where, `长度是 ${v.length}，应该是 ${len}`);
    return v;
  };
  const str = (v, where) => { if (typeof v !== 'string') fail(where, '不是文字'); };
  const id = (v, where) => { if (typeof v !== 'string' || !v) fail(where, '缺少 ID'); };
  const int = (v, where, min = -Infinity, max = Infinity) => {
    if (!Number.isInteger(v) || v < min || v > max) fail(where, `应该是 ${min === -Infinity ? '' : min + ' 到 '}${max === Infinity ? '' : max + ' 之间的'}整数，现在是 ${JSON.stringify(v)}`);
  };
  const num = (v, where) => { if (typeof v !== 'number' || !Number.isFinite(v)) fail(where, `应该是数字，现在是 ${JSON.stringify(v)}`); };
  const unique = (list, where) => {
    const seen = new Set();
    for (const x of list) { if (seen.has(x.id)) fail(where, `里有重复的 ID：${x.id}`); seen.add(x.id); }
  };
  const optional = (v, check) => { if (v !== undefined) check(v); };
  const strings = (v, where, len) => arr(v, where, len).forEach((s, i) => { if (typeof s !== 'string') fail(`${where}[${i}]`, '不是文字'); });
  const numbers = (v, where, len) => arr(v, where, len).forEach((s, i) => num(s, `${where}[${i}]`));
  const fogs = (v, where, len) => arr(v, where, len).forEach((f, i) => { if (f !== 0 && f !== 1 && f !== 2) fail(`${where}[${i}]`, `迷雾只能是 0/1/2，现在是 ${JSON.stringify(f)}`); });
  const endpoint = (e, where) => { obj(e, where); id(e.mapId, `${where}.mapId`); int(e.x, `${where}.x`); int(e.y, `${where}.y`); };
  const seenObjects = (v, where) => arr(v, where).forEach((o, i) => {
    const at = `${where}[${i}]`;
    obj(o, at); id(o.id, `${at}.id`); str(o.name, `${at}.name`);
    int(o.x, `${at}.x`); int(o.y, `${at}.y`); int(o.w, `${at}.w`, 1); int(o.h, `${at}.h`, 1);
  });
  const memory = (v, where, n) => { obj(v, where); strings(v.cells, `${where}.cells`, n); seenObjects(v.objects, `${where}.objects`); };

  obj(w, '工程');
  if (w.version !== 1) fail('version', '不是 1（不是这个编辑器的工程文件）');
  str(w.name, 'name');
  arr(w.terrains, 'terrains').forEach((t, i) => { obj(t, `terrains[${i}]`); id(t.id, `terrains[${i}].id`); str(t.color, `terrains[${i}].color`); });
  unique(w.terrains, 'terrains');
  if (!arr(w.maps, 'maps').length) fail('maps', '是空的（至少要有一张地图）');
  unique(w.maps, 'maps');
  w.maps.forEach((m, mi) => {
    const at = `地图「${m?.name ?? mi}」`;
    obj(m, at); id(m.id, `${at}.id`); str(m.name, `${at}.name`);
    int(m.width, `${at}.width`, 1, MAX_SIDE); int(m.height, `${at}.height`, 1, MAX_SIDE);
    const n = m.width * m.height;
    strings(m.cells, `${at}.cells`, n);
    numbers(m.d100, `${at}.d100`, n);
    fogs(m.fog, `${at}.fog`, n);
    optional(m.roomCells, (v) => strings(v, `${at}.roomCells`, n));
    optional(m.seen, (v) => memory(v, `${at}.seen`, n));
    optional(m.views, (v) => Object.entries(obj(v, `${at}.views`)).forEach(([pc, L]) => {
      obj(L, `${at}.views.${pc}`); fogs(L.fog, `${at}.views.${pc}.fog`, n); memory(L.seen, `${at}.views.${pc}.seen`, n);
    }));
    optional(m.rooms, (v) => { arr(v, `${at}.rooms`).forEach((r, i) => { obj(r, `${at}.rooms[${i}]`); id(r.id, `${at}.rooms[${i}].id`); str(r.name, `${at}.rooms[${i}].name`); }); unique(v, `${at}.rooms`); });
    if (m.spawn != null) { obj(m.spawn, `${at}.spawn`); int(m.spawn.x, `${at}.spawn.x`); int(m.spawn.y, `${at}.spawn.y`); }
    arr(m.objects, `${at}.objects`).forEach((o, i) => {
      const oa = `${at}.objects[${i}]（${o?.name ?? ''}）`;
      obj(o, oa); id(o.id, `${oa}.id`); str(o.name, `${oa}.name`);
      if (o.kind !== 'object' && o.kind !== 'zone') fail(`${oa}.kind`, '只能是 object 或 zone');
      int(o.x, `${oa}.x`); int(o.y, `${oa}.y`); int(o.w, `${oa}.w`, 1, MAX_SIDE); int(o.h, `${oa}.h`, 1, MAX_SIDE);
      num(o.height, `${oa}.height`);
      strings(o.states, `${oa}.states`);
      if (!o.states.length) fail(`${oa}.states`, '是空的（至少要有一个状态）');
      int(o.state, `${oa}.state`, 0, o.states.length - 1);
      arr(o.secrets, `${oa}.secrets`).forEach((s, k) => { obj(s, `${oa}.secrets[${k}]`); id(s.id, `${oa}.secrets[${k}].id`); obj(s.tiers, `${oa}.secrets[${k}].tiers`); });
      arr(o.media, `${oa}.media`).forEach((a, k) => { obj(a, `${oa}.media[${k}]`); id(a.id, `${oa}.media[${k}].id`); id(a.mediaId, `${oa}.media[${k}].mediaId`); });
    });
    unique(m.objects, `${at}.objects`);
    arr(m.tokens, `${at}.tokens`).forEach((t, i) => {
      const ta = `${at}.tokens[${i}]`;
      obj(t, ta); id(t.id, `${ta}.id`); str(t.name, `${ta}.name`); int(t.x, `${ta}.x`); int(t.y, `${ta}.y`);
      if (t.pcId !== null && typeof t.pcId !== 'string') fail(`${ta}.pcId`, '应该是角色 ID 或 null');
    });
    unique(m.tokens, `${at}.tokens`);
  });
  arr(w.connections, 'connections').forEach((c, i) => { obj(c, `connections[${i}]`); id(c.id, `connections[${i}].id`); endpoint(c.a, `connections[${i}].a`); endpoint(c.b, `connections[${i}].b`); });
  unique(w.connections, 'connections');
  arr(w.party, 'party').forEach((p, i) => { obj(p, `party[${i}]`); id(p.id, `party[${i}].id`); str(p.name, `party[${i}].name`); strings(p.tags, `party[${i}].tags`); });
  unique(w.party, 'party');
  if (w.flows !== undefined || w.lines === undefined) {
    arr(w.flows, 'flows').forEach((f, i) => {
      const fa = `流程图「${f?.name ?? i}」`;
      obj(f, fa); id(f.id, `${fa}.id`); str(f.name, `${fa}.name`);
      arr(f.nodes, `${fa}.nodes`).forEach((n, k) => {
        const na = `${fa}.nodes[${k}]`;
        obj(n, na); id(n.id, `${na}.id`); str(n.title, `${na}.title`); num(n.x, `${na}.x`); num(n.y, `${na}.y`);
        if (!['start', 'event', 'ending'].includes(n.kind)) fail(`${na}.kind`, '只能是 start / event / ending');
        if (n.effect != null) { obj(n.effect, `${na}.effect`); id(n.effect.mapId, `${na}.effect.mapId`); id(n.effect.objectId, `${na}.effect.objectId`); int(n.effect.toState, `${na}.effect.toState`, 0); }
      });
      unique(f.nodes, `${fa}.nodes`);
      arr(f.edges, `${fa}.edges`).forEach((e, k) => { obj(e, `${fa}.edges[${k}]`); id(e.id, `${fa}.edges[${k}].id`); id(e.from, `${fa}.edges[${k}].from`); id(e.to, `${fa}.edges[${k}].to`); });
      unique(f.edges, `${fa}.edges`);
    });
    unique(w.flows, 'flows');
  }
  arr(w.log, 'log');
  arr(w.media, 'media').forEach((m, i) => {
    obj(m, `media[${i}]`);
    if (!safeId(m.id)) fail(`media[${i}].id`, `不合法：${JSON.stringify(m.id)}`);
    str(m.name, `media[${i}].name`); str(m.mime, `media[${i}].mime`);
  });
  unique(w.media, 'media');
  num(w.session, 'session');
  if (w.playerMapId !== null && w.playerMapId !== undefined && typeof w.playerMapId !== 'string') fail('playerMapId', '应该是地图 ID 或 null');
  optional(w.marks, (v) => arr(v, 'marks').forEach((k, i) => { obj(k, `marks[${i}]`); id(k.mapId, `marks[${i}].mapId`); int(k.x, `marks[${i}].x`); int(k.y, `marks[${i}].y`); num(k.createdAt, `marks[${i}].createdAt`); num(k.life, `marks[${i}].life`); }));
  optional(w.npcs, (v) => {
    arr(v, 'npcs').forEach((n, i) => {
      const na = `NPC「${n?.name ?? i}」`;
      obj(n, na); id(n.id, `${na}.id`); str(n.name, `${na}.name`);
      arr(n.months, `${na}.months`).forEach((mo, k) => int(mo, `${na}.months[${k}]`, 1, 12));
      if (n.place != null) endpoint(n.place, `${na}.place`);
      for (const k of ['topics', 'beats', 'outcomes']) { arr(n[k], `${na}.${k}`).forEach((x, j) => { obj(x, `${na}.${k}[${j}]`); id(x.id, `${na}.${k}[${j}].id`); }); unique(n[k], `${na}.${k}`); }
      if (n.progress !== undefined) { obj(n.progress, `${na}.progress`); optional(n.progress.beatsDone, (b) => strings(b, `${na}.progress.beatsDone`)); }
    });
    unique(v, 'npcs');
  });
}

/** 工程里声明了、却没有对应文件的媒体（has(id) 判断文件在不在）。 */
export function missingMedia(w, has) {
  return (w.media ?? []).filter((m) => !has(m.id));
}
