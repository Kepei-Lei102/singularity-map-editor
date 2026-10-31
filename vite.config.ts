import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import pkg from './package.json';

// SINGLE=1 retains the portable combined editor/player file.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const role = mode === 'host' || mode === 'player' ? mode : '';
  return {
    plugins: [react(), ...(role === 'player' ? [{
      name: 'player-no-project-api',
      configureServer(server: import('vite').ViteDevServer) {
        server.middlewares.use((req, res, next) => {
          if (/^\/__(load|save|save-target)(?:[/?]|$)/i.test(req.url ?? '')) { res.statusCode = 404; res.end('玩家端没有工程读写接口'); return; }
          next();
        });
      },
    }] : []), ...(process.env.SINGLE ? [viteSingleFile()] : [])],
    base: './',
    cacheDir: role ? `node_modules/.vite-${role}` : 'node_modules/.vite',
    publicDir: role === 'player' ? false : 'public',
    server: { port: Number(role === 'player' ? process.env.PLAYER_PORT || 5179 : process.env.HOST_PORT || 5178), strictPort: true },
    preview: { port: Number(role === 'player' ? process.env.PLAYER_PORT || 5179 : process.env.HOST_PORT || 5178), strictPort: true },
    build: role ? { outDir: `dist-${role}` } : undefined,
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      ...(role ? {
        'import.meta.env.VITE_APP_ROLE': JSON.stringify(role),
        'import.meta.env.VITE_HOST_ORIGIN': JSON.stringify(env.VITE_HOST_ORIGIN || 'http://localhost:5178'),
        'import.meta.env.VITE_PLAYER_ORIGIN': JSON.stringify(env.VITE_PLAYER_ORIGIN || 'http://localhost:5179'),
      } : {}),
    },
  };
});
