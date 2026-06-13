import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as net from 'net';
import { enforceToolCapability } from '../security/tool_policy';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

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
            ['-n', String(count), target.value],
            { timeout: 30000, windowsHide: true }
          );
          return { success: true, result: String(stdout).trim() };
        }

        case 'dns': {
          const target = normalizeHostTarget(input.target);
          if (target.success === false) return { success: false, result: target.error };
          const { stdout } = await execAsync(
            `Resolve-DnsName -Name ${psQuote(target.value)} -Type A | Format-Table -AutoSize | Out-String -Width 300`,
            { shell: 'powershell.exe', timeout: 15000 }
          );
          return { success: true, result: stdout.trim() };
        }

        case 'ports': {
          const target = normalizeHostTarget(input.target);
          if (target.success === false) return { success: false, result: target.error };
          const portList = parsePortList(input.ports);
          if (portList.success === false) return { success: false, result: portList.error };
          
          const scanScript = [
            `$targetHost = ${psQuote(target.value)}`,
            ...portList.values.map(port =>
              `$result = Test-NetConnection -ComputerName $targetHost -Port ${port} -WarningAction SilentlyContinue -InformationLevel Quiet; Write-Output "${port}: $(if($result){'OPEN'}else{'CLOSED'})"`
            ),
          ].join('; ');

          const { stdout } = await execAsync(scanScript, { shell: 'powershell.exe', timeout: 60000 });
          
          const results = stdout.trim().split('\n').filter(Boolean).map(line => {
            const [port, status] = line.split(':').map(s => s.trim());
            return { port: parseInt(port), status };
          });

          return { success: true, result: { host: target.value, ports: results } };
        }

        case 'ip_info': {
          const { stdout } = await execAsync(
            `Get-NetIPAddress | Where-Object {$_.AddressFamily -eq 'IPv4' -and $_.PrefixOrigin -ne 'WellKnown'} | Select-Object IPAddress, InterfaceAlias, PrefixLength | Format-Table -AutoSize | Out-String -Width 300`,
            { shell: 'powershell.exe' }
          );
          
          // Also get public IP
          let publicIp = 'unknown';
          try {
            const { stdout: pip } = await execAsync(
              `(Invoke-WebRequest -Uri "https://api.ipify.org" -UseBasicParsing).Content`,
              { shell: 'powershell.exe', timeout: 10000 }
            );
            publicIp = pip.trim();
          } catch { }

          return { success: true, result: { localInterfaces: stdout.trim(), publicIp } };
        }

        case 'http_check': {
          const url = normalizeHttpTarget(input.target);
          if (url.success === false) return { success: false, result: url.error };
          
          const { stdout } = await execAsync(
            `$sw = [System.Diagnostics.Stopwatch]::new(); $sw.Start(); try { $r = Invoke-WebRequest -Uri ${psQuote(url.value)} -Method HEAD -UseBasicParsing -TimeoutSec 10; $sw.Stop(); Write-Output "status=$($r.StatusCode) time=$($sw.ElapsedMilliseconds)ms headers=$($r.Headers['Server']),$($r.Headers['Content-Type'])" } catch { $sw.Stop(); Write-Output "status=ERROR time=$($sw.ElapsedMilliseconds)ms error=$($_.Exception.Message)" }`,
            { shell: 'powershell.exe', timeout: 20000 }
          );

          return { success: true, result: stdout.trim() };
        }

        case 'traceroute': {
          const target = normalizeHostTarget(input.target);
          if (target.success === false) return { success: false, result: target.error };
          const { stdout } = await execFileAsync(
            'tracert',
            ['-d', '-h', '15', target.value],
            { timeout: 60000, windowsHide: true }
          );
          return { success: true, result: String(stdout).trim().substring(0, 5000) };
        }

        case 'wifi': {
          const { stdout } = await execAsync(
            `netsh wlan show interfaces`,
            { shell: 'powershell.exe' }
          );
          return { success: true, result: stdout.trim() };
        }

        case 'netstat': {
          const { stdout } = await execAsync(
            `Get-NetTCPConnection | Where-Object {$_.State -eq 'Established'} | Select-Object -First 20 LocalAddress, LocalPort, RemoteAddress, RemotePort, State, OwningProcess | Format-Table -AutoSize | Out-String -Width 300`,
            { shell: 'powershell.exe' }
          );
          return { success: true, result: stdout.trim() };
        }

        default:
          return { success: false, result: 'Unknown operation' };
      }
    } catch (error: any) {
      return { success: false, result: `Network operation failed: ${error.message}` };
    }
  }
};
