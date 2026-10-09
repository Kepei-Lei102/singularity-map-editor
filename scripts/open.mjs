// 启动编辑器；可以带一个文件，打开时自动导入：
//   npm start --prefix <编辑器目录> -- <文件或文件夹>
// 可以是本编辑器的工程（.tsmap.zip / .json，或者 world.json + media/ 的文件夹），也可以是 Rabbithole 的包（.zip / map.json）。
// 文件夹格式适合放进 git：⌘S 直接写回文件夹，world.json 改了什么一目了然。
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { readProject, writeFolder, zipProject } from './tsmap.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
// npm --prefix 会把工作目录切到编辑器目录；INIT_CWD 才是你敲命令时所在的目录
const file = arg ? path.resolve(process.env.INIT_CWD || process.cwd(), arg) : null;
if (file && !fs.existsSync(file)) {
  console.error(`找不到文件：${file}`);
  process.exit(1);
}

const isFolder = !!file && fs.statSync(file).isDirectory();
if (isFolder && !fs.existsSync(path.join(file, 'world.json'))) {
  console.error(`这个文件夹里没有 world.json：${file}`);
  process.exit(1);
}

const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  server: { open: file ? `/?load=${encodeURIComponent(path.basename(file) + (isFolder ? '.tsmap.zip' : ''))}` : true },
  plugins: [{
    name: 'ts-load-file',
    configureServer(s) {
      // 存回硬盘：打开的是 .tsmap.zip 就覆盖它（先留一份 .bak）；否则在旁边新建 <名字>.tsmap.zip，原文件不动
      const target = !file ? null : isFolder || file.endsWith('.tsmap.zip') ? file
        : path.join(path.dirname(file), path.basename(file).replace(/\.(zip|json)$/i, '') + '.tsmap.zip');
      s.middlewares.use('/__save-target', (_req, res) => {
        if (!target) { res.statusCode = 404; res.end(); return; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ path: target }));
      });
      s.middlewares.use('/__save', (req, res) => {
        if (!target || req.method !== 'POST') { res.statusCode = 404; res.end(); return; }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          try {
            const body = Buffer.concat(chunks);
            if (isFolder) {
              // 文件夹：解开浏览器发来的 zip，写成 world.json + media/（不留 .bak，交给 git）
              const zip = await JSZip.loadAsync(body);
              const world = JSON.parse(await zip.file('world.json').async('string'));
              const media = new Map();
              for (const m of world.media ?? []) { const f = zip.file(`media/${m.id}`); if (f) media.set(m.id, await f.async('nodebuffer')); }
              writeFolder(target, world, media);
            } else {
              if (fs.existsSync(target)) fs.copyFileSync(target, target + '.bak');
              fs.writeFileSync(target, body);
            }
            console.log(`  已保存：${target}`);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ path: target }));
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
        });
      });
      s.middlewares.use('/__load', async (_req, res) => {
        if (!file) { res.statusCode = 404; res.end(); return; }
        res.setHeader('Content-Type', 'application/octet-stream');
        if (!isFolder) { fs.createReadStream(file).pipe(res); return; }
        const { world, media } = await readProject(file); // 文件夹：临时打成 zip 交给浏览器
        res.end(await zipProject(world, media));
      });
    },
  }],
});
await server.listen();
server.printUrls();
if (file) console.log(`\n  打开时会自动导入：${file}\n`);
