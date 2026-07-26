/** @type {import('next').NextConfig} */
const nextConfig = {
  // Electron starts the generated server directly in production.  A standalone
  // build keeps the desktop installer self-contained instead of requiring a
  // system Node.js installation or a separate `next start` process.
  output: process.env.ETERX_BUILD_TARGET === 'source' ? undefined : 'standalone',
  experimental: {
    serverComponentsExternalPackages: ['cheerio', 'undici', 'fs-extra', 'pdf-parse', 'mathjs', 'playwright-core'],
    optimizePackageImports: ['lucide-react'],
    // Runtime workspaces can contain browser profiles, junctions, virtual
    // environments, and user projects. They are durable data, never build
    // inputs, so file tracing must not traverse them during install/update.
    outputFileTracingExcludes: {
      '*': [
        '**/.workspaces/**',
        '**\\.workspaces\\**',
        '**/.temp/**',
        '**/dist/**',
        '**/desktop-runtime/**',
        '**/gaia/**',
        '**/Windows/Microsoft.NET/**',
        '**\\Windows\\Microsoft.NET\\**',
      ],
    },
  },
  webpack: (config, { isServer }) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      'undici': false,
    };
    if (isServer) {
      config.externals = config.externals || [];
      if (Array.isArray(config.externals)) {
        config.externals.push('playwright-core');
      }
    }
    return config;
  },
};

export default nextConfig;
