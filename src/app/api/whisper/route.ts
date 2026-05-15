import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
    }

    // Read the file bytes properly
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Normalize mimeType — strip codecs parameter which can confuse APIs
    let mimeType = (file.type || 'audio/webm').split(';')[0].trim();
    // Map to Groq-supported types
    const supportedTypes = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg', 'audio/flac'];
    if (!supportedTypes.includes(mimeType)) {
      mimeType = 'audio/webm'; // fallback
    }

    // Determine file extension
    const extMap: Record<string, string> = {
      'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4',
      'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/flac': 'flac'
    };
    const ext = extMap[mimeType] || 'webm';
    const fileName = `audio.${ext}`;

    console.log('[Whisper] Received:', fileName, 'size:', buffer.length, 'originalType:', file.type, 'normalizedType:', mimeType);

    if (buffer.length < 500) {
      console.warn('[Whisper] Audio too small, likely silent');
      return NextResponse.json({ text: '', filtered: true, reason: 'too_short' });
    }

    // Build fresh FormData for Groq with clean mimeType
    const groqForm = new FormData();
    const audioBlob = new Blob([buffer], { type: mimeType });
    groqForm.append('file', audioBlob, fileName);
    groqForm.append('model', 'whisper-large-v3-turbo');
    groqForm.append('response_format', 'verbose_json'); // verbose gives us more info
    groqForm.append('language', 'en');

    const groqResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: groqForm
    });

    if (!groqResponse.ok) {
      const errorText = await groqResponse.text();
      console.error('[Whisper] Groq API Error:', errorText);
      return NextResponse.json({ error: 'Groq API transcription failed', filtered: true, reason: 'api_error' }, { status: groqResponse.status });
    }

    const data = await groqResponse.json();
    const transcribedText = data.text || '';
    console.log('[Whisper] Result:', JSON.stringify(data).slice(0, 300));

    // Filter Whisper hallucinations (common on silent/ambient-only audio)
    const normalized = transcribedText.trim().toLowerCase().replace(/[.!?,\s]+/g, ' ').trim();
    const hallucinations = [
      'thank you', 'thanks for watching', 'bye', 'you', 'thanks',
      'the end', 'thanks for listening', 'goodbye', 'see you',
      'subscribe', 'like and subscribe'
    ];
    if (hallucinations.some(h => normalized === h || normalized === '')) {
      console.warn('[Whisper] Filtered hallucination:', transcribedText);
      return NextResponse.json({ text: '', filtered: true, reason: 'hallucination' });
    }

    return NextResponse.json({ text: transcribedText });
  } catch (error: any) {
    console.error('[Whisper] Route error:', error);
    return NextResponse.json({ error: error.message, filtered: true, reason: 'exception' }, { status: 500 });
  }
}
