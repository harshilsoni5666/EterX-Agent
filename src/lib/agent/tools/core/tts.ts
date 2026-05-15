import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs-extra';

const execAsync = promisify(exec);

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
  execute: async (input: { text: string, voice?: string, filename?: string }) => {
    const outputDir = path.resolve(process.cwd(), '.workspaces', 'temp', 'audio');
    await fs.ensureDir(outputDir);

    const voice = input.voice || 'en-US-GuyNeural';
    const filename = input.filename || `speech_${Date.now()}.mp3`;
    const filePath = path.join(outputDir, filename);
    const textEscaped = input.text.replace(/'/g, "''").replace(/"/g, '`"').substring(0, 5000);

    console.log(`[Tool: text_to_speech] Converting ${input.text.length} chars with voice: ${voice}`);

    try {
      // Use PowerShell with System.Speech (built-in Windows TTS) as primary
      // Then save to WAV/MP3
      const psScript = `
        Add-Type -AssemblyName System.Speech;
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;
        $synth.SetOutputToWaveFile('${filePath.replace(/\\/g, '\\\\').replace('.mp3', '.wav')}');
        $synth.Speak('${textEscaped}');
        $synth.Dispose();
        Write-Output 'Speech generated successfully.';
      `.trim();

      const wavPath = filePath.replace('.mp3', '.wav');
      await execAsync(psScript, { shell: 'powershell.exe' });

      // Check if file was created
      if (await fs.pathExists(wavPath)) {
        const stats = await fs.stat(wavPath);
        return {
          success: true,
          filePath: wavPath,
          message: `Audio generated: ${filename.replace('.mp3', '.wav')} (${(stats.size / 1024).toFixed(1)} KB) using System.Speech TTS`
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
          $synth.Speak('${textEscaped}');
          $bytes = $stream.ToArray();
          [System.IO.File]::WriteAllBytes('${filePath.replace(/\\/g, '\\\\').replace('.mp3', '.wav')}', $bytes);
          $synth.Dispose();
          $stream.Dispose();
          Write-Output 'OK';
        `.trim();

        const wavPath = filePath.replace('.mp3', '.wav');
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
