import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, renameSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import pkg from './package.json';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

// SINGLE=1 retains the portable combined editor/player file.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const role = mode === 'host' || mode === 'player' ? mode : '';
  let playerOutDir = 'dist-player';
  const playerOnly = role === 'player' ? [{
    name: 'player-entry',
    enforce: 'pre' as const,
    transformIndexHtml(html: string) {
      return html.replace('/src/main.tsx', '/src/player-main.tsx');
    },
  }, {
    name: 'player-index',
    apply: 'build' as const,
    configResolved(config: import('vite').ResolvedConfig) {
      playerOutDir = config.build.outDir;
    },
    closeBundle() {
      // player.html 是独立入口；部署时玩家端还是从根路径 / 打开，产物名改成 index.html。
      const outDir = path.resolve(rootDir, playerOutDir);
      const from = path.join(outDir, 'player.html');
      if (existsSync(from)) renameSync(from, path.join(outDir, 'index.html'));
    },
  }, {
    name: 'player-skills-stub',
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined) {
      // 主持端 send(world) 才需要技能投影；玩家端换成空投影桩，别把完整技能库打进玩家包。
      if (source === '../rules/skills' && importer?.endsWith('/src/runtime/sync.ts')) {
        return path.resolve(rootDir, 'src/rules/skills.player.ts');
      }
      return null;
    },
  }, {
    name: 'player-no-project-api',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        if (/^\/__(load|save|save-target|ai|ai-session)(?:[/?]|$)/i.test(req.url ?? '')) { res.statusCode = 404; res.end('玩家端没有工程读写接口'); return; }
        next();
      });
    },
  }] : [];
  return {
    plugins: [react(), ...playerOnly, ...(process.env.SINGLE ? [viteSingleFile()] : [])],
    base: './',
    cacheDir: role ? `node_modules/.vite-${role}` : 'node_modules/.vite',
    publicDir: 'public',
    server: { port: Number(role === 'player' ? process.env.PLAYER_PORT || 5179 : process.env.HOST_PORT || 5178), strictPort: true },
    preview: { port: Number(role === 'player' ? process.env.PLAYER_PORT || 5179 : process.env.HOST_PORT || 5178), strictPort: true },
    build: role ? {
      outDir: `dist-${role}`,
      ...(role === 'player' ? { rollupOptions: { input: { index: path.resolve(rootDir, 'player.html') } } } : {}),
    } : undefined,
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      ...(role ? {
        'import.meta.env.VITE_APP_ROLE': JSON.stringify(role),
        // 只配了玩家端地址才钉住；只起一个 dev server 时同源开窗口，别跳到没监听的端口
        'import.meta.env.VITE_HOST_ORIGIN': JSON.stringify(env.VITE_HOST_ORIGIN || ''),
        'import.meta.env.VITE_PLAYER_ORIGIN': JSON.stringify(env.VITE_PLAYER_ORIGIN || ''),
      } : {}),
    },
  };
});
