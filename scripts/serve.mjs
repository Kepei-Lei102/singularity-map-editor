// 起转发服务器：把 server/ 用 esbuild 打成一个临时 Node 包再跑，避免另配一套 TS 构建。
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-server-run-'));
const bundle = join(temp, 'server.cjs');
await build({
  entryPoints: [join(root, 'server/index.ts')],
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const { startServer } = createRequire(import.meta.url)(bundle);
const server = await startServer({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',
  playerOrigin: process.env.PLAYER_ORIGIN,
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean),
});
console.log(`ts map relay: ws://localhost:${server.port}  health http://localhost:${server.port}/health`);
const stop = async () => { await server.close(); await rm(temp, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
