/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['cheerio', 'undici', 'fs-extra', 'pdf-parse', 'mathjs', 'playwright-core'],
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
