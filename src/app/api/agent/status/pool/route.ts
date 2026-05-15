import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../../lib/agent/agent-registry';
import { apiKeyPool } from '../../../../../lib/agent/api-key-pool';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/agent/status/pool — Get API key pool and agent registry status
 * 
 * Used by the frontend to show pool health, active agents, available capacity.
 */
export async function GET() {
  try {
    const pool = apiKeyPool.getPoolStatus();
    const agents = agentRegistry.getAllStatus();
    const canAcceptNew = apiKeyPool.canAcceptNewAgent();

    return NextResponse.json({
      pool,
      agents,
      canAcceptNew,
      maxParallel: apiKeyPool.maxParallelAgents,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
