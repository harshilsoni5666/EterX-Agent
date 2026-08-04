import { execFile } from 'child_process';
import { promisify } from 'util';
import { capturePlatformScreen } from './platform-screen';
import { isExecutableAvailable } from '../tools/core/shell_resolver';

const execFileAsync = promisify(execFile);

export type PlatformOcrWord = {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  confidence: number;
};

export type PlatformOcrResult = {
  available: boolean;
  provider: string;
  text: string;
  words: PlatformOcrWord[];
  error?: string;
};

/** Read visible desktop text on macOS/Linux when the optional tesseract CLI is installed. */
export async function readPlatformScreenText(): Promise<PlatformOcrResult> {
  const provider = `${process.platform} tesseract OCR`;
  if (process.platform === 'win32') {
    return { available: false, provider, text: '', words: [], error: 'Use the Windows OCR backend.' };
  }
  if (!isExecutableAvailable(['tesseract'])) {
    return {
      available: false,
      provider,
      text: '',
      words: [],
      error: 'Install the tesseract command-line OCR package to enable cross-platform screen text and find actions.',
    };
  }

  const screenshot = await capturePlatformScreen('ocr', { target: 'fullscreen' });
  if (!screenshot) {
    return {
      available: false,
      provider,
      text: '',
      words: [],
      error: 'Screen capture failed. Grant screen-recording permission or install a supported screenshot utility.',
    };
  }

  try {
    const { stdout } = await execFileAsync('tesseract', [screenshot.path, 'stdout', '--psm', '6', 'tsv'], {
      timeout: 30_000,
      maxBuffer: 12 * 1024 * 1024,
    });
    const words = String(stdout || '')
      .split(/\r?\n/)
      .slice(1)
      .map(line => line.split('\t'))
      .filter(columns => columns.length >= 12 && columns[11]?.trim())
      .map(columns => ({
        text: columns[11].trim(),
        left: Number(columns[6]) || 0,
        top: Number(columns[7]) || 0,
        width: Number(columns[8]) || 0,
        height: Number(columns[9]) || 0,
        confidence: Number(columns[10]) || 0,
      }));
    return { available: true, provider, text: words.map(word => word.text).join(' '), words };
  } catch (error: any) {
    return {
      available: false,
      provider,
      text: '',
      words: [],
      error: `OCR failed: ${String(error?.message || error).slice(0, 300)}`,
    };
  }
}
