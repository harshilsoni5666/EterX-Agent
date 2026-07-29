import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { enforceToolCapability } from '../security/tool_policy';
import { resolveTerminalShell } from './shell_resolver';

const execFileAsync = promisify(execFile);

export const systemMonitorTool: ToolDefinition = {
  name: 'system_monitor',
  description: 'Monitor system resources: CPU usage, RAM, disk space, running processes, uptime, network interfaces. Use this to diagnose performance issues, check server health, or gather system intelligence.',
  category: 'core',
  inputSchema: z.object({
    check: z.enum(['all', 'cpu', 'memory', 'disk', 'processes', 'network', 'uptime']).default('all')
      .describe('What system metric to check. "all" returns a comprehensive overview.')
  }),
  outputSchema: z.object({
    metrics: z.any()
  }),
  execute: async (input: { check: string }, context?: any) => {
    console.log(`[Tool: system_monitor] Checking: ${input.check}`);
    const decision = enforceToolCapability('system_monitor', input, context);
    if (!decision.allowed) {
      return { metrics: { error: decision.reason || 'System monitoring is not allowed' } };
    }

    const metrics: any = {};

    const getCpu = () => {
      const cpus = os.cpus();
      const avgLoad = os.loadavg();
      const cpuModel = cpus[0]?.model || 'Unknown';
      const cpuCount = cpus.length;
      
      // Calculate CPU usage percentage
      let totalIdle = 0, totalTick = 0;
      cpus.forEach(cpu => {
        for (const type in cpu.times) {
          totalTick += (cpu.times as any)[type];
        }
        totalIdle += cpu.times.idle;
      });
      const usagePercent = ((1 - totalIdle / totalTick) * 100).toFixed(1);

      return {
        model: cpuModel,
        cores: cpuCount,
        usagePercent: `${usagePercent}%`,
        loadAverage: { '1min': avgLoad[0]?.toFixed(2), '5min': avgLoad[1]?.toFixed(2), '15min': avgLoad[2]?.toFixed(2) }
      };
    };

    const getMemory = () => {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      return {
        total: `${(totalMem / 1073741824).toFixed(2)} GB`,
        used: `${(usedMem / 1073741824).toFixed(2)} GB`,
        free: `${(freeMem / 1073741824).toFixed(2)} GB`,
        usagePercent: `${((usedMem / totalMem) * 100).toFixed(1)}%`
      };
    };

    const getUptime = () => {
      const upSec = os.uptime();
      const days = Math.floor(upSec / 86400);
      const hours = Math.floor((upSec % 86400) / 3600);
      const mins = Math.floor((upSec % 3600) / 60);
      return { seconds: upSec, formatted: `${days}d ${hours}h ${mins}m` };
    };

    const getNetwork = () => {
      const interfaces = os.networkInterfaces();
      const result: any[] = [];
      for (const [name, addrs] of Object.entries(interfaces)) {
        if (addrs) {
          for (const addr of addrs) {
            if (!addr.internal) {
              result.push({ interface: name, address: addr.address, family: addr.family, mac: addr.mac });
            }
          }
        }
      }
      return result;
    };

    const getDisk = async () => {
      try {
        if (process.platform !== 'win32') {
          const { stdout } = await execFileAsync('df', ['-kP']);
          return stdout.trim().split(/\r?\n/).slice(1).map(line => {
            const parts = line.trim().split(/\s+/);
            const total = Number(parts[1]) * 1024;
            const used = Number(parts[2]) * 1024;
            const free = Number(parts[3]) * 1024;
            return {
              drive: parts.slice(5).join(' ') || parts[0],
              total: `${(total / 1073741824).toFixed(1)} GB`,
              free: `${(free / 1073741824).toFixed(1)} GB`,
              used: `${(used / 1073741824).toFixed(1)} GB`,
              usagePercent: parts[4] || 'N/A'
            };
          });
        }
        const powerShell = String(resolveTerminalShell('powershell'));
        const { stdout } = await execFileAsync(powerShell, [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress',
        ]);
        const parsed = JSON.parse(stdout.trim() || '[]');
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        const disks = rows.filter(Boolean).map((row: any) => {
          const free = Number(row.FreeSpace) || 0;
          const total = Number(row.Size) || 0;
          const used = total - free;
          return {
            drive: row.DeviceID || 'Unknown',
            total: `${(total / 1073741824).toFixed(1)} GB`,
            free: `${(free / 1073741824).toFixed(1)} GB`,
            used: `${(used / 1073741824).toFixed(1)} GB`,
            usagePercent: total > 0 ? `${((used / total) * 100).toFixed(1)}%` : 'N/A',
          };
        });
        return disks.length > 0 ? disks : [{ info: 'Could not parse disk info' }];
      } catch (e: any) {
        return [{ error: e.message }];
      }
    };

    const getProcesses = async () => {
      try {
        if (process.platform !== 'win32') {
          const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,comm=,rss=,%cpu=', '-r']);
          return stdout.trim().split(/\r?\n/).slice(0, 15).join('\n');
        }
        const powerShell = String(resolveTerminalShell('powershell'));
        const { stdout } = await execFileAsync(powerShell, [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-Process | Sort-Object -Property WorkingSet64 -Descending | Select-Object -First 15 Name, Id, @{Name="MemMB";Expression={[math]::Round($_.WorkingSet64/1MB,1)}}, CPU | Format-Table -AutoSize | Out-String -Width 200',
        ]);
        return stdout.trim();
      } catch (e: any) {
        return `Error fetching processes: ${e.message}`;
      }
    };

    try {
      if (input.check === 'all' || input.check === 'cpu') metrics.cpu = getCpu();
      if (input.check === 'all' || input.check === 'memory') metrics.memory = getMemory();
      if (input.check === 'all' || input.check === 'uptime') metrics.uptime = getUptime();
      if (input.check === 'all' || input.check === 'network') metrics.network = getNetwork();
      if (input.check === 'all' || input.check === 'disk') metrics.disk = await getDisk();
      if (input.check === 'all' || input.check === 'processes') metrics.topProcesses = await getProcesses();

      metrics.platform = { os: os.platform(), arch: os.arch(), hostname: os.hostname(), release: os.release() };
      return { metrics };
    } catch (error: any) {
      return { metrics: { error: error.message } };
    }
  }
};
