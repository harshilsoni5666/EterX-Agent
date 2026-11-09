import { z } from 'zod';
import path from 'node:path';
import { ToolDefinition } from '../../schemas';
import { resolveFinalArtifactPathForContext } from '../../workspace/path_resolver';
import { enforceToolCapability } from '../security/tool_policy';
import { executeVideoGeneration } from '../../../video/video-generation-runtime';
import { VIDEO_PROVIDER_IDS, type VideoProvider } from '../../../video/video-generation-config';

/** Generate a real video file through the live External service video route. */
export const videoGenTool: ToolDefinition = {
  name: 'video_generator',
  description: `Generate a real video file from a prompt using the live Video generation route in External service settings.

Use for text-to-video, cinematic clips, animation, product motion, social clips, storyboards, and image-to-video when a public imageUrl is available. The route exposes Google Veo, OpenAI Sora, Runway, Luma, MiniMax Hailuo, direct ByteDance Seedance through Volcengine Ark, FAL open-model routes, Replicate open-source models, and xAI Grok Imagine Video. FAL and Replicate accept exact current model IDs.

The tool reads the current provider, model, enabled fallbacks, and key pool for every call. It returns success only after downloading real video bytes with an MP4, WebM, or Ogg file signature. If imageUrl is provided, it must be a URL accepted by the selected provider. You may select any enabled provider for this call. If providerActionMode is pending, resume with the returned job's provider, model, and id as jobId; do not submit another generation. Failures include the attempted providers and reasons.`,
  category: 'core',
  inputSchema: z.object({
    prompt: z.string().describe('Detailed description of the scene, motion, camera, subject, style, lighting, and timing.'),
    width: z.number().optional().default(1280).describe('Requested width in pixels.'),
    height: z.number().optional().default(720).describe('Requested height in pixels.'),
    duration: z.number().optional().default(5).describe('Requested duration in seconds.'),
    imageUrl: z.string().url().optional().describe('Optional public image URL to animate as the first frame.'),
    model: z.string().optional().describe('Optional exact model ID for the active provider, useful for current FAL or Replicate catalogs.'),
    provider: z.enum(VIDEO_PROVIDER_IDS).optional().describe('Optional enabled video provider to try first.'),
    jobId: z.string().trim().min(1).optional().describe('Resume an existing generation using its returned provider and model.'),
    filename: z.string().optional().describe('Custom output filename. Default: generated_<timestamp>.mp4'),
    enhancePrompt: z.boolean().optional().default(true).describe('Add concise motion and cinematography guidance to the prompt.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    filePath: z.string(),
    message: z.string(),
    enhancedPrompt: z.string(),
    provider: z.string().optional(),
    model: z.string().optional(),
    providerActionMode: z.string().optional(),
    attemptedProviders: z.array(z.string()).optional(),
    failedProviders: z.array(z.object({ provider: z.string(), model: z.string(), error: z.string() })).optional(),
    job: z.object({ provider: z.string(), model: z.string(), id: z.string() }).optional(),
    downloadURL: z.string().optional(),
  }),
  execute: async (input: {
    prompt: string;
    width?: number;
    height?: number;
    duration?: number;
    imageUrl?: string;
    model?: string;
    provider?: VideoProvider;
    jobId?: string;
    filename?: string;
    enhancePrompt?: boolean;
  }, context?: any) => {
    const policy = enforceToolCapability('video_generator', input, context);
    if (!policy.allowed) return { success: false, filePath: '', enhancedPrompt: input.prompt, message: policy.reason || 'video_generator is not allowed in this context' };

    const filename = input.filename || `generated_${Date.now()}.mp4`;
    const filePath = resolveFinalArtifactPathForContext(filename, '.mp4', undefined, context);
    const enhancedPrompt = input.enhancePrompt === false
      ? input.prompt
      : `${input.prompt}. Natural subject motion, coherent temporal continuity, deliberate camera movement, consistent lighting, polished professional composition.`;
    console.log(`[Tool: video_generator] Generating: "${input.prompt.substring(0, 80)}..."`);
    try {
      const result = await executeVideoGeneration({
        prompt: enhancedPrompt,
        width: Math.min(1920, Math.max(512, input.width || 1280)),
        height: Math.min(1920, Math.max(512, input.height || 720)),
        duration: Math.min(12, Math.max(4, input.duration || 5)),
        imageUrl: input.imageUrl,
        model: input.model,
        provider: input.provider,
        jobId: input.jobId,
        filePath,
      }, context);
      const name = result.filePath ? path.basename(result.filePath) : '';
      return {
        ...result,
        enhancedPrompt,
        provider: result.provider || undefined,
        model: result.model || undefined,
        message: result.success ? `${result.message}${name ? ` File: ${name}.` : ''}` : `${result.message} No placeholder was generated.`,
      };
    } catch (error: any) {
      return { success: false, filePath: '', enhancedPrompt, message: `Video generation failed before a real video asset was created: ${error?.message || String(error)}. No placeholder was generated.` };
    }
  },
};
