import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-skills-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/rules/skills'; export * from './src/rules/skillCast'; export * from './src/rules/consent'; export * from './src/core/defaults'; export * from './src/core/store';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.location = { search: '', origin: 'http://localhost' };
globalThis.window = { setTimeout: () => 0, open: () => ({ closed: false, postMessage() {} }) };
globalThis.BroadcastChannel = class { postMessage() {} };
const api = createRequire(import.meta.url)(bundle);
after(() => rm(temp, { recursive: true, force: true }));

test('一级途径、二级技能组：锁定的不出现', () => {
  const unlocked = new Set(['037-9-101', '037-9-102']);
  const groups = api.groupSkills(api.SKILL_LIBRARY, unlocked);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].pathway, '金手指途径');
  const names = groups[0].groups.map((g) => g.name).sort((a, b) => a.localeCompare(b, 'zh'));
  assert.deepEqual(names.slice().sort(), ['医疗·调养', '战斗·兵器'].sort());
  const all = groups[0].groups.flatMap((g) => g.skills.map((s) => s.name));
  assert.deepEqual(all.sort(), ['以慢制快', '冥想'].sort());
});

test('升级视图能看到未解锁的名字', () => {
  const unlocked = new Set(['037-9-101']);
  assert.equal(api.groupSkills(api.SKILL_LIBRARY, unlocked).length, 1);
  const up = api.groupSkills(api.SKILL_LIBRARY, unlocked, { levelUp: true });
  const count = up.flatMap((g) => g.groups).flatMap((g) => g.skills).length;
  assert.equal(count, api.SKILL_LIBRARY.length);
});

test('搜索命中名字、技能组、说明；锁定的不搜出来', () => {
  const unlocked = new Set(['037-9-101']);
  assert.equal(api.filterSkills(api.SKILL_LIBRARY, '冥想', unlocked).length, 1);
  assert.equal(api.filterSkills(api.SKILL_LIBRARY, '战斗', unlocked).length, 0);      // 锁定的
  assert.equal(api.filterSkills(api.SKILL_LIBRARY, '战斗', unlocked, { levelUp: true }).length, 1);
});

test('ME 不够时不能发动', () => {
  const skill = api.SKILL_LIBRARY[0];
  assert.equal(api.canCast(skill, null).ok, true);
  assert.equal(api.canCast({ ...skill, me: 3 }, 2).ok, false);
});

function fixture() {
  const world = api.emptyWorld();
  world.party = [{ id: 'pc', name: 'Ian', color: '#fff', tags: [], skills: ['037-9-101', '037-9-102'], me: 10, meMax: 10 }];
  api.replaceWorld(world);
  api.setUI({ mapId: 'x', mode: 'edit' });
  return world;
}

test('玩家发起：直接进确认，focus 立起来', () => {
  fixture();
  assert.equal(api.beginSkillCast('pc', '037-9-101', 'player'), null);
  const c = api.castOf();
  assert.equal(c.step, 'confirm');
  assert.equal(api.getUI().focus.kind, 'skill');
  assert.match(api.getUI().focus.label, /冥想/);
  api.closeSkillCast();
  assert.equal(api.getUI().focus, null);
});

test('见证者代发起：先等同意，同意后才进确认', () => {
  fixture();
  api.beginSkillCast('pc', '037-9-101', 'gm');
  assert.equal(api.castOf().step, 'approval');
  assert.ok(api.castOf().expiresAt > Date.now());
  assert.equal(api.approveSkillCast(true), null);
  assert.equal(api.castOf().step, 'confirm');
  api.closeSkillCast();
});

test('玩家不同意：清掉 focus', () => {
  fixture();
  api.beginSkillCast('pc', '037-9-101', 'gm');
  api.approveSkillCast(false);
  assert.equal(api.castOf(), null);
  assert.equal(api.getUI().focus, null);
});

test('同意超时视为休眠，并清掉 focus', () => {
  fixture();
  api.beginSkillCast('pc', '037-9-101', 'gm');
  api.setUI({ cast: { ...api.castOf(), expiresAt: Date.now() - 1 } });
  assert.equal(api.timeoutSkillCast(), true);
  assert.equal(api.castOf(), null);
  assert.equal(api.getUI().focus, null);
});

test('掷骰结算：D20 20 成功、5 失败', () => {
  fixture();
  api.beginSkillCast('pc', '037-9-101', 'player');
  api.resolveSkillCast(20);
  assert.equal(api.castOf().step, 'result');
  assert.equal(api.castOf().success, true);
  api.closeSkillCast();

  fixture();
  api.beginSkillCast('pc', '037-9-101', 'player');
  api.resolveSkillCast(5);
  assert.equal(api.castOf().success, false);
  api.closeSkillCast();
});

test('发动中不能再发起第二个', () => {
  fixture();
  api.beginSkillCast('pc', '037-9-101', 'player');
  assert.match(api.beginSkillCast('pc', '037-9-102', 'player'), /发动中/);
  api.closeSkillCast();
});

test('玩家窗口回传：只认自己那个 cast，别的 id 不动', () => {
  fixture();
  api.beginSkillCast('pc', '037-9-101', 'gm');
  const id = api.castOf().id;
  assert.equal(api.handlePlayerDecision({ type: 'skill-decision', castId: 'nope', ok: true }), false);
  assert.equal(api.castOf().step, 'approval');
  assert.equal(api.handlePlayerDecision({ type: 'skill-decision', castId: id, ok: false }), true);
  assert.equal(api.castOf(), null); // 拒绝后直接清掉
});

test('不是同意阶段的回传不处理', () => {
  fixture();
  api.beginSkillCast('pc', '037-9-101', 'player'); // 玩家自己发起，没有 approval 阶段
  const id = api.castOf().id;
  assert.equal(api.handlePlayerDecision({ type: 'skill-decision', castId: id, ok: true }), false);
  assert.equal(api.castOf().step, 'confirm');
  api.closeSkillCast();
});

test('发给玩家窗口的技能只有公开字段', () => {
  const all = api.publicSkillsOf(['037-9-101', '999-不存在']);
  assert.equal(all.length, 1);
  assert.deepEqual(Object.keys(all[0]).sort(), ['desc', 'group', 'id', 'me', 'name', 'pathway', 'sequence']);
  const mine = api.publicSkillsOf(['037-9-101', '037-9-102', '037-9-003', '037-9-201', '037-9-101']);
  assert.equal(mine.length, 4); // 重复 id 不重复发
  assert.ok(!('check' in mine[0]) && !('actionId' in mine[0]));
});

test('发动就扣 ME；换途径多扣 1 点，取消退回', () => {
  fixture();
  api.update((d) => { const pc = d.party[0]; pc.me = 10; pc.meMax = 10; pc.pathway = '游戏鉴赏家'; });
  assert.equal(api.beginSkillCast('pc', '037-9-101', 'player'), null); // 金手指途径的冥想
  assert.equal(api.castOf().meCost, 2); // 冥想 1 + 换途径 1
  assert.equal(api.getWorld().party[0].me, 8);
  assert.equal(api.getWorld().party[0].pathway, '金手指途径');
  api.cancelSkillCast('测完取消');
  assert.equal(api.getWorld().party[0].me, 10);
  assert.equal(api.getWorld().party[0].pathway, '游戏鉴赏家');
  assert.equal(api.castOf(), null);
});

test('同途径不额外扣，ME 不够时拒绝发起', () => {
  fixture();
  api.update((d) => { const pc = d.party[0]; pc.me = 1; pc.pathway = '金手指途径'; });
  assert.equal(api.beginSkillCast('pc', '037-9-101', 'player'), null);
  assert.equal(api.castOf().meCost, 1);
  assert.equal(api.getWorld().party[0].me, 0);
  api.closeSkillCast();

  api.update((d) => { const pc = d.party[0]; pc.me = 1; pc.pathway = '游戏鉴赏家'; });
  assert.match(api.beginSkillCast('pc', '037-9-101', 'player') ?? '', /ME 不够/);
  assert.equal(api.castOf(), null);
});

test('见证者代发起：玩家点头时才扣 ME', () => {
  fixture();
  api.update((d) => { const pc = d.party[0]; pc.me = 5; pc.meMax = 5; pc.pathway = '金手指途径'; });
  api.beginSkillCast('pc', '037-9-101', 'gm');
  assert.equal(api.getWorld().party[0].me, 5); // 还没点头，不扣
  api.approveSkillCast(true);
  assert.equal(api.getWorld().party[0].me, 4);
  api.closeSkillCast();
});

test('ME 不够可以强行发动：扣到 0，标 overdrawn，取消退回', () => {
  fixture();
  api.update((d) => { const pc = d.party[0]; pc.me = 0; pc.meMax = 10; pc.pathway = '金手指途径'; });
  assert.match(api.beginSkillCast('pc', '037-9-101', 'player') ?? '', /ME 不够/);
  assert.equal(api.castOf(), null);
  assert.equal(api.beginSkillCast('pc', '037-9-101', 'player', true), null);
  const c = api.castOf();
  assert.equal(c.overdrawn, true);
  assert.equal(c.meCost, 1);
  assert.equal(api.getWorld().party[0].me, 0);
  api.cancelSkillCast('测完');
  assert.equal(api.getWorld().party[0].me, 0);
  assert.equal(api.castOf(), null);
});

test('见证者代发起也能强行发动：点头时才扣到 0', () => {
  fixture();
  api.update((d) => { const pc = d.party[0]; pc.me = 0; pc.pathway = '金手指途径'; });
  assert.equal(api.beginSkillCast('pc', '037-9-101', 'gm', true), null);
  assert.equal(api.castOf().overdrawn, true);
  assert.equal(api.getWorld().party[0].me, 0);
  api.approveSkillCast(true);
  assert.equal(api.getWorld().party[0].me, 0);
  api.closeSkillCast();
});

test('ME 没填就不能发动，强行也不行', () => {
  fixture();
  api.update((d) => { delete d.party[0].me; });
  assert.match(api.beginSkillCast('pc', '037-9-101', 'player') ?? '', /还没填 ME/);
  assert.match(api.beginSkillCast('pc', '037-9-101', 'gm', true) ?? '', /还没填 ME/);
  assert.equal(api.castOf(), null);
});
