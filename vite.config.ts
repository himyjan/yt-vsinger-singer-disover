import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    // GitHub Pages project sites are served from `/<repo>/`, so the base path
    // must be configurable. `VITE_BASE_PATH` is set by the deploy workflow.
    base: env.VITE_BASE_PATH || '/',
    plugins: [
      vue({
        template: {
          compilerOptions: {
            isCustomElement: (tag: string) => tag === 'iconify-icon'
          }
        }
      } as any),
      tailwindcss()
    ],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        // The data pipeline and the web app share the same type definitions
        // and the same search engine, so there is exactly one source of truth.
        '@shared': path.resolve(__dirname, './scripts'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
    },
    build: {
      // The dataset is copied into `public/data/` by `npm run prepare:public`.
      chunkSizeWarningLimit: 900,
    },
  };
});
