import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process';

function getCommitHash() {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch (e) {
    console.warn('Failed to get commit hash:', e.message);
    return 'unknown';
  }
}

export default async ({ mode }) => {
  console.log('mode:', mode);
  // Load environment variables from .env file
  const env = loadEnv(mode, process.cwd());

  console.log('NODE_ENV:', process.env.NODE_ENV);
  // Log the environment variable to verify it's loaded
  console.log('VITE_REACT_PROFILING:', env.VITE_REACT_PROFILING);

  // Determine if profiling should be enabled
  const isProfiling = env.VITE_REACT_PROFILING === 'true';

  // Dynamically import vite-tsconfig-paths
  const viteTsconfigPaths = await import('vite-tsconfig-paths');

  return defineConfig({
    // Project-site subpath on GitHub Pages (sigfried.github.io/vs-hub/).
    // Overridable via VITE_BASE for other hosts (root site, custom domain).
    base: env.VITE_BASE ?? '/vs-hub/',
    plugins: [react(), viteTsconfigPaths.default()],
    define: {
      'process.env.COMMIT_HASH': JSON.stringify(getCommitHash()),
      // Bundle build time — stand-in for the backend's 'last-refreshed' so
      // client localStorage caches invalidate on a new deploy.
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    server: {
      open: false,
      port: 3000,
      host: true,
      // queries.js imports ../../../data/bundle_cache.json (a sibling of the
      // Vite root). Allow the repo root so dev serving doesn't reject it; at
      // build the JSON is inlined into the JS bundle.
      fs: { allow: ['..'] },
    },
  });
};

/*
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import viteTsconfigPaths from 'vite-tsconfig-paths'
import {execSync} from 'child_process';


function getCommitHash() {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch (e) {
    console.warn('Failed to get commit hash:', e.message);
    return 'unknown';
  }
}

// from https://chatgpt.com/share/9ce9cab9-f346-427b-85a2-11937f566e73 React Timeline Profiler Setup
export default ({ mode }) => {
  console.log('mode:', mode);
  // Load environment variables from .env file
  const env = loadEnv(mode, process.cwd());

  console.log('NODE_ENV:', process.env.NODE_ENV);
  // Log the environment variable to verify it's loaded
  console.log('VITE_REACT_PROFILING:', env.VITE_REACT_PROFILING);

  // Determine if profiling should be enabled
  const isProfiling = env.VITE_REACT_PROFILING === 'true';

  return defineConfig({
    base: '',
    plugins: [react(), viteTsconfigPaths()],
    // resolve: {
    //   alias: {
    //     'react-dom': isProfiling ? 'react-dom/profiling' : 'react-dom',
    //     'scheduler/tracing': isProfiling ? 'scheduler/tracing-profiling' : 'scheduler/tracing',
    //   },
    // },
    define: {
      'process.env.COMMIT_HASH': JSON.stringify(getCommitHash()),
    },
    server: {
      // whether the browser opens upon server start
      open: false,
      // this sets a default port to 3000
      port: 3000,
      host: true,
    },
    // build: {
    //   outDir: 'dist',
    //   rollupOptions: {
    //     input: {
    //       main: '/index.html',
    //       report: '/playwright-report/index.html'
    //     }
    //   }
    // },
  });
};
*/