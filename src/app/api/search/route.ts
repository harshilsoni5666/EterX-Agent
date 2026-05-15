import { NextResponse } from 'next/server';
import { webSearchTool } from '../../../lib/agent/tools/core/search';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { query } = await req.json();
    if (!query) {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    // Execute the Tavily Search core tool
    const results = await webSearchTool.execute({ query }, {} as any);
    return NextResponse.json({ results });
  } catch (error: any) {
    console.error('[API/Search] Error performing web search:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to search web' },
      { status: 500 }
    );
  }
}
