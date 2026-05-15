import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
  execute: async (input: { operation: string, target?: string, ports?: string, count?: number }) => {
    console.log(`[Tool: network_tools] Operation: ${input.operation}, Target: ${input.target}`);

    try {
      switch (input.operation) {
        case 'ping': {
          if (!input.target) return { success: false, result: 'target is required for ping' };
          const count = input.count || 4;
          const { stdout } = await execAsync(
            `ping -n ${count} ${input.target}`,
            { shell: 'powershell.exe', timeout: 30000 }
          );
          return { success: true, result: stdout.trim() };
        }

        case 'dns': {
          if (!input.target) return { success: false, result: 'target hostname required' };
          const { stdout } = await execAsync(
            `Resolve-DnsName -Name "${input.target}" -Type A | Format-Table -AutoSize | Out-String -Width 300`,
            { shell: 'powershell.exe', timeout: 15000 }
          );
          return { success: true, result: stdout.trim() };
        }

        case 'ports': {
          if (!input.target) return { success: false, result: 'target IP/hostname required' };
          const portsToScan = input.ports || '21,22,25,80,443,3000,3306,5432,5000,8080,8443,9090';
          const portList = portsToScan.split(',').map(p => p.trim());
          
          const scanScript = portList.map(port => 
            `$result = Test-NetConnection -ComputerName "${input.target}" -Port ${port} -WarningAction SilentlyContinue -InformationLevel Quiet; Write-Output "${port}: $(if($result){'OPEN'}else{'CLOSED'})"`
          ).join('; ');

          const { stdout } = await execAsync(scanScript, { shell: 'powershell.exe', timeout: 60000 });
          
          const results = stdout.trim().split('\n').map(line => {
            const [port, status] = line.split(':').map(s => s.trim());
            return { port: parseInt(port), status };
          });

          return { success: true, result: { host: input.target, ports: results } };
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
          if (!input.target) return { success: false, result: 'target URL required' };
          const url = input.target.startsWith('http') ? input.target : `https://${input.target}`;
          
          const { stdout } = await execAsync(
            `$sw = [System.Diagnostics.Stopwatch]::new(); $sw.Start(); try { $r = Invoke-WebRequest -Uri "${url}" -Method HEAD -UseBasicParsing -TimeoutSec 10; $sw.Stop(); Write-Output "status=$($r.StatusCode) time=$($sw.ElapsedMilliseconds)ms headers=$($r.Headers['Server']),$($r.Headers['Content-Type'])" } catch { $sw.Stop(); Write-Output "status=ERROR time=$($sw.ElapsedMilliseconds)ms error=$($_.Exception.Message)" }`,
            { shell: 'powershell.exe', timeout: 20000 }
          );

          return { success: true, result: stdout.trim() };
        }

        case 'traceroute': {
          if (!input.target) return { success: false, result: 'target required' };
          const { stdout } = await execAsync(
            `tracert -d -h 15 ${input.target}`,
            { shell: 'powershell.exe', timeout: 60000 }
          );
          return { success: true, result: stdout.trim().substring(0, 5000) };
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
