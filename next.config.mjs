import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const desktopCommonJsPackages = ['cheerio', 'undici', 'fs-extra', 'pdf-parse', 'mathjs', 'playwright-core', 'koffi', 'typescript'];

/** @type {import('next').NextConfig} */
const repositoryRoot = path.resolve(process.cwd());
const tracingPath = (...segments) => path.join(repositoryRoot, ...segments).replaceAll('\\', '/');
const runtimeDataExcludes = [
  '.temp', '.workspaces', '.eterx-build-home', 'desktop-runtime', 'dist',
  'logs', 'gaia', 'tests', '.git', '.codex-remote-attachments',
].flatMap(directory => [tracingPath(directory), tracingPath(directory, '**')]);

const nextConfig = {
  // Desktop development sessions get an isolated output directory so a
  // second local Next server cannot overwrite the first server's asset map.
  distDir: process.env.ETERX_DEV_DIST_DIR || './.next',
  // Electron starts the generated server directly in production.  A standalone
  // build keeps the desktop installer self-contained instead of requiring a
  // system Node.js installation or a separate `next start` process.
  output: process.env.ETERX_BUILD_TARGET === 'source' ? undefined : 'standalone',
  // Runtime workspaces can contain browser profiles, junctions, virtual
  // environments, and user projects. They are durable data, never build
  // inputs, so file tracing must not traverse them during install/update.
  outputFileTracingExcludes: {
    '*': runtimeDataExcludes,
  },
  serverExternalPackages: desktopCommonJsPackages,
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  webpack: (config, { isServer }) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      'undici': false,
      // Keep xterm's prebuilt CommonJS module boundaries. Reprocessing the
      // flattened ESM build with Next's compiler can break class inheritance
      // during terminal construction ("Super constructor null ..."). Exact
      // aliases leave the package's stylesheet and type imports alone.
      '@xterm/xterm$': require.resolve('@xterm/xterm/lib/xterm.js'),
      '@xterm/addon-fit$': require.resolve('@xterm/addon-fit/lib/addon-fit.js'),
    };
    // Desktop runtime data, generated bundles, browser profiles, fixtures,
    // and logs live beside the source tree. They cannot affect the module
    // graph, but watching them wakes an otherwise idle development server as
    // the app writes state. Keep HMR focused on actual source inputs.
    const existingWatchIgnores = config.watchOptions?.ignored;
    const ignoreList = Array.isArray(existingWatchIgnores)
      ? existingWatchIgnores
      : existingWatchIgnores ? [existingWatchIgnores] : [];
    config.watchOptions = {
      ...config.watchOptions,
      ignored: [
        ...ignoreList.filter(item => typeof item === 'string' && item.length > 0),
        '**/.git/**',
        '**/.next/**',
        '**/.next-dev-*/**',
        '**/.codex-remote-attachments/**',
        '**/dist/**',
        '**/build/**',
        '**/desktop-runtime/**',
        '**/logs/**',
        '**/gaia/**',
        '**/.temp/**',
        '**/.workspaces/**'
      ],
    };
    if (isServer) {
      // The desktop launcher exposes dependencies.asar through NODE_PATH.
      // Native import() ignores NODE_PATH, so dual-export packages such as
      // cheerio must use their CommonJS entry even for ESM source imports.
      // Run before Next's externalizer, which otherwise emits import().
      const existingExternals = config.externals || [];
      config.externals = [
        ({ request }, callback) => {
          if (request && desktopCommonJsPackages.some(name => request === name || request.startsWith(`${name}/`))) {
            return callback(null, `commonjs ${request}`);
          }
          callback();
        },
        ...(Array.isArray(existingExternals) ? existingExternals : [existingExternals]),
      ];
    }
    return config;
  },
};

export default nextConfig;
