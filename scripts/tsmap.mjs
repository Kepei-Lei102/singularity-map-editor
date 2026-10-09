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

/** 读工程：文件夹或 zip 都行，返回 { world, media: Map<id, Buffer> } */
export async function readProject(p) {
  const media = new Map();
  if (fs.statSync(p).isDirectory()) {
    const world = JSON.parse(fs.readFileSync(path.join(p, 'world.json'), 'utf8'));
    for (const m of world.media ?? []) {
      const f = path.join(p, 'media', m.id);
      if (fs.existsSync(f)) media.set(m.id, fs.readFileSync(f));
    }
    return { world, media };
  }
  const zip = await JSZip.loadAsync(fs.readFileSync(p));
  const world = JSON.parse(await zip.file('world.json').async('string'));
  for (const m of world.media ?? []) {
    const f = zip.file(`media/${m.id}`);
    if (f) media.set(m.id, await f.async('nodebuffer'));
  }
  return { world, media };
}

/** 写成文件夹：world.json 缩进排版（git 好比较）；只留还在用的配图。 */
export function writeFolder(dir, world, media) {
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(world, null, 2) + '\n');
  const keep = new Set((world.media ?? []).map((m) => m.id));
  for (const [id, buf] of media) if (keep.has(id)) fs.writeFileSync(path.join(dir, 'media', id), buf);
  for (const f of fs.readdirSync(path.join(dir, 'media'))) if (!keep.has(f)) fs.rmSync(path.join(dir, 'media', f));
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
