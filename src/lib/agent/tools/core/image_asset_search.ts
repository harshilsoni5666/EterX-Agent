import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { tavily } from '@tavily/core';
import axios from 'axios';
import fse from 'fs-extra';
import fs from 'fs/promises';
import path from 'path';
import { imageSize } from 'image-size';
import {
  checkEterXProtection,
  getRuntimeWorkspaceRoot,
  hasRuntimeWorkspaceContext,
  resolveWorkspaceDirectoryForContext,
} from '../../workspace/path_resolver';
import { getRuntimeApiKeyValues } from '../../runtime-api-keys';

type RawImageCandidate = {
  url: string;
  description?: string;
};

type AcceptedAsset = {
  filePath: string;
  publicPath: string;
  sourceUrl: string;
  description: string;
  contentType: string;
  width: number;
  height: number;
  bytes: number;
  score: number;
};

type RejectedAsset = {
  url: string;
  reason: string;
  description?: string;
};

const BAD_IMAGE_DOMAINS = [
  'picsum.photos',
  'placehold.co',
  'placeholder.com',
  'via.placeholder.com',
  'dummyimage.com',
  'fakeimg.pl',
  'placekitten.com',
  'loremflickr.com',
  'ui-avatars.com',
  'gravatar.com',
];

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'is',
  'of', 'on', 'or', 'the', 'to', 'with', 'website', 'site', 'web', 'page',
  'landing', 'hero', 'image', 'photo', 'picture', 'background', 'high',
  'quality', 'real', 'modern', 'premium', 'stock',
]);

const ROLE_QUERY_HINTS: Record<string, string> = {
  hero: 'high resolution editorial photo hero image',
  background: 'wide high resolution background photo',
  product: 'product photo clear subject',
  card: 'high quality contextual photo',
  gallery: 'high quality photo',
  avatar: 'portrait photo',
  logo: 'official logo',
};

const ROLE_MIN_SIZE: Record<string, { width: number; height: number }> = {
  hero: { width: 1200, height: 600 },
  background: { width: 1200, height: 600 },
  product: { width: 700, height: 500 },
  card: { width: 600, height: 400 },
  gallery: { width: 700, height: 500 },
  avatar: { width: 300, height: 300 },
  logo: { width: 128, height: 128 },
};

const getTavilyKeys = (): string[] => {
  return getRuntimeApiKeyValues('tavily');
};

let tavilyKeys = getTavilyKeys();
let currentKeyIndex = 0;
let tavilyClients = tavilyKeys.map(apiKey => tavily({ apiKey }));

const refreshTavilyClients = () => {
  const latestKeys = getTavilyKeys();
  if (latestKeys.join('\n') === tavilyKeys.join('\n')) return;
  tavilyKeys = latestKeys;
  currentKeyIndex = 0;
  tavilyClients = latestKeys.map(apiKey => tavily({ apiKey }));
  console.log(`[Tool: image_asset_search] Runtime Tavily refresh: ${tavilyKeys.length} key(s) from Settings`);
};

const getNextTavilyClient = () => {
  refreshTavilyClients();
  if (tavilyClients.length === 0) {
    throw new Error('No Tavily API key found. Add one in Settings > Connections to enable image asset search.');
  }

  const client = tavilyClients[currentKeyIndex];
  const usedIndex = currentKeyIndex;
  currentKeyIndex = (currentKeyIndex + 1) % tavilyClients.length;
  console.log(`[Tool: image_asset_search] Using Tavily key index: ${usedIndex}`);
  return client;
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

function safeFilenameStem(input: string): string {
  const stem = input
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return stem || 'image-asset';
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function isBadImageUrl(url: string, allowSvg: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid_url';
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return 'unsupported_protocol';

  const domain = parsed.hostname.replace(/^www\./, '').toLowerCase();
  if (BAD_IMAGE_DOMAINS.some(bad => domain === bad || domain.endsWith(`.${bad}`))) {
    return 'placeholder_or_avatar_domain';
  }

  const lowerUrl = decodeURIComponent(url).toLowerCase();
  if (!allowSvg && lowerUrl.includes('.svg')) return 'svg_not_allowed';
  if (/\b(favicon|sprite|tracking|pixel|1x1|blank|spacer)\b/.test(lowerUrl)) return 'non_content_image';

  return null;
}

function extensionFromContentType(contentType: string, sourceUrl: string): string {
  const cleanType = contentType.toLowerCase().split(';')[0].trim();
  if (cleanType.includes('jpeg') || cleanType.includes('jpg')) return '.jpg';
  if (cleanType.includes('png')) return '.png';
  if (cleanType.includes('webp')) return '.webp';
  if (cleanType.includes('gif')) return '.gif';
  if (cleanType.includes('svg')) return '.svg';
  if (cleanType.includes('avif')) return '.avif';

  try {
    const ext = path.extname(new URL(sourceUrl).pathname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.avif'].includes(ext)) {
      return ext === '.jpeg' ? '.jpg' : ext;
    }
  } catch {
    // Fall through to a safe default.
  }

  return '.jpg';
}

function resolveOutputDir(outputDir?: string, context?: any): string {
  let targetDir: string;

  if (outputDir?.trim()) {
    targetDir = resolveWorkspaceDirectoryForContext(outputDir, context);
  } else if (hasRuntimeWorkspaceContext(context)) {
    const publicDir = path.join(getRuntimeWorkspaceRoot(context), 'public');
    targetDir = fse.existsSync(publicDir)
      ? path.join(publicDir, 'eterx-assets')
      : path.resolve(process.cwd(), '.workspaces', 'temp', 'image-assets');
  } else {
    targetDir = path.resolve(process.cwd(), '.workspaces', 'temp', 'image-assets');
  }

  const protection = checkEterXProtection(targetDir);
  if (protection.blocked) throw new Error(protection.reason);

  return targetDir;
}

function makePublicPath(filePath: string, outputDir: string, publicPath?: string): string {
  const filename = path.basename(filePath);
  if (publicPath?.trim()) {
    const normalizedBase = publicPath.replace(/\\/g, '/').replace(/\/+$/g, '');
    return `${normalizedBase}/${filename}`;
  }

  const parts = filePath.split(path.sep);
  const publicIndex = parts.map(p => p.toLowerCase()).lastIndexOf('public');
  if (publicIndex >= 0 && publicIndex < parts.length - 1) {
    return `/${parts.slice(publicIndex + 1).join('/')}`;
  }

  return path.relative(path.dirname(outputDir), filePath).replace(/\\/g, '/');
}

function scoreCandidate(
  sourceUrl: string,
  description: string,
  width: number,
  height: number,
  queryTokens: string[],
): number {
  const searchableText = `${description} ${decodeURIComponent(sourceUrl)}`.toLowerCase();
  const matchedTokens = queryTokens.filter(token => searchableText.includes(token));
  const domain = getDomain(sourceUrl);

  let score = 0;
  score += Math.min(40, Math.round((width * height) / 80000));
  score += matchedTokens.length * 12;
  if (description && matchedTokens.length > 0) score += 12;
  if (['images.unsplash.com', 'plus.unsplash.com', 'images.pexels.com', 'cdn.pixabay.com', 'upload.wikimedia.org'].includes(domain)) {
    score += 8;
  }
  if (width >= 1200) score += 8;
  if (height >= 600) score += 6;

  return score;
}

async function downloadAndValidateImage(
  candidate: RawImageCandidate,
  options: {
    allowSvg: boolean;
    maxBytes: number;
    minWidth: number;
    minHeight: number;
    outputDir: string;
    publicPath?: string;
    fileStem: string;
    index: number;
    queryTokens: string[];
    strictDescriptionMatch: boolean;
  }
): Promise<{ asset?: AcceptedAsset; rejection?: RejectedAsset }> {
  const earlyRejection = isBadImageUrl(candidate.url, options.allowSvg);
  if (earlyRejection) {
    return { rejection: { url: candidate.url, reason: earlyRejection, description: candidate.description } };
  }

  const description = candidate.description || '';
  if (options.strictDescriptionMatch && description.split(/\s+/).length >= 4 && options.queryTokens.length > 0) {
    const descriptionText = description.toLowerCase();
    const hasTokenMatch = options.queryTokens.some(token => descriptionText.includes(token));
    if (!hasTokenMatch) {
      return { rejection: { url: candidate.url, reason: 'description_mismatch', description } };
    }
  }

  try {
    const response = await axios.get(candidate.url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: options.maxBytes,
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.2',
        'User-Agent': 'Mozilla/5.0 EterX image asset validator',
      },
      validateStatus: status => status >= 200 && status < 400,
    });

    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      return { rejection: { url: candidate.url, reason: `not_image_content_type:${contentType || 'unknown'}`, description } };
    }

    const buffer = Buffer.from(response.data);
    if (buffer.byteLength > options.maxBytes) {
      return { rejection: { url: candidate.url, reason: 'too_large', description } };
    }

    let dimensions;
    try {
      dimensions = imageSize(buffer);
    } catch (error: any) {
      return { rejection: { url: candidate.url, reason: `dimension_read_failed:${error.message || error}`, description } };
    }

    const width = Number(dimensions.width || 0);
    const height = Number(dimensions.height || 0);
    if (width < options.minWidth || height < options.minHeight) {
      return {
        rejection: {
          url: candidate.url,
          reason: `too_small:${width}x${height}_min_${options.minWidth}x${options.minHeight}`,
          description,
        },
      };
    }

    const ext = extensionFromContentType(contentType, candidate.url);
    const filename = `${options.fileStem}-${String(options.index).padStart(2, '0')}${ext}`;
    const filePath = path.join(options.outputDir, filename);
    await fs.writeFile(filePath, buffer);

    const score = scoreCandidate(candidate.url, description, width, height, options.queryTokens);
    return {
      asset: {
        filePath,
        publicPath: makePublicPath(filePath, options.outputDir, options.publicPath),
        sourceUrl: candidate.url,
        description,
        contentType,
        width,
        height,
        bytes: buffer.byteLength,
        score,
      },
    };
  } catch (error: any) {
    return {
      rejection: {
        url: candidate.url,
        reason: `download_failed:${error.message || String(error)}`,
        description,
      },
    };
  }
}

export const imageAssetSearchTool: ToolDefinition = {
  name: 'image_asset_search',
  description: `Search, download, and validate real image assets for websites, landing pages, apps, documents, and visual artifacts.

Use this instead of raw web_search images whenever you need image assets for a built website or UI. It rejects placeholder domains, verifies MIME type, checks image dimensions, filters obvious description mismatches, saves the files locally, and returns file paths plus browser-ready src paths.

For website projects, pass outputDir as the project's public asset folder, for example C:\\path\\project\\public\\eterx-assets, and publicPath as /eterx-assets. Use the returned publicPath values in React/HTML instead of remote image URLs.`,
  category: 'research',
  inputSchema: z.object({
    query: z.string().describe('Precise visual search query, including the exact subject, place, product, style, or scene needed.'),
    visualRole: z.enum(['hero', 'background', 'product', 'card', 'gallery', 'avatar', 'logo']).optional().default('card')
      .describe('How the image will be used in the design. This controls query hints and minimum dimensions.'),
    count: z.number().optional().default(3).describe('Number of final validated images to download.'),
    outputDir: z.string().optional().describe('Directory to save images. For Next/Vite apps, use the project public asset folder. Defaults to .workspaces/temp/image-assets.'),
    publicPath: z.string().optional().describe('Browser src base path for outputDir, e.g. /eterx-assets or assets/images.'),
    minWidth: z.number().optional().describe('Minimum accepted image width in pixels. Defaults by visualRole.'),
    minHeight: z.number().optional().describe('Minimum accepted image height in pixels. Defaults by visualRole.'),
    maxBytes: z.number().optional().default(8 * 1024 * 1024).describe('Maximum image download size in bytes.'),
    allowSvg: z.boolean().optional().default(false).describe('Allow SVG assets. Keep false for photos/backgrounds.'),
    strictDescriptionMatch: z.boolean().optional().default(true).describe('Reject candidates with a detailed image description that does not mention the query subject.'),
  }),
  outputSchema: z.any(),
  execute: async (input: {
    query: string;
    visualRole?: 'hero' | 'background' | 'product' | 'card' | 'gallery' | 'avatar' | 'logo';
    count?: number;
    outputDir?: string;
    publicPath?: string;
    minWidth?: number;
    minHeight?: number;
    maxBytes?: number;
    allowSvg?: boolean;
    strictDescriptionMatch?: boolean;
  }, context?: any) => {
    const role = input.visualRole || 'card';
    const count = Math.min(8, Math.max(1, input.count || 3));
    const roleMin = ROLE_MIN_SIZE[role] || ROLE_MIN_SIZE.card;
    const minWidth = Math.max(1, input.minWidth || roleMin.width);
    const minHeight = Math.max(1, input.minHeight || roleMin.height);
    const maxBytes = Math.max(128 * 1024, input.maxBytes || 8 * 1024 * 1024);
    const allowSvg = input.allowSvg === true;
    const strictDescriptionMatch = input.strictDescriptionMatch !== false;
    const outputDir = resolveOutputDir(input.outputDir, context);
    const fileStem = safeFilenameStem(input.query);
    const queryTokens = tokenize(input.query);
    const searchQuery = `${input.query} ${ROLE_QUERY_HINTS[role] || ROLE_QUERY_HINTS.card}`.trim();

    await fse.ensureDir(outputDir);

    console.log(`[Tool: image_asset_search] Searching images for: ${searchQuery}`);
    const client = getNextTavilyClient();
    const response = await client.search(searchQuery, {
      searchDepth: 'advanced',
      includeImages: true,
      includeImageDescriptions: true,
      includeAnswer: false,
      maxResults: Math.max(8, count * 5),
      excludeDomains: BAD_IMAGE_DOMAINS,
    });

    const rawImages: RawImageCandidate[] = Array.isArray(response.images)
      ? response.images
        .map((image: any) => ({
          url: String(image?.url || image || '').trim(),
          description: image?.description ? String(image.description).trim() : '',
        }))
        .filter(image => image.url)
      : [];

    const seen = new Set<string>();
    const candidates = rawImages.filter(image => {
      const key = image.url.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const accepted: AcceptedAsset[] = [];
    const rejected: RejectedAsset[] = [];
    let downloadIndex = 1;

    for (const candidate of candidates) {
      if (accepted.length >= count) break;
      const result = await downloadAndValidateImage(candidate, {
        allowSvg,
        maxBytes,
        minWidth,
        minHeight,
        outputDir,
        publicPath: input.publicPath,
        fileStem,
        index: downloadIndex,
        queryTokens,
        strictDescriptionMatch,
      });

      if (result.asset) {
        accepted.push(result.asset);
        downloadIndex++;
      } else if (result.rejection) {
        rejected.push(result.rejection);
      }
    }

    accepted.sort((a, b) => b.score - a.score);

    return {
      success: accepted.length > 0,
      query: input.query,
      searchQuery,
      visualRole: role,
      outputDir,
      requested: count,
      acceptedCount: accepted.length,
      assets: accepted,
      rejected: rejected.slice(0, 12),
      message: accepted.length > 0
        ? `Downloaded ${accepted.length} validated image asset(s). Use assets[].publicPath in website code.`
        : 'No validated image assets were downloaded. Try a more specific query or lower the minimum size.',
    };
  },
};
