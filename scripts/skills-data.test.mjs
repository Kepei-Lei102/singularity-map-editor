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

const PROFESSIONS = [
  { pathway: '想象途径', prof: '动漫鉴赏家', prefix: '014', count: 12 },
  { pathway: '童话途径', prof: 'TRPG冒险家', prefix: '009', count: 13 },
  { pathway: '控场途径', prof: '游戏鉴赏家', prefix: '001', count: 12 },
  { pathway: '太阳途径', prof: 'AI心理师', prefix: '005', count: 13 },
  { pathway: '生命途径', prof: '医生', prefix: '011', count: 12 },
];

test('五个职业、序列9、共 62 条', () => {
  assert.equal(api.SKILL_DATA.length, 62);
  assert.equal(api.SKILL_LIBRARY.length, 66); // 62 + Ian 的 4 条
  assert.equal(new Set(api.SKILL_DATA.map((s) => s.id)).size, 62);
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
  assert.equal(api.skillById('005-9-201')?.name, '针对威吓');
  const unlocked = new Set(['037-9-101']);
  const groups = api.groupSkills(api.SKILL_LIBRARY, unlocked);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].pathway, '金手指途径');
  const all = api.groupSkills(api.SKILL_LIBRARY, unlocked, { levelUp: true });
  assert.equal(all.flatMap((g) => g.groups).flatMap((g) => g.skills).length, api.SKILL_LIBRARY.length);
});
