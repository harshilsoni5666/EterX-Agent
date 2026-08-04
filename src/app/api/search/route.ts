import { NextRequest, NextResponse } from 'next/server';
import { webSearchTool } from '../../../lib/agent/tools/core/search';
import { rejectCrossOrigin } from '../agent/_shared';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const {
      query,
      includeImages = false,
      includeImageDescriptions = true,
      includeRawContent = false,
      searchDepth = 'basic',
      topic = 'general',
      numResults = 5,
    } = await req.json();

    if (!query) {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    // Execute the configured External service search route.
    const results = await webSearchTool.execute({
      action: 'search',
      query,
      includeImages,
      includeImageDescriptions,
      includeRawContent,
      searchDepth,
      topic,
      numResults,
    }, { source: 'api_search', allowNetwork: true, networkPolicy: 'allow' } as any);

    return NextResponse.json({ results });
  } catch (error: any) {
    console.error('[API/Search] Error performing web search:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to search web' },
      { status: 500 }
    );
  }
}
