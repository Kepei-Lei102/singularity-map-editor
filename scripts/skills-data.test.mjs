import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-skills-data-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/rules/skills'; export * from './src/rules/skills-data';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const api = createRequire(import.meta.url)(bundle);
after(() => rm(temp, { recursive: true, force: true }));

// 全部 16 条途径的序列 9，一次抄全。前缀就是途径编号。
const PROFESSIONS = [
  { pathway: '控场途径', prof: '游戏鉴赏家', prefix: '001', count: 12 },
  { pathway: '传说途径', prof: '琴师', prefix: '002', count: 12 },
  { pathway: '未来途径', prof: '工程师', prefix: '003', count: 12 },
  { pathway: '神经网络途径', prof: '优秀提问官', prefix: '004', count: 12 },
  { pathway: '太阳途径', prof: 'AI心理师', prefix: '005', count: 13 },
  { pathway: '赛博朋克途径', prof: '小说家', prefix: '006', count: 12 },
  { pathway: '勇士途径', prof: '运动博主', prefix: '007', count: 12 },
  { pathway: '玩家途径', prof: '具身游戏大师', prefix: '008', count: 12 },
  { pathway: '童话途径', prof: 'TRPG冒险家', prefix: '009', count: 13 },
  { pathway: '骑士途径', prof: '历史学家', prefix: '010', count: 12 },
  { pathway: '生命途径', prof: '医生', prefix: '011', count: 12 },
  { pathway: '学徒途径', prof: '学习家', prefix: '012', count: 12 },
  { pathway: '疗愈途径', prof: '自由厨师', prefix: '013', count: 12 },
  { pathway: '想象途径', prof: '动漫鉴赏家', prefix: '014', count: 12 },
  { pathway: 'DIY途径【线下】', prof: '书画家', prefix: '015', count: 12 },
  { pathway: '连接途径', prof: '猎头', prefix: '016', count: 12 },
];

test('十六条途径、序列9、共 194 条', () => {
  assert.equal(api.SKILL_DATA.length, 194);
  assert.equal(api.SKILL_LIBRARY.length, 198); // 194 + Ian 的 4 条
  assert.equal(new Set(api.SKILL_DATA.map((s) => s.id)).size, 194);
  for (const p of PROFESSIONS) {
    const list = api.SKILL_DATA.filter((s) => s.pathway === p.pathway);
    assert.equal(list.length, p.count, p.prof);
    for (const s of list) {
      assert.ok(s.id.startsWith(p.prefix + '-9-'), s.id);
      assert.equal(s.sequence, 9);
      assert.equal(s.pathway, p.pathway);
      assert.ok(s.group.length > 0, s.id);
    }
  }
});

test('公开字段只有玩家说明书那一套，没有判定/动作卡/实现', () => {
  for (const s of api.SKILL_DATA) {
    assert.deepEqual(Object.keys(s).sort(), ['desc', 'group', 'id', 'me', 'name', 'pathway', 'sequence'].sort());
    assert.equal(s.check, undefined);
    assert.equal(s.actionId, undefined);
    assert.ok(s.desc.length >= 10, s.id);
    assert.ok(!s.name.startsWith('【') && !s.name.endsWith('】'), s.name);
    assert.ok(Number.isInteger(s.me) && s.me >= 0 && s.me <= 5, `${s.id} me=${s.me}`);
  }
});

test('发给玩家窗口的公开技能不带私有字段', () => {
  const pub = api.publicSkillsOf(['014-9-001', '009-9-001', '001-9-001', '005-9-001']);
  assert.equal(pub.length, 4);
  for (const s of pub) {
    assert.deepEqual(Object.keys(s).sort(), ['desc', 'group', 'id', 'me', 'name', 'pathway', 'sequence'].sort());
  }
});

test('按 id 查得到，未解锁的不进普通分组', () => {
  // 名字以源表为准：EA 版这里是「威吓」，旧工作簿里是「针对威吓」，已随源表更新。
  assert.equal(api.skillById('005-9-201')?.name, '威吓');
  const unlocked = new Set(['037-9-101']);
  const groups = api.groupSkills(api.SKILL_LIBRARY, unlocked);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].pathway, '金手指途径');
  const all = api.groupSkills(api.SKILL_LIBRARY, unlocked, { levelUp: true });
  assert.equal(all.flatMap((g) => g.groups).flatMap((g) => g.skills).length, api.SKILL_LIBRARY.length);
});
