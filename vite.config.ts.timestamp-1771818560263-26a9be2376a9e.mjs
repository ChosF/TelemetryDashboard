// vite.config.ts
import { defineConfig } from "file:///C:/Users/aaron/OneDrive/Escritorio/Ecovolt/updated-tabs/TelemetryDashboard/node_modules/vite/dist/node/index.js";
import solidPlugin from "file:///C:/Users/aaron/OneDrive/Escritorio/Ecovolt/updated-tabs/TelemetryDashboard/node_modules/vite-plugin-solid/dist/esm/index.mjs";
import { resolve } from "path";
var __vite_injected_original_dirname = "C:\\Users\\aaron\\OneDrive\\Escritorio\\Ecovolt\\updated-tabs\\TelemetryDashboard";
var vite_config_default = defineConfig(({ mode }) => {
  const isDev = mode === "development";
  const isProd = mode === "production";
  return {
    plugins: [solidPlugin()],
    // Public directory for static assets
    publicDir: "public",
    // Development server
    server: {
      port: 3e3,
      strictPort: true,
      cors: true,
      // Warm up frequently used files for faster HMR
      warmup: {
        clientFiles: [
          "./src/App.tsx",
          "./src/stores/*.ts",
          "./src/panels/*.tsx"
        ]
      }
    },
    // Preview server (production preview)
    preview: {
      port: 4173,
      strictPort: true
    },
    // Build configuration
    build: {
      outDir: "dist",
      target: "esnext",
      minify: isProd ? "esbuild" : false,
      sourcemap: isDev,
      cssCodeSplit: true,
      rollupOptions: {
        output: {
          // Optimal chunk splitting for caching
          manualChunks: {
            "vendor-solid": ["solid-js", "@solidjs/router"],
            "vendor-charts": ["uplot"],
            "vendor-map": ["maplibre-gl"],
            "vendor-table": ["@tanstack/solid-table"]
          },
          // Asset file naming for cache busting
          assetFileNames: "assets/[name]-[hash][extname]",
          chunkFileNames: "chunks/[name]-[hash].js",
          entryFileNames: "js/[name]-[hash].js"
        }
      },
      // Performance thresholds
      chunkSizeWarningLimit: 500,
      reportCompressedSize: true,
      // Enable CSS minification
      cssMinify: isProd
    },
    // Path aliases
    resolve: {
      alias: {
        "@": resolve(__vite_injected_original_dirname, "./src")
      }
    },
    // Dependency pre-bundling
    optimizeDeps: {
      include: [
        "solid-js",
        "@solidjs/router",
        "uplot",
        "maplibre-gl",
        "@tanstack/solid-table"
      ],
      // Exclude Convex (loaded via CDN)
      exclude: ["convex"]
    },
    // Global constants
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "2.0.0"),
      __DEV__: JSON.stringify(isDev)
    },
    // esbuild configuration
    esbuild: {
      // Remove console/debugger in production
      drop: isProd ? ["console", "debugger"] : [],
      // Preserve legal comments
      legalComments: "none"
    },
    // CSS configuration
    css: {
      devSourcemap: isDev
    }
  };
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJDOlxcXFxVc2Vyc1xcXFxhYXJvblxcXFxPbmVEcml2ZVxcXFxFc2NyaXRvcmlvXFxcXEVjb3ZvbHRcXFxcdXBkYXRlZC10YWJzXFxcXFRlbGVtZXRyeURhc2hib2FyZFwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiQzpcXFxcVXNlcnNcXFxcYWFyb25cXFxcT25lRHJpdmVcXFxcRXNjcml0b3Jpb1xcXFxFY292b2x0XFxcXHVwZGF0ZWQtdGFic1xcXFxUZWxlbWV0cnlEYXNoYm9hcmRcXFxcdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL0M6L1VzZXJzL2Fhcm9uL09uZURyaXZlL0VzY3JpdG9yaW8vRWNvdm9sdC91cGRhdGVkLXRhYnMvVGVsZW1ldHJ5RGFzaGJvYXJkL3ZpdGUuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSAndml0ZSc7XHJcbmltcG9ydCBzb2xpZFBsdWdpbiBmcm9tICd2aXRlLXBsdWdpbi1zb2xpZCc7XHJcbmltcG9ydCB7IHJlc29sdmUgfSBmcm9tICdwYXRoJztcclxuXHJcbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZygoeyBtb2RlIH0pID0+IHtcclxuICBjb25zdCBpc0RldiA9IG1vZGUgPT09ICdkZXZlbG9wbWVudCc7XHJcbiAgY29uc3QgaXNQcm9kID0gbW9kZSA9PT0gJ3Byb2R1Y3Rpb24nO1xyXG5cclxuICByZXR1cm4ge1xyXG4gICAgcGx1Z2luczogW3NvbGlkUGx1Z2luKCldLFxyXG5cclxuICAgIC8vIFB1YmxpYyBkaXJlY3RvcnkgZm9yIHN0YXRpYyBhc3NldHNcclxuICAgIHB1YmxpY0RpcjogJ3B1YmxpYycsXHJcblxyXG4gICAgLy8gRGV2ZWxvcG1lbnQgc2VydmVyXHJcbiAgICBzZXJ2ZXI6IHtcclxuICAgICAgcG9ydDogMzAwMCxcclxuICAgICAgc3RyaWN0UG9ydDogdHJ1ZSxcclxuICAgICAgY29yczogdHJ1ZSxcclxuICAgICAgLy8gV2FybSB1cCBmcmVxdWVudGx5IHVzZWQgZmlsZXMgZm9yIGZhc3RlciBITVJcclxuICAgICAgd2FybXVwOiB7XHJcbiAgICAgICAgY2xpZW50RmlsZXM6IFtcclxuICAgICAgICAgICcuL3NyYy9BcHAudHN4JyxcclxuICAgICAgICAgICcuL3NyYy9zdG9yZXMvKi50cycsXHJcbiAgICAgICAgICAnLi9zcmMvcGFuZWxzLyoudHN4JyxcclxuICAgICAgICBdLFxyXG4gICAgICB9LFxyXG4gICAgfSxcclxuXHJcbiAgICAvLyBQcmV2aWV3IHNlcnZlciAocHJvZHVjdGlvbiBwcmV2aWV3KVxyXG4gICAgcHJldmlldzoge1xyXG4gICAgICBwb3J0OiA0MTczLFxyXG4gICAgICBzdHJpY3RQb3J0OiB0cnVlLFxyXG4gICAgfSxcclxuXHJcbiAgICAvLyBCdWlsZCBjb25maWd1cmF0aW9uXHJcbiAgICBidWlsZDoge1xyXG4gICAgICBvdXREaXI6ICdkaXN0JyxcclxuICAgICAgdGFyZ2V0OiAnZXNuZXh0JyxcclxuICAgICAgbWluaWZ5OiBpc1Byb2QgPyAnZXNidWlsZCcgOiBmYWxzZSxcclxuICAgICAgc291cmNlbWFwOiBpc0RldixcclxuICAgICAgY3NzQ29kZVNwbGl0OiB0cnVlLFxyXG5cclxuICAgICAgcm9sbHVwT3B0aW9uczoge1xyXG4gICAgICAgIG91dHB1dDoge1xyXG4gICAgICAgICAgLy8gT3B0aW1hbCBjaHVuayBzcGxpdHRpbmcgZm9yIGNhY2hpbmdcclxuICAgICAgICAgIG1hbnVhbENodW5rczoge1xyXG4gICAgICAgICAgICAndmVuZG9yLXNvbGlkJzogWydzb2xpZC1qcycsICdAc29saWRqcy9yb3V0ZXInXSxcclxuICAgICAgICAgICAgJ3ZlbmRvci1jaGFydHMnOiBbJ3VwbG90J10sXHJcbiAgICAgICAgICAgICd2ZW5kb3ItbWFwJzogWydtYXBsaWJyZS1nbCddLFxyXG4gICAgICAgICAgICAndmVuZG9yLXRhYmxlJzogWydAdGFuc3RhY2svc29saWQtdGFibGUnXSxcclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgICAvLyBBc3NldCBmaWxlIG5hbWluZyBmb3IgY2FjaGUgYnVzdGluZ1xyXG4gICAgICAgICAgYXNzZXRGaWxlTmFtZXM6ICdhc3NldHMvW25hbWVdLVtoYXNoXVtleHRuYW1lXScsXHJcbiAgICAgICAgICBjaHVua0ZpbGVOYW1lczogJ2NodW5rcy9bbmFtZV0tW2hhc2hdLmpzJyxcclxuICAgICAgICAgIGVudHJ5RmlsZU5hbWVzOiAnanMvW25hbWVdLVtoYXNoXS5qcycsXHJcbiAgICAgICAgfSxcclxuICAgICAgfSxcclxuXHJcbiAgICAgIC8vIFBlcmZvcm1hbmNlIHRocmVzaG9sZHNcclxuICAgICAgY2h1bmtTaXplV2FybmluZ0xpbWl0OiA1MDAsXHJcbiAgICAgIHJlcG9ydENvbXByZXNzZWRTaXplOiB0cnVlLFxyXG5cclxuICAgICAgLy8gRW5hYmxlIENTUyBtaW5pZmljYXRpb25cclxuICAgICAgY3NzTWluaWZ5OiBpc1Byb2QsXHJcbiAgICB9LFxyXG5cclxuICAgIC8vIFBhdGggYWxpYXNlc1xyXG4gICAgcmVzb2x2ZToge1xyXG4gICAgICBhbGlhczoge1xyXG4gICAgICAgICdAJzogcmVzb2x2ZShfX2Rpcm5hbWUsICcuL3NyYycpLFxyXG4gICAgICB9LFxyXG4gICAgfSxcclxuXHJcbiAgICAvLyBEZXBlbmRlbmN5IHByZS1idW5kbGluZ1xyXG4gICAgb3B0aW1pemVEZXBzOiB7XHJcbiAgICAgIGluY2x1ZGU6IFtcclxuICAgICAgICAnc29saWQtanMnLFxyXG4gICAgICAgICdAc29saWRqcy9yb3V0ZXInLFxyXG4gICAgICAgICd1cGxvdCcsXHJcbiAgICAgICAgJ21hcGxpYnJlLWdsJyxcclxuICAgICAgICAnQHRhbnN0YWNrL3NvbGlkLXRhYmxlJyxcclxuICAgICAgXSxcclxuICAgICAgLy8gRXhjbHVkZSBDb252ZXggKGxvYWRlZCB2aWEgQ0ROKVxyXG4gICAgICBleGNsdWRlOiBbJ2NvbnZleCddLFxyXG4gICAgfSxcclxuXHJcbiAgICAvLyBHbG9iYWwgY29uc3RhbnRzXHJcbiAgICBkZWZpbmU6IHtcclxuICAgICAgX19BUFBfVkVSU0lPTl9fOiBKU09OLnN0cmluZ2lmeShwcm9jZXNzLmVudi5ucG1fcGFja2FnZV92ZXJzaW9uID8/ICcyLjAuMCcpLFxyXG4gICAgICBfX0RFVl9fOiBKU09OLnN0cmluZ2lmeShpc0RldiksXHJcbiAgICB9LFxyXG5cclxuICAgIC8vIGVzYnVpbGQgY29uZmlndXJhdGlvblxyXG4gICAgZXNidWlsZDoge1xyXG4gICAgICAvLyBSZW1vdmUgY29uc29sZS9kZWJ1Z2dlciBpbiBwcm9kdWN0aW9uXHJcbiAgICAgIGRyb3A6IGlzUHJvZCA/IFsnY29uc29sZScsICdkZWJ1Z2dlciddIDogW10sXHJcbiAgICAgIC8vIFByZXNlcnZlIGxlZ2FsIGNvbW1lbnRzXHJcbiAgICAgIGxlZ2FsQ29tbWVudHM6ICdub25lJyxcclxuICAgIH0sXHJcblxyXG4gICAgLy8gQ1NTIGNvbmZpZ3VyYXRpb25cclxuICAgIGNzczoge1xyXG4gICAgICBkZXZTb3VyY2VtYXA6IGlzRGV2LFxyXG4gICAgfSxcclxuICB9O1xyXG59KTtcclxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUFnYSxTQUFTLG9CQUFvQjtBQUM3YixPQUFPLGlCQUFpQjtBQUN4QixTQUFTLGVBQWU7QUFGeEIsSUFBTSxtQ0FBbUM7QUFJekMsSUFBTyxzQkFBUSxhQUFhLENBQUMsRUFBRSxLQUFLLE1BQU07QUFDeEMsUUFBTSxRQUFRLFNBQVM7QUFDdkIsUUFBTSxTQUFTLFNBQVM7QUFFeEIsU0FBTztBQUFBLElBQ0wsU0FBUyxDQUFDLFlBQVksQ0FBQztBQUFBO0FBQUEsSUFHdkIsV0FBVztBQUFBO0FBQUEsSUFHWCxRQUFRO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixZQUFZO0FBQUEsTUFDWixNQUFNO0FBQUE7QUFBQSxNQUVOLFFBQVE7QUFBQSxRQUNOLGFBQWE7QUFBQSxVQUNYO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQTtBQUFBLElBR0EsU0FBUztBQUFBLE1BQ1AsTUFBTTtBQUFBLE1BQ04sWUFBWTtBQUFBLElBQ2Q7QUFBQTtBQUFBLElBR0EsT0FBTztBQUFBLE1BQ0wsUUFBUTtBQUFBLE1BQ1IsUUFBUTtBQUFBLE1BQ1IsUUFBUSxTQUFTLFlBQVk7QUFBQSxNQUM3QixXQUFXO0FBQUEsTUFDWCxjQUFjO0FBQUEsTUFFZCxlQUFlO0FBQUEsUUFDYixRQUFRO0FBQUE7QUFBQSxVQUVOLGNBQWM7QUFBQSxZQUNaLGdCQUFnQixDQUFDLFlBQVksaUJBQWlCO0FBQUEsWUFDOUMsaUJBQWlCLENBQUMsT0FBTztBQUFBLFlBQ3pCLGNBQWMsQ0FBQyxhQUFhO0FBQUEsWUFDNUIsZ0JBQWdCLENBQUMsdUJBQXVCO0FBQUEsVUFDMUM7QUFBQTtBQUFBLFVBRUEsZ0JBQWdCO0FBQUEsVUFDaEIsZ0JBQWdCO0FBQUEsVUFDaEIsZ0JBQWdCO0FBQUEsUUFDbEI7QUFBQSxNQUNGO0FBQUE7QUFBQSxNQUdBLHVCQUF1QjtBQUFBLE1BQ3ZCLHNCQUFzQjtBQUFBO0FBQUEsTUFHdEIsV0FBVztBQUFBLElBQ2I7QUFBQTtBQUFBLElBR0EsU0FBUztBQUFBLE1BQ1AsT0FBTztBQUFBLFFBQ0wsS0FBSyxRQUFRLGtDQUFXLE9BQU87QUFBQSxNQUNqQztBQUFBLElBQ0Y7QUFBQTtBQUFBLElBR0EsY0FBYztBQUFBLE1BQ1osU0FBUztBQUFBLFFBQ1A7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsTUFDRjtBQUFBO0FBQUEsTUFFQSxTQUFTLENBQUMsUUFBUTtBQUFBLElBQ3BCO0FBQUE7QUFBQSxJQUdBLFFBQVE7QUFBQSxNQUNOLGlCQUFpQixLQUFLLFVBQVUsUUFBUSxJQUFJLHVCQUF1QixPQUFPO0FBQUEsTUFDMUUsU0FBUyxLQUFLLFVBQVUsS0FBSztBQUFBLElBQy9CO0FBQUE7QUFBQSxJQUdBLFNBQVM7QUFBQTtBQUFBLE1BRVAsTUFBTSxTQUFTLENBQUMsV0FBVyxVQUFVLElBQUksQ0FBQztBQUFBO0FBQUEsTUFFMUMsZUFBZTtBQUFBLElBQ2pCO0FBQUE7QUFBQSxJQUdBLEtBQUs7QUFBQSxNQUNILGNBQWM7QUFBQSxJQUNoQjtBQUFBLEVBQ0Y7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
