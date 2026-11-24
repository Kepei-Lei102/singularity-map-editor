// 玩家包闸门：玩家端不该带完整技能库。构建完 dist-player 后跑。
// 只按技能 id 判定；动作库里有同名动作（威吓等），按名字会误报。
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** 从技能源里抽技能 id（skills-data 用双引号，Ian 手录在 skills.ts）。 */
export function skillIdsOf(sources) {
  const ids = new Set();
  for (const source of sources) for (const m of source.matchAll(/\b\d{3}-9-\d{3}\b/g)) ids.add(m[0]);
  return [...ids].sort();
}

/** 任一段 JS 里出现技能 id 就算泄漏。 */
export function findLeak(codes, ids) {
  for (const code of codes) for (const id of ids) if (code.includes(id)) return id;
  return null;
}

async function main() {
  const dir = join(root, 'dist-player');
  const data = await readFile(join(root, 'src/rules/skills-data.ts'), 'utf8');
  const skills = await readFile(join(root, 'src/rules/skills.ts'), 'utf8');
  const ids = skillIdsOf([data, skills]);
  if (ids.length !== 198) throw new Error(`技能 id 数不对：期望 198，实际 ${ids.length}`);
  const assets = [];
  const walk = async (p) => {
    for (const entry of await readdir(p, { withFileTypes: true })) {
      const full = join(p, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.js')) assets.push(full);
    }
  };
  await walk(join(dir, 'assets'));
  if (assets.length === 0) throw new Error('dist-player 里没有 JS，先跑 npm run build:split');
  let bytes = 0;
  for (const file of assets) bytes += (await stat(file)).size;
  const codes = await Promise.all(assets.map((file) => readFile(file, 'utf8')));
  const leaked = findLeak(codes, ids);
  if (leaked) {
    console.error(`玩家包里仍有技能库 id：${leaked}`);
    process.exit(1);
  }
  console.log(`玩家包闸门：${assets.length} 个 JS / ${(bytes / 1024).toFixed(0)} KiB，${ids.length} 个技能 id 都没命中。`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
