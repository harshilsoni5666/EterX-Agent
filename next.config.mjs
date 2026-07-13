/** @type {import('next').NextConfig} */
const nextConfig = {
  // Electron starts the generated server directly in production.  A standalone
  // build keeps the desktop installer self-contained instead of requiring a
  // system Node.js installation or a separate `next start` process.
  output: 'standalone',
  experimental: {
    serverComponentsExternalPackages: ['cheerio', 'undici', 'fs-extra', 'pdf-parse', 'mathjs', 'playwright-core'],
    optimizePackageImports: ['lucide-react'],
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
