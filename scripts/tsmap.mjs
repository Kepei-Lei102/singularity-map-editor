// 工程在两种格式之间互转：
//   zip（.tsmap.zip，一个文件，方便发给别人）
//   文件夹（world.json + media/，适合放进 git：改了什么一目了然，配图不会重复存）
// 用法：
//   node scripts/tsmap.mjs unpack <工程.tsmap.zip> <文件夹>
//   node scripts/tsmap.mjs pack <文件夹> <工程.tsmap.zip>
//   缺媒体文件时默认报错停下；确实要打出不完整的包，加 --allow-missing
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { fileURLToPath } from 'node:url';
import { checkWorld, missingMedia, safeId } from '../src/schema.js';

export { checkWorld, safeId };

const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** 新建一个文件写进去：'wx' 要求文件原来不存在，所以不会顺着别人放好的符号链接写到别处。 */
function writeNew(file, data) {
  const fd = fs.openSync(file, 'wx', 0o644);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** 读工程：文件夹或 zip 都行，返回 { world, media: Map<id, Buffer> }。
 * 校验结构；工程里声明了的媒体缺文件就报错（allowMissing 时只跳过）。 */
export async function readProject(p, { allowMissing = false } = {}) {
  const media = new Map();
  let world;
  if (fs.statSync(p).isDirectory()) {
    const wj = path.join(p, 'world.json'), mediaDir = path.join(p, 'media');
    if (isLink(wj) || isLink(mediaDir)) throw new Error('world.json 或 media 文件夹是符号链接，拒绝读取');
    world = JSON.parse(fs.readFileSync(wj, 'utf8'));
    checkWorld(world);
    for (const m of world.media) {
      const f = path.join(mediaDir, m.id);
      if (fs.existsSync(f) && !isLink(f) && fs.statSync(f).isFile()) media.set(m.id, fs.readFileSync(f));
    }
  } else {
    const zip = await JSZip.loadAsync(fs.readFileSync(p));
    const wj = zip.file('world.json');
    if (!wj) throw new Error('压缩包里没有 world.json');
    world = JSON.parse(await wj.async('string'));
    checkWorld(world);
    for (const m of world.media) {
      const f = zip.file(`media/${m.id}`);
      if (f) media.set(m.id, await f.async('nodebuffer'));
    }
  }
  const missing = missingMedia(world, (id) => media.has(id));
  if (missing.length && !allowMissing) throw new Error(`缺少媒体文件：${missing.map((m) => `${m.name}（${m.id}）`).join('、')}`);
  return { world, media, missing };
}

/** 写成文件夹：world.json 缩进排版（git 好比较）；只留还在用的配图，内容没变的配图不重写。
 * 顺序：
 *   1. 校验；检查所有要换的目标（不能是符号链接）——任何一个不行就停，什么都没动
 *   2. 新内容全部写进同目录下的暂存文件夹（new/）
 *   3. 提交：每个目标先把旧文件挪进暂存的 old/，再把新文件挪上去，最后换 world.json；
 *      提交中任何一步出错，按相反顺序把已经换上的撤下来、旧文件挪回去，原工程保持原样
 *   4. 删不用的配图
 */
export function writeFolder(dir, world, media) {
  checkWorld(world);
  const mediaDir = path.join(dir, 'media'), wj = path.join(dir, 'world.json');
  if (isLink(dir) || isLink(mediaDir) || isLink(wj)) throw new Error('目标里有符号链接，拒绝写入');
  fs.mkdirSync(mediaDir, { recursive: true });
  const keep = new Set(world.media.map((m) => m.id));
  const onDisk = (id) => { const f = path.join(mediaDir, id); return fs.existsSync(f) && !isLink(f) && fs.statSync(f).isFile(); };
  const missing = missingMedia(world, (id) => media.has(id) || onDisk(id));
  if (missing.length) throw new Error(`缺少媒体文件：${missing.map((m) => `${m.name}（${m.id}）`).join('、')}`);
  const changed = [...media].filter(([id, buf]) => keep.has(id) && safeId(id) && !(onDisk(id) && fs.readFileSync(path.join(mediaDir, id)).equals(buf)));
  // 1. 先查完所有目标再动手
  for (const id of keep) {
    const f = path.join(mediaDir, id);
    if (isLink(f)) throw new Error(`拒绝使用符号链接：media/${id}`);
    if (fs.existsSync(f) && !fs.statSync(f).isFile()) throw new Error(`media/${id} 不是普通文件`);
  }
  const stage = fs.mkdtempSync(path.join(dir, '.tsmap-stage-'));
  const neu = path.join(stage, 'new'), old = path.join(stage, 'old');
  fs.mkdirSync(neu); fs.mkdirSync(old);
  const done = []; // 已经提交的：{ target, backup | null }
  try {
    // 2. 暂存
    for (const [id, buf] of changed) writeNew(path.join(neu, id), buf);
    writeNew(path.join(neu, 'world.json'), JSON.stringify(world, null, 2) + '\n');
    // 3. 提交
    const commit = (from, target, backupName) => {
      let backup = null;
      if (fs.existsSync(target)) { backup = path.join(old, backupName); fs.renameSync(target, backup); }
      done.push({ target, backup });
      fs.renameSync(from, target);
    };
    for (const [id] of changed) commit(path.join(neu, id), path.join(mediaDir, id), id);
    commit(path.join(neu, 'world.json'), wj, 'world.json');
  } catch (e) {
    const stuck = [];
    for (const { target, backup } of done.reverse()) {
      try {
        if (fs.existsSync(target) && (!backup || fs.existsSync(backup))) fs.rmSync(target, { force: true });
        if (backup && fs.existsSync(backup)) fs.renameSync(backup, target);
      } catch { stuck.push(target); }
    }
    if (stuck.length) { // 还原不了的旧文件留在暂存文件夹里，不删
      throw new Error(`${e.message}；而且这些文件没能还原，旧版本留在 ${old}：${stuck.join('、')}`);
    }
    fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  }
  fs.rmSync(stage, { recursive: true, force: true });
  // 4. 删不用的配图
  for (const f of fs.readdirSync(mediaDir)) if (!keep.has(f)) fs.rmSync(path.join(mediaDir, f), { recursive: true, force: true });
  return { written: changed.length };
}

/** 写一个文件：先写到同目录下的新临时文件，再改名替换（中途失败不会留下半个文件）；目标是符号链接就拒绝。 */
export function writeFileAtomic(file, data) {
  if (isLink(file)) throw new Error(`拒绝写入符号链接：${file}`);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try { writeNew(tmp, data); fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

export async function zipProject(world, media) {
  const zip = new JSZip();
  zip.file('world.json', JSON.stringify(world, null, 2));
  for (const m of world.media) if (media.has(m.id)) zip.file(`media/${m.id}`, media.get(m.id));
  return zip.generateAsync({ type: 'nodebuffer' });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const allowMissing = args.includes('--allow-missing');
  const [cmd, from, to] = args.filter((a) => a !== '--allow-missing');
  if (!['pack', 'unpack'].includes(cmd) || !from || !to) {
    console.log('用法：node scripts/tsmap.mjs unpack <工程.tsmap.zip> <文件夹>\n      node scripts/tsmap.mjs pack <文件夹> <工程.tsmap.zip> [--allow-missing]');
    process.exit(1);
  }
  try {
    const { world, media, missing } = await readProject(path.resolve(from), { allowMissing });
    if (cmd === 'unpack') writeFolder(path.resolve(to), world, media);
    else writeFileAtomic(path.resolve(to), await zipProject(world, media));
    console.log(`${cmd === 'unpack' ? '已解包到' : '已打包为'}：${to}（${world.maps.length} 张图，${media.size} 个媒体文件）`);
    if (missing.length) console.warn(`注意：缺了 ${missing.length} 个媒体文件：${missing.map((m) => m.name).join('、')}`);
  } catch (e) {
    console.error('失败：' + e.message);
    process.exit(1);
  }
}
