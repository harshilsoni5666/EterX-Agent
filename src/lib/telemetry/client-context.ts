import type { PropertyInput, TelemetryProperties } from './protocol';

export function telemetryClientContext(request: Request): PropertyInput {
  // Read only coarse categories. Never retain the original browser header.
  const agent = request.headers.get('user-agent')?.slice(0, 512) ?? '';
  const browser = /Electron\//i.test(agent) ? 'electron' : /Edg(?:A|iOS)?\//i.test(agent) ? 'edge'
    : /(?:Chrome|CriOS)\//i.test(agent) ? 'chrome' : /(?:Firefox|FxiOS)\//i.test(agent) ? 'firefox'
      : /Safari\//i.test(agent) ? 'safari' : undefined;
  if (!browser) return {};

  let clientOs: TelemetryProperties['clientOs'];
  let clientDeviceModel: TelemetryProperties['clientDeviceModel'];
  let version: RegExpExecArray | null = null;
  if (/iPhone|iPad|iPod/i.test(agent)) {
    clientOs = 'ios';
    clientDeviceModel = /iPad/i.test(agent) ? 'ipad' : /iPhone/i.test(agent) ? 'iphone' : undefined;
    version = /\bOS (\d{1,3})[_.]/i.exec(agent);
  } else if (/Android/i.test(agent)) {
    clientOs = 'android';
    clientDeviceModel = 'android';
    version = /\bAndroid (\d{1,3})\b/i.exec(agent);
  } else if (/Windows/i.test(agent)) {
    clientOs = 'windows';
  } else if (/CrOS/i.test(agent)) {
    clientOs = 'chromeos';
  } else if (/Macintosh|Mac OS X/i.test(agent)) {
    clientOs = 'macos';
    version = /\bMac OS X (\d{1,3})[_.]/i.exec(agent);
  } else if (/Linux|X11/i.test(agent)) {
    clientOs = 'linux';
  }
  const mobile = clientOs === 'ios' || clientOs === 'android';
  const desktop = browser === 'electron';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname);
  const clientOsMajorVersion = version ? Number(version[1]) : undefined;
  return {
    clientBrowser: browser, clientType: desktop ? 'desktop' : 'web', clientOs, clientOsMajorVersion, clientDeviceModel,
    os: clientOs, osMajorVersion: clientOsMajorVersion, deviceModel: clientDeviceModel,
    clientDeviceType: mobile ? clientDeviceModel === 'ipad' || (clientOs === 'android' && !/Mobile/i.test(agent))
      ? 'tablet' : 'phone' : 'desktop',
    surface: desktop ? 'desktop' : mobile ? 'mobile' : 'web', connectionMethod: local ? 'loopback' : 'direct',
    webDeployment: desktop ? undefined : local ? 'local' : 'self_hosted',
  };
}
