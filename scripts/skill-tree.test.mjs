// 技能树：主持人端派生树 + 玩家端公开技能分组；不持久化新字段。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-skill-tree-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/rules/skills';
export * from './src/rules/skills-data';
export * from './src/core/skillTree';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const api = createRequire(import.meta.url)(bundle);
await rm(temp, { recursive: true, force: true });

test('技能库是 16 条途径的 194 条 + Ian 4 条', () => {
  assert.equal(api.SKILL_DATA.length, 194);
  assert.equal(api.SKILL_LIBRARY.length, 198);
  assert.equal(new Set(api.SKILL_LIBRARY.map((s) => s.id)).size, 198);
  assert.deepEqual([...new Set(api.SKILL_LIBRARY.map((s) => s.sequence))], [9]);
});

test('主持人树：途径 → 组 → 技能，节点不丢、计数对', () => {
  const pc = { skills: ['037-9-101'], pathway: undefined };
  const tree = api.buildSkillTree(pc, { levelUp: true });
  assert.equal(tree.length, 17, '16 条自动途径 + 金手指');
  assert.equal(tree.reduce((n, p) => n + p.totalCount, 0), 198);
  assert.equal(tree.reduce((n, p) => n + p.unlockedCount, 0), 1);
  const ian = tree.find((p) => p.pathway === '金手指途径');
  assert.ok(ian?.current);
  assert.equal(ian.totalCount, 4);
  assert.equal(ian.unlockedCount, 1);
  const generated = tree.filter((p) => p.pathway !== '金手指途径');
  assert.equal(generated.length, 16);
  assert.equal(generated.reduce((n, p) => n + p.totalCount, 0), 194);
});

test('关闭升级视图只留已解锁的途径/组', () => {
  const tree = api.buildSkillTree({ skills: ['037-9-101'], pathway: undefined }, { levelUp: false });
  assert.equal(tree.length, 1);
  assert.equal(tree[0].pathway, '金手指途径');
  assert.equal(tree[0].totalCount, 1);
  assert.equal(tree[0].groups.length, 1);
  assert.equal(tree[0].groups[0].name, '医疗·调养');
});

test('显式当前途径标记；未知技能 id 不影响计数', () => {
  const tree = api.buildSkillTree({ skills: ['037-9-101', '不存在'], pathway: '控场途径' }, { levelUp: true });
  assert.equal(tree.find((p) => p.pathway === '控场途径')?.current, true);
  assert.equal(tree.find((p) => p.pathway === '金手指途径')?.current, false);
  assert.equal(tree.reduce((n, p) => n + p.unlockedCount, 0), 1);
});

test('玩家端分组只吃公开投影，按途径/组聚合并保留顺序', () => {
  const pub = api.publicSkillsOf(['001-9-001', '001-9-101', '002-9-001', '001-9-001']);
  assert.equal(pub.length, 3);
  const tree = api.groupPublicSkills(pub);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].pathway, '控场途径');
  assert.equal(tree[0].groups.length, 2);
  assert.equal(tree[0].groups[0].name, '通用');
  assert.equal(tree[0].groups[0].skills[0].name, '游戏解题');
  assert.equal(tree[0].groups[1].name, '正位');
  assert.equal(tree[1].pathway, '传说途径');
  for (const p of tree) for (const g of p.groups) for (const s of g.skills) {
    assert.deepEqual(Object.keys(s).sort(), ['desc', 'group', 'id', 'me', 'name', 'pathway', 'sequence']);
  }
});
