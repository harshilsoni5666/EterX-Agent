import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import axios from 'axios';

/**
 * YouTube Transcript Extractor
 * 
 * Extracts video transcripts using YouTube's internal timedtext API.
 * No API key required — works by fetching the video page and extracting captions.
 */
export const youtubeTranscriptTool: ToolDefinition = {
  name: 'youtube_transcript',
  description: 'Extract and return the transcript/captions from a YouTube video. Use this to summarize YouTube content, extract information from tutorials, lectures, or any video. Provide the YouTube URL or video ID.',
  category: 'research',
  inputSchema: z.object({
    videoUrl: z.string().describe('YouTube video URL or video ID (e.g., "https://youtube.com/watch?v=xxx" or just "xxx")'),
    language: z.string().optional().default('en').describe('Language code for transcript (default: en)')
  }),
  outputSchema: z.object({
    transcript: z.string(),
    segments: z.number(),
    error: z.string().optional()
  }),
  execute: async (input: { videoUrl: string, language?: string }) => {
    console.log(`[Tool: youtube_transcript] Extracting transcript from: ${input.videoUrl}`);

    try {
      // Extract video ID from URL
      let videoId = input.videoUrl;
      const urlMatch = input.videoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
      if (urlMatch) videoId = urlMatch[1];

      // Fetch the video page to extract caption track info
      const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const { data: pageHtml } = await axios.get(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });

      // Extract captions from ytInitialPlayerResponse
      const captionMatch = pageHtml.match(/"captionTracks":\s*(\[.*?\])/);
      if (!captionMatch) {
        return { transcript: '', segments: 0, error: 'No captions/transcript available for this video. The video may not have subtitles enabled.' };
      }

      const captionTracks = JSON.parse(captionMatch[1]);
      const lang = input.language || 'en';
      
      // Find the requested language track, fallback to first available
      let track = captionTracks.find((t: any) => t.languageCode === lang);
      if (!track) track = captionTracks[0];

      if (!track || !track.baseUrl) {
        return { transcript: '', segments: 0, error: `No caption track found for language: ${lang}. Available: ${captionTracks.map((t: any) => t.languageCode).join(', ')}` };
      }

      // Fetch the actual transcript XML
      const { data: transcriptXml } = await axios.get(track.baseUrl);
      
      // Parse XML transcript
      const textSegments: string[] = [];
      const segmentRegex = /<text[^>]*>(.*?)<\/text>/gs;
      let match;
      while ((match = segmentRegex.exec(transcriptXml)) !== null) {
        let text = match[1]
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/<[^>]*>/g, '') // Strip any inner HTML tags
          .trim();
        if (text) textSegments.push(text);
      }

      const fullTranscript = textSegments.join(' ');
      
      return {
        transcript: fullTranscript.substring(0, 50000), // Cap at 50k chars
        segments: textSegments.length,
        videoId,
        language: track.languageCode
      };

    } catch (error: any) {
      return { transcript: '', segments: 0, error: `Failed to extract transcript: ${error.message}` };
    }
  }
};
