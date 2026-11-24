// 玩家包闸门的解析/判定单测：技能库 198 个 id、单/双引号都能取，动作同名不误报。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillIdsOf, findLeak, bundleFiles } from './check-player-bundle.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('技能源里正好 198 个 id，含 Ian 手录', async () => {
  const data = await readFile(join(root, 'src/rules/skills-data.ts'), 'utf8');
  const skills = await readFile(join(root, 'src/rules/skills.ts'), 'utf8');
  const ids = skillIdsOf([data, skills]);
  assert.equal(ids.length, 198);
  assert.equal(new Set(ids).size, 198);
  assert.ok(ids.includes('001-9-001'));
  assert.ok(ids.includes('037-9-101'));
});

test('闸门按 id 抓泄漏，不按动作名误报', () => {
  const ids = ['001-9-001', '037-9-101'];
  assert.equal(findLeak(['const code = "001-9-001"'], ids), '001-9-001');
  assert.equal(findLeak(['const name = "威吓"'], ids), null);
  assert.equal(findLeak(['const name = "001-9-001"', 'const other = "037-9-101"'], ids), '001-9-001');
});

test('闸门扫描：assets JS、根级 JS、根 index.html 都算，dice 不混进来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ts-player-gate-'));
  try {
    await mkdir(join(dir, 'assets'));
    await mkdir(join(dir, 'dice'));
    await writeFile(join(dir, 'index.html'), '<script>const id = "001-9-001";</script>');
    await writeFile(join(dir, 'root.js'), 'const x = "001-9-001";');
    await writeFile(join(dir, 'assets', 'index.js'), 'const y = 1;');
    await writeFile(join(dir, 'dice', 'vendor.js'), 'const z = 1;');
    const files = await bundleFiles(dir);
    assert.equal(files.length, 3);
    assert.ok(files.some((f) => f.endsWith('index.html')));
    assert.ok(files.some((f) => f.endsWith('root.js')));
    const codes = await Promise.all(files.map((f) => readFile(f, 'utf8')));
    assert.equal(findLeak(codes, ['001-9-001']), '001-9-001');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('闸门：缺 index.html 应报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ts-player-gate-noindex-'));
  try {
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'app.js'), 'const x = 1;');
    await assert.rejects(bundleFiles(dir), /index\.html/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
