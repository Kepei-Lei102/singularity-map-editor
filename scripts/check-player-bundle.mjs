// 玩家包闸门：玩家端不该带完整技能库。构建完 dist-player 后跑。
// 只按技能 id 判定；动作库里有同名动作（威吓等），按名字会误报。
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
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

/** 玩家产物里该查的文件：assets 的 JS + 根级 JS + 根 index.html；public/dice 不算玩家包代码。 */
export async function bundleFiles(dir) {
  const files = [];
  const walk = async (p) => {
    for (const entry of await readdir(p, { withFileTypes: true })) {
      const full = join(p, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.html')) files.push(full);
    }
  };
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(join(dir, entry.name));
  }
  const assetsDir = join(dir, 'assets');
  if (existsSync(assetsDir)) await walk(assetsDir);
  const index = join(dir, 'index.html');
  if (!existsSync(index)) throw new Error('dist-player 里没有 index.html，先跑 npm run build:split');
  files.push(index);
  return files;
}

/** 跑一遍闸门：返回文件数/体积/泄漏 id；不退出进程，方便测试。 */
export async function checkBundle(dir) {
  const data = await readFile(join(root, 'src/rules/skills-data.ts'), 'utf8');
  const skills = await readFile(join(root, 'src/rules/skills.ts'), 'utf8');
  const ids = skillIdsOf([data, skills]);
  if (ids.length !== 198) throw new Error(`技能 id 数不对：期望 198，实际 ${ids.length}`);
  const files = await bundleFiles(dir);
  let bytes = 0;
  for (const file of files) bytes += (await stat(file)).size;
  const codes = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  return { files, bytes, ids, leaked: findLeak(codes, ids) };
}

async function main() {
  const dir = process.argv[2] ? resolve(process.argv[2]) : join(root, 'dist-player');
  const { files, bytes, ids, leaked } = await checkBundle(dir);
  if (leaked) {
    console.error(`玩家包里仍有技能库 id：${leaked}`);
    process.exit(1);
  }
  console.log(`玩家包闸门：${files.length} 个 JS/HTML 文件 / ${(bytes / 1024).toFixed(0)} KiB，${ids.length} 个技能 id 都没命中。`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
