import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome110',
    cssCodeSplit: false,
    lib: {
      entry: 'src/content/index.tsx',
      formats: ['iife'],
      name: 'WordWorldContent',
      fileName: () => 'content.js',
    },
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
});
