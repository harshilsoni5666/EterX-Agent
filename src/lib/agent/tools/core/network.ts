import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as net from 'net';
import * as dns from 'dns/promises';
import os from 'os';
import { enforceToolCapability } from '../security/tool_policy';

const execFileAsync = promisify(execFile);

function normalizeHostTarget(target?: string): { success: true; value: string } | { success: false; error: string } {
  const trimmed = String(target || '').trim();
  if (!trimmed) return { success: false, error: 'target is required' };
  if (trimmed.length > 253) return { success: false, error: 'target is too long' };
  if (/[\0\r\n;&|`$<>"]/.test(trimmed)) return { success: false, error: 'target contains unsafe shell characters' };

  let host = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      host = new URL(trimmed).hostname;
    } catch {
      return { success: false, error: 'target URL is invalid' };
    }
  }

  host = host.replace(/^\[(.*)\]$/, '$1');
  if (net.isIP(host)) return { success: true, value: host };
  if (host.toLowerCase() === 'localhost') return { success: true, value: host };
  if (!/^[a-z0-9.-]+$/i.test(host)) return { success: false, error: 'target must be a hostname or IP address' };

  const labels = host.split('.');
  if (labels.some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) {
    return { success: false, error: 'target hostname is invalid' };
  }

  return { success: true, value: host };
}

function normalizeHttpTarget(target?: string): { success: true; value: string } | { success: false; error: string } {
  const trimmed = String(target || '').trim();
  if (!trimmed) return { success: false, error: 'target URL required' };
  if (/[\0\r\n]/.test(trimmed)) return { success: false, error: 'target URL contains unsafe characters' };

  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { success: false, error: 'only http and https URLs are supported' };
    }
    if (url.username || url.password) {
      return { success: false, error: 'URLs with embedded credentials are not allowed' };
    }
    const host = normalizeHostTarget(url.hostname);
    if (host.success === false) return host;
    return { success: true, value: url.toString() };
  } catch {
    return { success: false, error: 'target URL is invalid' };
  }
}

function parsePortList(ports?: string): { success: true; values: number[] } | { success: false; error: string } {
  const raw = ports || '21,22,25,80,443,3000,3306,5432,5000,8080,8443,9090';
  const values = new Set<number>();

  for (const part of raw.split(',').map(p => p.trim()).filter(Boolean)) {
    const range = /^(\d{1,5})-(\d{1,5})$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) {
        return { success: false, error: `invalid port range: ${part}` };
      }
      if (end - start + 1 > 100) {
        return { success: false, error: 'port range is too large; scan at most 100 ports per call' };
      }
      for (let port = start; port <= end; port++) values.add(port);
    } else {
      const port = Number(part);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { success: false, error: `invalid port: ${part}` };
      }
      values.add(port);
    }

    if (values.size > 100) {
      return { success: false, error: 'scan at most 100 ports per call' };
    }
  }

  return { success: true, values: Array.from(values) };
}

function checkPort(host: string, port: number): Promise<{ port: number; status: string }> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const finish = (status: string) => {
      socket.destroy();
      resolve({ port, status });
    };
    socket.setTimeout(1800);
    socket.once('connect', () => finish('OPEN'));
    socket.once('timeout', () => finish('CLOSED'));
    socket.once('error', () => finish('CLOSED'));
  });
}

/**
 * Network Tools — DNS, Ping, Port Scanning, IP Lookup
 * 
 * Essential for DevOps, server management, and network diagnostics.
 */
export const networkTool: ToolDefinition = {
  name: 'network_tools',
  description: `Network diagnostics and utilities: ping, DNS lookup, port scanning, IP info, HTTP health checks, traceroute, and WiFi info. Use this for server monitoring, connectivity checks, and network debugging.`,
  category: 'core',
  inputSchema: z.object({
    operation: z.enum(['ping', 'dns', 'ports', 'ip_info', 'http_check', 'traceroute', 'wifi', 'netstat'])
      .describe('Network operation to perform'),
    target: z.string().optional().describe('Target hostname, IP address, or URL'),
    ports: z.string().optional().describe('Ports to scan (e.g., "80,443,8080" or "1-1000")'),
    count: z.number().optional().default(4).describe('Number of pings (default: 4)')
  }),
  outputSchema: z.object({
    result: z.any(),
    success: z.boolean()
  }),
  execute: async (input: { operation: string, target?: string, ports?: string, count?: number }, context?: any) => {
    console.log(`[Tool: network_tools] Operation: ${input.operation}, Target: ${input.target}`);

    try {
      const decision = enforceToolCapability('network_tools', input, context);
      if (!decision.allowed) {
        return { success: false, result: decision.reason || 'Network diagnostics are not allowed' };
      }

      switch (input.operation) {
        case 'ping': {
          const target = normalizeHostTarget(input.target);
          if (target.success === false) return { success: false, result: target.error };
          const count = Math.min(10, Math.max(1, Math.floor(input.count || 4)));
          const { stdout } = await execFileAsync(
            'ping',
            [process.platform === 'win32' ? '-n' : '-c', String(count), target.value],
            { timeout: 30000, windowsHide: true }
          );
          return { success: true, result: String(stdout).trim() };
        }

        case 'dns': {
          const target = normalizeHostTarget(input.target);
          if (target.success === false) return { success: false, result: target.error };
          const records = await dns.lookup(target.value, { all: true });
          return { success: true, result: records };
        }

        case 'ports': {
          const target = normalizeHostTarget(input.target);
          if (target.success === false) return { success: false, result: target.error };
          const portList = parsePortList(input.ports);
          if (portList.success === false) return { success: false, result: portList.error };
          
          const results = await Promise.all(portList.values.map(port => checkPort(target.value, port)));

          return { success: true, result: { host: target.value, ports: results } };
        }

        case 'ip_info': {
          const localInterfaces = Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
            (addresses || []).filter(address => !address.internal).map(address => ({
              interface: name,
              address: address.address,
              family: address.family,
              netmask: address.netmask
            }))
          );
          let publicIp = 'unknown';
          try {
            const response = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(10000) });
            if (response.ok) publicIp = (await response.text()).trim();
          } catch { }

          return { success: true, result: { localInterfaces, publicIp } };
        }

        case 'http_check': {
          const url = normalizeHttpTarget(input.target);
          if (url.success === false) return { success: false, result: url.error };
          
          const startedAt = Date.now();
          const response = await fetch(url.value, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10000) });
          return {
            success: true,
            result: {
              status: response.status,
              timeMs: Date.now() - startedAt,
              server: response.headers.get('server'),
              contentType: response.headers.get('content-type')
            }
          };
        }

        case 'traceroute': {
          const target = normalizeHostTarget(input.target);
          if (target.success === false) return { success: false, result: target.error };
          const { stdout } = await execFileAsync(
            process.platform === 'win32' ? 'tracert' : 'traceroute',
            process.platform === 'win32' ? ['-d', '-h', '15', target.value] : ['-n', '-m', '15', target.value],
            { timeout: 60000, windowsHide: true }
          );
          return { success: true, result: String(stdout).trim().substring(0, 5000) };
        }

        case 'wifi': {
          const command = process.platform === 'win32'
            ? ['netsh', ['wlan', 'show', 'interfaces']] as const
            : process.platform === 'darwin'
              ? ['/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport', ['-I']] as const
              : ['nmcli', ['-t', '-f', 'ACTIVE,SSID,SIGNAL,SECURITY', 'dev', 'wifi']] as const;
          const { stdout } = await execFileAsync(command[0], [...command[1]]);
          return { success: true, result: stdout.trim() };
        }

        case 'netstat': {
          const { stdout } = await execFileAsync('netstat', process.platform === 'win32' ? ['-ano'] : ['-an']);
          return { success: true, result: stdout.trim().split(/\r?\n/).slice(0, 50).join('\n') };
        }

        default:
          return { success: false, result: 'Unknown operation' };
      }
    } catch (error: any) {
      return { success: false, result: `Network operation failed: ${error.message}` };
    }
  }
};
