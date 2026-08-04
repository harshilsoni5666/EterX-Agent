import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import { resolveFinalArtifactPathForContext } from '../../workspace/path_resolver';
import { enforceToolCapability } from '../security/tool_policy';
import { executeImageGeneration } from '../../../image/image-generation-runtime';

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
    enhancedPrompt: z.string(),
    provider: z.string().optional(),
    model: z.string().optional(),
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
      const result = await executeImageGeneration({ prompt: finalPrompt, width: w, height: h, filePath });
      const savedName = result.filePath ? path.basename(result.filePath) : '';
      console.log(`[Tool: image_generator] ${result.message}`);
      return {
        success: result.success,
        filePath: result.filePath,
        enhancedPrompt: finalPrompt,
        provider: result.provider || undefined,
        model: result.model || undefined,
        message: result.success
          ? `${result.message}${savedName ? ` File: ${savedName}.` : ''}`
          : `${result.message} No placeholder was generated.`,
      };
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      console.warn(`[Tool: image_generator] API failed: ${errorMessage}`);
      return {
        success: false,
        filePath: '',
        enhancedPrompt: finalPrompt,
        message: `Image generation failed before a real raster asset was created: ${errorMessage}. No placeholder was generated.`,
      };
    }
  }
};
