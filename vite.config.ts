import { defineConfig, type Plugin } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { resolve } from 'path';
/**
 * Match production Vercel rewrites in dev/preview: /driver → driver.html, /dashboard → dashboard.html
 */
function mpaEntryRewrite(): Plugin {
  const rewrite: (
    req: { url?: string },
    _res: unknown,
    next: (err?: unknown) => void,
  ) => void = (req, _res, next) => {
    const raw = req.url ?? '';
    const pathOnly = raw.split('?')[0] ?? '';
    const qs = raw.includes('?') ? raw.slice(raw.indexOf('?')) : '';
    if (pathOnly === '/driver' || pathOnly === '/driver/') {
      req.url = '/driver.html' + qs;
    } else if (pathOnly === '/dashboard' || pathOnly === '/dashboard/') {
      req.url = '/dashboard.html' + qs;
    }
    next();
  };

  return {
    name: 'mpa-entry-rewrite',
    configureServer: ({ middlewares }) => {
      middlewares.use(rewrite);
    },
    configurePreviewServer: ({ middlewares }) => {
      middlewares.use(rewrite);
    },
  };
}

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';
  const isProd = mode === 'production';

  return {
    plugins: [mpaEntryRewrite(), solidPlugin()],

    // Public directory for static assets
    publicDir: 'public',

    // Development server
    server: {
      port: 3000,
      strictPort: true,
      cors: true,
      // Warm up frequently used files for faster HMR
      warmup: {
        clientFiles: [
          './src/App.tsx',
          './src/stores/*.ts',
          './src/panels/*.tsx',
        ],
      },
    },

    // Preview server (production preview)
    preview: {
      port: 4173,
      strictPort: true,
    },

    // Build configuration
    build: {
      outDir: 'dist',
      target: 'esnext',
      minify: isProd ? 'esbuild' : false,
      sourcemap: isDev,
      cssCodeSplit: true,

      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          dashboard: resolve(__dirname, 'dashboard.html'),
          driver: resolve(__dirname, 'driver.html'),
          legacyCompat: resolve(__dirname, 'src/legacy/legacyCompat.ts'),
        },
        output: {
          // Optimal chunk splitting for caching
          manualChunks: {
            'vendor-solid': ['solid-js', '@solidjs/router'],
            'vendor-charts': ['uplot'],
            'vendor-map': ['maplibre-gl'],
            'vendor-table': ['@tanstack/solid-table'],
                'vendor-ably': ['ably'],
          },
          // Asset file naming for cache busting
          assetFileNames: 'assets/[name]-[hash][extname]',
          chunkFileNames: 'chunks/[name]-[hash].js',
          entryFileNames: (chunkInfo) =>
            chunkInfo.name === 'legacyCompat'
              ? 'js/legacyCompat.js'
              : 'js/[name]-[hash].js',
        },
      },

      // Performance thresholds
      chunkSizeWarningLimit: 500,
      reportCompressedSize: true,

      // Enable CSS minification
      cssMinify: isProd,
    },

    // Path aliases
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },

    // Dependency pre-bundling
    optimizeDeps: {
      include: [
        'solid-js',
        '@solidjs/router',
        'uplot',
        'maplibre-gl',
        '@tanstack/solid-table',
      ],
      // Exclude Convex (loaded via CDN)
      exclude: ['convex'],
    },

    // Global constants
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '2.0.0'),
      __DEV__: JSON.stringify(isDev),
    },

    // esbuild configuration
    esbuild: {
      // Remove console/debugger in production
      drop: isProd ? ['console', 'debugger'] : [],
      // Preserve legal comments
      legalComments: 'none',
    },

    // CSS configuration
    css: {
      devSourcemap: isDev,
    },
  };
});
