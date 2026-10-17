// 启动编辑器；可以带一个文件，打开时自动导入：
//   npm start --prefix <编辑器目录> -- <文件或文件夹>
// 可以是本编辑器的工程（.tsmap.zip / .json，或者 world.json + media/ 的文件夹），也可以是 Rabbithole 的包（.zip / map.json）。
// 文件夹格式适合放进 git：⌘S 直接写回文件夹，world.json 改了什么一目了然。
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import crypto from 'node:crypto';
import { checkWorld, readProject, writeFileAtomic, writeFolder, zipProject } from './tsmap.mjs';
import { missingMedia } from '../src/schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
// npm --prefix 会把工作目录切到编辑器目录；INIT_CWD 才是你敲命令时所在的目录
const file = arg ? path.resolve(process.env.INIT_CWD || process.cwd(), arg) : null;
if (file && !fs.existsSync(file)) {
  console.error(`找不到文件：${file}`);
  process.exit(1);
}

const isFolder = !!file && fs.statSync(file).isDirectory();
// 保存口令：每次启动随机生成。别的网页可以往 localhost 发请求，但读不到 /__save-target 的回应，所以拿不到口令。
const TOKEN = crypto.randomBytes(16).toString('hex');
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
      // 这几个接口只回应本机地址：Host 不是 localhost 的请求（比如 DNS 重绑定，别的域名解析到 127.0.0.1）一律拒绝
      const localHost = (req) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host ?? '');
      const sameOrigin = (req) => { const o = req.headers.origin; return !!o && localHost(req) && (o === `http://${req.headers.host}` || o === `https://${req.headers.host}`); };
      s.middlewares.use((req, res, next) => {
        if (/^\/__(save-target|load|save)(\?|\/|$)/.test(req.url ?? '') && !localHost(req)) { res.statusCode = 403; res.end('拒绝：只接受本机地址'); return; }
        next();
      });
      s.middlewares.use('/__save-target', (_req, res) => {
        if (!target) { res.statusCode = 404; res.end(); return; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ path: target, token: TOKEN }));
      });
      s.middlewares.use('/__save', (req, res) => {
        if (!target || req.method !== 'POST') { res.statusCode = 404; res.end(); return; }
        // 口令对、而且 Origin 正好是这个编辑器自己（同一个主机和端口）才写
        if (req.headers['x-save-token'] !== TOKEN || !sameOrigin(req)) {
          res.statusCode = 403; res.end('拒绝：保存请求不是编辑器发来的'); return;
        }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          try {
            const body = Buffer.concat(chunks);
            // 先把浏览器发来的 zip 解开、校验，确认是完整的工程再写
            const zip = await JSZip.loadAsync(body);
            const wj = zip.file('world.json');
            if (!wj) throw new Error('发来的不是工程（没有 world.json）');
            const world = JSON.parse(await wj.async('string'));
            checkWorld(world);
            const media = new Map();
            for (const m of world.media) { const f = zip.file(`media/${m.id}`); if (f) media.set(m.id, await f.async('nodebuffer')); }
            if (isFolder) {
              // 文件夹：写成 world.json + media/（不留 .bak，交给 git）。缺的媒体如果文件夹里本来就有，writeFolder 会沿用
              writeFolder(target, world, media);
            } else {
              const missing = missingMedia(world, (id) => media.has(id));
              if (missing.length) throw new Error(`缺少媒体文件：${missing.map((m) => m.name).join('、')}`);
              if (fs.existsSync(target)) writeFileAtomic(target + '.bak', fs.readFileSync(target));
              writeFileAtomic(target, await zipProject(world, media));
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
        if (!isFolder) { res.setHeader('Content-Type', 'application/octet-stream'); fs.createReadStream(file).pipe(res); return; }
        try {
          const { world, media } = await readProject(file); // 文件夹：临时打成 zip 交给浏览器（缺媒体就报错，不悄悄少文件）
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end(await zipProject(world, media));
        } catch (e) {
          res.statusCode = 500;
          res.end(String((e && e.message) || e));
        }
      });
    },
  }],
});
await server.listen();
server.printUrls();
if (file) console.log(`\n  打开时会自动导入：${file}\n`);
