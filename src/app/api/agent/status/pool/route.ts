import { NextResponse } from 'next/server';
import { agentRegistry } from '../../../../../lib/agent/agent-registry';
import { apiKeyPool } from '../../../../../lib/agent/api-key-pool';
import { taskStore } from '../../../../../lib/agent/task-store';

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
    const tasks = taskStore.getCacheStatus();
    const canAcceptNew = apiKeyPool.canAcceptNewAgent();
    const memory = process.memoryUsage();

    return NextResponse.json({
      pool,
      agents,
      tasks,
      canAcceptNew,
      maxParallel: apiKeyPool.maxParallelAgents,
      runtime: {
        uptimeSec: Math.round(process.uptime()),
        rssMB: Math.round(memory.rss / 1024 / 1024),
        heapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(memory.heapTotal / 1024 / 1024),
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
