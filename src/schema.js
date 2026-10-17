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
  if (!n.name.trim()) c.fail(`${where}.name`, '是空的');
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
    c.strings(p.beatsDone ?? [], `${where}.progress.beatsDone`);
    c.optBool(p.cast, `${where}.progress.cast`);
    for (const k of ['metAt', 'advisedAt', 'doneAt']) c.optNum(p[k], `${where}.progress.${k}`);
    c.optStr(p.advice, `${where}.progress.advice`);
    c.optStr(p.outcomeId, `${where}.progress.outcomeId`);
  }
}

/** 检查整份工程，有问题就抛出一句能看懂的错误（带出错的位置）。 */
export function checkWorld(w) {
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
  const memory = (v, where, n) => { obj(v, where); strings(v.cells, `${where}.cells`, n); seenObjects(v.objects, `${where}.objects`); };

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
    strings(m.cells, `${at}.cells`, n);
    arr(m.d100, `${at}.d100`, n).forEach((v, i) => num(v, `${at}.d100[${i}]`));
    fogs(m.fog, `${at}.fog`, n);
    optBool(m.autoFog, `${at}.autoFog`);
    if (m.roomCells !== undefined) strings(m.roomCells, `${at}.roomCells`, n);
    if (m.seen !== undefined) memory(m.seen, `${at}.seen`, n);
    if (m.views !== undefined) Object.entries(obj(m.views, `${at}.views`)).forEach(([pc, L]) => {
      obj(L, `${at}.views.${pc}`); fogs(L.fog, `${at}.views.${pc}.fog`, n); memory(L.seen, `${at}.views.${pc}.seen`, n);
    });
    if (m.rooms !== undefined) {
      arr(m.rooms, `${at}.rooms`).forEach((r, i) => { const ra = `${at}.rooms[${i}]`; obj(r, ra); id(r.id, `${ra}.id`); str(r.name, `${ra}.name`); str(r.color, `${ra}.color`); str(r.note, `${ra}.note`); strings(r.tags, `${ra}.tags`); });
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
      optNum(o.stateRev, `${oa}.stateRev`);
      arr(o.secrets, `${oa}.secrets`).forEach((s, k) => {
        const sa = `${oa}.secrets[${k}]`;
        obj(s, sa); id(s.id, `${sa}.id`); str(s.label, `${sa}.label`); str(s.check, `${sa}.check`);
        if (s.kind !== undefined) oneOf(s.kind, ['auto', 'roll'], `${sa}.kind`);
        if (s.range !== undefined) int(s.range, `${sa}.range`, 0, MAX_SIDE * 2);
        obj(s.tiers, `${sa}.tiers`); for (const t of ['crit', 'success', 'fail', 'fumble']) str(s.tiers[t], `${sa}.tiers.${t}`);
        if (s.revealed !== undefined) {
          obj(s.revealed, `${sa}.revealed`); oneOf(s.revealed.tier, ['crit', 'success', 'fail', 'fumble'], `${sa}.revealed.tier`);
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
    arr(m.tokens, `${at}.tokens`).forEach((t, i) => {
      const ta = `${at}.tokens[${i}]`;
      obj(t, ta); id(t.id, `${ta}.id`); str(t.name, `${ta}.name`); str(t.color, `${ta}.color`); int(t.x, `${ta}.x`); int(t.y, `${ta}.y`);
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
  });
  unique(w.media, 'media');
  num(w.session, 'session');
  if (w.playerMapId !== null && w.playerMapId !== undefined) str(w.playerMapId, 'playerMapId');
  if (w.visionMode !== undefined) oneOf(w.visionMode, ['shared', 'individual'], 'visionMode');
  if (w.marks !== undefined) arr(w.marks, 'marks').forEach((k, i) => {
    const ka = `marks[${i}]`;
    obj(k, ka); id(k.id, `${ka}.id`); str(k.mapId, `${ka}.mapId`); int(k.x, `${ka}.x`); int(k.y, `${ka}.y`); str(k.author, `${ka}.author`);
    str(k.symbol, `${ka}.symbol`); str(k.text, `${ka}.text`); num(k.createdAt, `${ka}.createdAt`); num(k.life, `${ka}.life`, 0);
  });
  if (w.npcs !== undefined) {
    arr(w.npcs, 'npcs').forEach((n, i) => checkNpc(n, `NPC「${typeof n?.name === 'string' ? n.name : i}」`, n?.progress === undefined, c));
    unique(w.npcs, 'npcs');
  }
}

/** 工程里声明了、却没有对应文件的媒体（has(id) 判断文件在不在）。 */
export function missingMedia(w, has) {
  return (w.media ?? []).filter((m) => !has(m.id));
}
