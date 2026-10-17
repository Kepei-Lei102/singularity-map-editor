// 工程在两种格式之间互转：
//   zip（.tsmap.zip，一个文件，方便发给别人）
//   文件夹（world.json + media/，适合放进 git：改了什么一目了然，配图不会重复存）
// 用法：
//   node scripts/tsmap.mjs unpack <工程.tsmap.zip> <文件夹>
//   node scripts/tsmap.mjs pack <文件夹> <工程.tsmap.zip>
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { fileURLToPath } from 'node:url';

/** 媒体 ID 只能是一段安全的文件名（编辑器生成的都是这样），防止 ../ 之类越出工程目录。 */
export const safeId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);

/** 看一眼工程是不是完整的（保存、导入前都要过这一关）。 */
export function checkWorld(world) {
  if (!world || world.version !== 1 || !Array.isArray(world.maps) || world.maps.length === 0) throw new Error('不是完整的工程（没有地图）');
  for (const m of world.maps) {
    const n = m.width * m.height;
    if (!(m.width > 0 && m.height > 0) || !Array.isArray(m.cells) || m.cells.length !== n) throw new Error(`地图「${m.name}」的尺寸和格子数对不上`);
  }
  for (const m of world.media ?? []) if (!safeId(m.id)) throw new Error(`媒体 ID 不合法：${m.id}`);
}

/** 写文件：先写到旁边的临时文件，再改名替换（中途失败不会留下半个文件）；目标是符号链接就拒绝。 */
function writeAtomic(file, data) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`拒绝写入符号链接：${file}`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** 读工程：文件夹或 zip 都行，返回 { world, media: Map<id, Buffer> } */
export async function readProject(p) {
  const media = new Map();
  if (fs.statSync(p).isDirectory()) {
    const world = JSON.parse(fs.readFileSync(path.join(p, 'world.json'), 'utf8'));
    for (const m of world.media ?? []) {
      if (!safeId(m.id)) continue;
      const f = path.join(p, 'media', m.id);
      if (fs.existsSync(f) && !fs.lstatSync(f).isSymbolicLink()) media.set(m.id, fs.readFileSync(f));
    }
    return { world, media };
  }
  const zip = await JSZip.loadAsync(fs.readFileSync(p));
  const world = JSON.parse(await zip.file('world.json').async('string'));
  for (const m of world.media ?? []) {
    if (!safeId(m.id)) continue;
    const f = zip.file(`media/${m.id}`);
    if (f) media.set(m.id, await f.async('nodebuffer'));
  }
  return { world, media };
}

/** 写成文件夹：world.json 缩进排版（git 好比较）；只留还在用的配图。
 * 顺序：先校验 → 先写完所有配图 → 再替换 world.json → 最后才删不用的配图。中途出错，原来的 world.json 还在。 */
export function writeFolder(dir, world, media) {
  checkWorld(world);
  const mediaDir = path.join(dir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  if (fs.lstatSync(mediaDir).isSymbolicLink()) throw new Error('media 文件夹是符号链接，拒绝写入');
  const keep = new Set((world.media ?? []).map((m) => m.id));
  const missing = [...keep].filter((id) => !media.has(id) && !fs.existsSync(path.join(mediaDir, id)));
  if (missing.length) throw new Error(`缺少媒体文件：${missing.join('、')}`);
  for (const [id, buf] of media) if (keep.has(id) && safeId(id)) writeAtomic(path.join(mediaDir, id), buf);
  writeAtomic(path.join(dir, 'world.json'), JSON.stringify(world, null, 2) + '\n');
  for (const f of fs.readdirSync(mediaDir)) if (!keep.has(f)) fs.rmSync(path.join(mediaDir, f));
}

export async function zipProject(world, media) {
  const zip = new JSZip();
  zip.file('world.json', JSON.stringify(world, null, 2));
  for (const [id, buf] of media) zip.file(`media/${id}`, buf);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, from, to] = process.argv.slice(2);
  if (!['pack', 'unpack'].includes(cmd) || !from || !to) {
    console.log('用法：node scripts/tsmap.mjs unpack <工程.tsmap.zip> <文件夹>\n      node scripts/tsmap.mjs pack <文件夹> <工程.tsmap.zip>');
    process.exit(1);
  }
  const { world, media } = await readProject(path.resolve(from));
  if (cmd === 'unpack') writeFolder(path.resolve(to), world, media);
  else fs.writeFileSync(path.resolve(to), await zipProject(world, media));
  console.log(`${cmd === 'unpack' ? '已解包到' : '已打包为'}：${to}（${world.maps.length} 张图，${media.size} 个媒体文件）`);
}
