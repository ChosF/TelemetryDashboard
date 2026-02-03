import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { resolve } from 'path';

export default defineConfig(({ mode }) => {

  return {
    plugins: [solidPlugin()],

    // Public directory for assets
    publicDir: 'public',

    server: {
      port: 3000,
      strictPort: true,
      // Enable CORS for Convex
      cors: true,
    },

    preview: {
      port: 4173,
      strictPort: true,
    },

    build: {
      outDir: 'dist',
      target: 'esnext',
      minify: 'esbuild',
      sourcemap: mode === 'development',

      rollupOptions: {
        output: {
          // Chunk splitting for optimal loading
          manualChunks: {
            'solid': ['solid-js'],
            'uplot': ['uplot'],
            'maplibre': ['maplibre-gl'],
            'tanstack': ['@tanstack/solid-table'],
          },
        },
      },

      // Performance optimizations
      chunkSizeWarningLimit: 1000,
      reportCompressedSize: true,
    },

    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },

    // Pre-bundle dependencies
    optimizeDeps: {
      include: ['solid-js', 'uplot', 'maplibre-gl', '@tanstack/solid-table'],
    },

    // Environment variables
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '1.0.0'),
    },

    // Enable esbuild for faster builds
    esbuild: {
      drop: mode === 'production' ? ['console', 'debugger'] : [],
    },
  };
});
