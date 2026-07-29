import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs/promises';
import fse from 'fs-extra';
import { resolveFinalArtifactPathForContext } from '../../workspace/path_resolver';
import { safeAxiosRequest } from '../shared/url_safety';
import { enforceToolCapability } from '../security/tool_policy';

/**
 * AI Image Generator Tool
 *
 * Use for creative raster images only: photos, illustrations, product shots,
 * UI mockups, visual concepts, and bitmap assets. For accurate data
 * visualization, use office_artifact_builder spreadsheet charts instead.
 */

const STYLE_ENHANCERS: Record<string, string> = {
  realistic: 'photorealistic, high resolution, natural lighting, sharp focus, detailed textures, professional photography',
  illustration: 'digital illustration, vibrant colors, clean lines, concept art, detailed, beautiful composition',
  diagram: 'technical diagram, clean layout, labeled, professional, minimalist, infographic style, clear typography',
  icon: 'flat design icon, clean vector-style composition, minimal, geometric, professional, centered',
  abstract: 'abstract art, vibrant gradients, flowing shapes, creative, dynamic composition, modern art, bold colors',
  photo: 'professional photograph, high resolution, natural lighting, editorial quality, magazine style',
  '3d': '3D render, detailed, volumetric lighting, professional 3D, cinema quality',
  anime: 'anime style, detailed, studio quality, vibrant, beautiful lighting',
  logo: 'professional logo concept, clean, minimal, brand identity, modern, scalable, centered',
  ui: 'UI design mockup, clean interface, modern web design, premium, professional',
  product: 'product photography, studio lighting, professional commercial image, high detail, centered',
  landscape: 'landscape photography, golden hour, panoramic, high resolution, cinematic',
};

const QUALITY_BOOSTERS = ['masterpiece', 'best quality', 'highly detailed'];

function ensureExtension(filePath: string, extension: string): string {
  return filePath.toLowerCase().endsWith(extension.toLowerCase()) ? filePath : `${filePath}${extension}`;
}

export const imageGenTool: ToolDefinition = {
  name: 'image_generator',
  description: `Generate real raster images from text descriptions.

Use for creative images: photos, illustrations, product shots, UI mockups, cover art, sprites, visual concepts, and bitmap assets.

Do NOT use for accurate charts or data visualizations; use office_artifact_builder spreadsheet charts.
Do NOT return SVG/HTML placeholders when the user requested a generated raster image.

Styles: realistic, illustration, diagram, icon, abstract, photo, 3d, anime, logo, ui, product, landscape.`,
  category: 'core',
  inputSchema: z.object({
    prompt: z.string().describe('Detailed image prompt. Include content, style, colors, composition, lighting, exact text, and constraints when relevant.'),
    style: z.enum(['realistic', 'illustration', 'diagram', 'icon', 'abstract', 'photo', '3d', 'anime', 'logo', 'ui', 'product', 'landscape'])
      .optional().default('illustration').describe('Visual style preset'),
    width: z.number().optional().default(1024).describe('Width in pixels (512-1920)'),
    height: z.number().optional().default(1024).describe('Height in pixels (512-1920)'),
    filename: z.string().optional().describe('Custom filename. Default: generated_<timestamp>.png'),
    enhancePrompt: z.boolean().optional().default(true).describe('Auto-enhance the prompt with style and quality modifiers')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    filePath: z.string(),
    message: z.string(),
    enhancedPrompt: z.string()
  }),
  execute: async (input: {
    prompt: string,
    style?: string,
    width?: number,
    height?: number,
    filename?: string,
    enhancePrompt?: boolean
  }, context?: any) => {
    const policy = enforceToolCapability('image_generator', input, context);
    if (!policy.allowed) {
      return {
        success: false,
        filePath: '',
        enhancedPrompt: String(input?.prompt || ''),
        message: policy.reason || 'image_generator is not allowed in this context',
      };
    }

    const filename = input.filename || `generated_${Date.now()}.png`;
    const filePath = ensureExtension(resolveFinalArtifactPathForContext(filename, '.png', undefined, context), '.png');
    const outputDir = path.dirname(filePath);
    await fse.ensureDir(outputDir);

    const w = Math.min(1920, Math.max(512, input.width || 1024));
    const h = Math.min(1920, Math.max(512, input.height || 1024));
    const style = input.style || 'illustration';

    let finalPrompt = input.prompt;
    if (input.enhancePrompt !== false) {
      const styleEnhancer = STYLE_ENHANCERS[style] || STYLE_ENHANCERS.illustration;
      finalPrompt = `${input.prompt}, ${styleEnhancer}, ${QUALITY_BOOSTERS.join(', ')}`;
    }

    console.log(`[Tool: image_generator] Generating (${style}): "${input.prompt.substring(0, 60)}..."`);
    console.log(`[Tool: image_generator] Enhanced: "${finalPrompt.substring(0, 100)}..."`);

    try {
      const apiKey = process.env.FREEPIK_API_KEY
        || process.env.ETERX_FREEPIK_API_KEY;
      if (!apiKey) {
        return {
          success: false,
          filePath,
          enhancedPrompt: finalPrompt,
          message: 'Missing FREEPIK_API_KEY or ETERX_FREEPIK_API_KEY. Configure the key in the environment or secret vault before using image generation.',
        };
      }

      const payload = {
        prompt: finalPrompt,
        aspect_ratio: w > h ? 'widescreen_16_9' : h > w ? 'portrait_9_16' : 'square_1_1'
      };

      console.log('[Tool: image_generator] Submitting task to Freepik API (flux-dev)...');
      const postRes = await safeAxiosRequest({
        url: 'https://api.freepik.com/v1/ai/text-to-image/flux-dev',
        method: 'POST',
        data: payload,
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          'x-freepik-api-key': apiKey
        }
      }, context);

      const taskId = postRes.data?.data?.task_id;
      if (!taskId) throw new Error('No task_id returned from Freepik API');

      console.log(`[Tool: image_generator] Task created: ${taskId}. Polling for completion...`);

      let generatedUrl = '';
      for (let attempts = 0; attempts < 30; attempts++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const statusRes = await safeAxiosRequest({
          url: `https://api.freepik.com/v1/ai/text-to-image/flux-dev/${taskId}`,
          method: 'GET',
          timeout: 15000,
          headers: { 'x-freepik-api-key': apiKey }
        }, context);

        const status = statusRes.data?.data?.status;
        if (status === 'COMPLETED') {
          generatedUrl = statusRes.data?.data?.generated?.[0];
          break;
        }
        if (status === 'FAILED') {
          throw new Error('Freepik API task failed');
        }
      }

      if (!generatedUrl) {
        throw new Error('Task timed out after 60 seconds');
      }

      console.log(`[Tool: image_generator] Task complete. Downloading image from: ${generatedUrl}`);
      const imageRes = await safeAxiosRequest<ArrayBuffer>({
        url: generatedUrl,
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 15 * 1024 * 1024,
        maxBodyLength: 15 * 1024 * 1024,
      }, context);

      await fs.writeFile(filePath, Buffer.from(imageRes.data));
      const stats = await fs.stat(filePath);

      const savedName = path.basename(filePath);
      console.log(`[Tool: image_generator] Image saved: ${savedName} (${(stats.size / 1024).toFixed(1)} KB)`);

      return {
        success: true,
        filePath,
        enhancedPrompt: finalPrompt,
        message: `Real raster image generated: ${savedName} (${(stats.size / 1024).toFixed(1)} KB). Saved at: ${filePath}`
      };
    } catch (apiError: any) {
      const errorMessage = apiError?.message || String(apiError);
      console.warn(`[Tool: image_generator] API failed: ${errorMessage}`);

      return {
        success: false,
        filePath: '',
        enhancedPrompt: finalPrompt,
        message: `Image generation failed before a real raster asset was created: ${errorMessage}. No placeholder was generated. Retry with a working image provider or use a code-native SVG/HTML asset only if the user explicitly wants that format.`
      };
    }
  }
};
