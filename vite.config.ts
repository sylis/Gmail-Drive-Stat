import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// En développement, Vite sert l'interface et relaie l'API vers le serveur Node (npm run dev).
const server = process.env.DEV_SERVER_URL ?? 'http://localhost:8080';
const proxy = { target: server, headers: { origin: server } };

export default defineConfig({
  root: 'web',
  plugins: [svelte()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { proxy: { '/api': proxy, '/auth': proxy } },
});
