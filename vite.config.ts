import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import pkg from './package.json';

// SINGLE=1 时打成一个 html（双击就能用，发给别人用这个）。
export default defineConfig({
  plugins: [react(), ...(process.env.SINGLE ? [viteSingleFile()] : [])],
  base: './',
  server: { port: 5178 },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
});
