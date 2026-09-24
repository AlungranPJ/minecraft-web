import { defineConfig } from 'vite';

export default defineConfig({
  // relative asset paths so dist/ can be served from any sub path or file host
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    // pages: the game, the engine demo, the first person demo, the interaction demo
    rollupOptions: {
      input: {
        main: 'index.html',
        engine: 'engine.html',
        player: 'player.html',
        interaction: 'interaction.html',
      },
    },
  },
  server: {
    port: 5173,
  },
});
