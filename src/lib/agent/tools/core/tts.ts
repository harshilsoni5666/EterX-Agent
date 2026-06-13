import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs-extra';
import { resolveFinalArtifactPathForContext } from '../../workspace/path_resolver';
import { enforceToolCapability } from '../security/tool_policy';

const execAsync = promisify(exec);

function psQuote(value: unknown): string {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function ensureExtension(filePath: string, extension: string): string {
  return filePath.toLowerCase().endsWith(extension.toLowerCase()) ? filePath : `${filePath}${extension}`;
}

/**
 * Text-to-Speech Tool
 * 
 * Converts text into speech audio using Edge TTS (Microsoft) via PowerShell.
 * Free, no API key needed. Returns an audio file path.
 */
export const ttsTool: ToolDefinition = {
  name: 'text_to_speech',
  description: 'Convert text into spoken audio (MP3). Uses Microsoft Edge TTS voices for natural speech. Returns the file path to the generated audio. Use this for voice messages, accessibility, audio content generation, or audio notifications.',
  category: 'core',
  inputSchema: z.object({
    text: z.string().describe('The text to convert to speech'),
    voice: z.enum([
      'en-US-GuyNeural', 'en-US-JennyNeural', 'en-US-AriaNeural',
      'en-GB-SoniaNeural', 'en-GB-RyanNeural',
      'en-IN-NeerjaNeural', 'en-IN-PrabhatNeural',
      'hi-IN-SwaraNeural', 'hi-IN-MadhurNeural'
    ]).optional().default('en-US-GuyNeural').describe('Voice to use for speech synthesis'),
    filename: z.string().optional().describe('Custom filename for the audio file')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    filePath: z.string(),
    message: z.string()
  }),
  execute: async (input: { text: string, voice?: string, filename?: string }, context?: any) => {
    const decision = enforceToolCapability('text_to_speech', input, context);
    if (!decision.allowed) {
      return { success: false, filePath: '', message: decision.reason || 'Text-to-speech is not allowed' };
    }

    const voice = input.voice || 'en-US-GuyNeural';
    const filename = input.filename || `speech_${Date.now()}.wav`;
    const filePath = ensureExtension(resolveFinalArtifactPathForContext(filename, '.wav', undefined, context), '.wav');
    await fs.ensureDir(path.dirname(filePath));
    const textEscaped = input.text.substring(0, 5000);

    console.log(`[Tool: text_to_speech] Converting ${input.text.length} chars with voice: ${voice}`);

    try {
      // Use PowerShell with System.Speech (built-in Windows TTS) as primary
      // Then save to WAV/MP3
      const psScript = `
        Add-Type -AssemblyName System.Speech;
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;
        $synth.SetOutputToWaveFile(${psQuote(filePath)});
        $synth.Speak(${psQuote(textEscaped)});
        $synth.Dispose();
        Write-Output 'Speech generated successfully.';
      `.trim();

      const wavPath = filePath;
      await execAsync(psScript, { shell: 'powershell.exe' });

      // Check if file was created
      if (await fs.pathExists(wavPath)) {
        const stats = await fs.stat(wavPath);
        return {
          success: true,
          filePath: wavPath,
          message: `Audio generated: ${path.basename(wavPath)} (${(stats.size / 1024).toFixed(1)} KB) using System.Speech TTS`
        };
      }

      return { success: false, filePath, message: 'TTS command ran but no audio file was created.' };

    } catch (error: any) {
      // Fallback: Try using PowerShell SpeechSynthesizer with different approach
      try {
        const fallbackScript = `
          Add-Type -AssemblyName System.Speech;
          $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;
          $stream = New-Object System.IO.MemoryStream;
          $synth.SetOutputToWaveStream($stream);
          $synth.Speak(${psQuote(textEscaped)});
          $bytes = $stream.ToArray();
          [System.IO.File]::WriteAllBytes(${psQuote(filePath)}, $bytes);
          $synth.Dispose();
          $stream.Dispose();
          Write-Output 'OK';
        `.trim();

        const wavPath = filePath;
        await execAsync(fallbackScript, { shell: 'powershell.exe' });
        
        if (await fs.pathExists(wavPath)) {
          return { success: true, filePath: wavPath, message: `Audio generated (fallback): ${path.basename(wavPath)}` };
        }
        return { success: false, filePath, message: 'Fallback TTS also failed to create audio.' };
      } catch (fallbackErr: any) {
        return { success: false, filePath, message: `TTS failed: ${error.message}. Fallback also failed: ${fallbackErr.message}` };
      }
    }
  }
};
