import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome110',
    rollupOptions: {
      input: {
        popup: 'popup.html',
        options: 'options.html',
        manager: 'manager.html',
      },
    },
  },
});
