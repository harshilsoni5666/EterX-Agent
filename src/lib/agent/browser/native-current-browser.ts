import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { resolveTerminalShell } from '../tools/core/shell_resolver';
import { executePlatformScreenAction } from '../computer/platform-control';

const execFileAsync = promisify(execFile);

const MAC_BROWSER_SCRIPT = String.raw`
function run(argv) {
  const action = argv[0];
  const payload = JSON.parse(argv[1] || '{}');
  const app = Application(payload.browserName);
  app.includeStandardAdditions = true;
  if (!app.running()) app.launch();
  app.activate();
  delay(0.18);

  let win = app.windows.length ? app.windows[0] : null;
  if (!win) {
    app.openLocation(payload.url || 'about:blank');
    delay(0.5);
    win = app.windows[0];
  }
  let tab = win.activeTab();
  const systemEvents = Application('System Events');

  function key(value, modifiers) {
    systemEvents.keystroke(value, { using: modifiers || [] });
    delay(0.12);
  }
  function executeJS(source, optional) {
    try {
      const result = tab.execute({ javascript: source });
      if (result === false && !optional) throw new Error('The target control is unavailable. Take a fresh snapshot.');
      return result;
    } catch (e) {
      if (optional) return '';
      throw new Error('Browser page action failed. Enable Allow JavaScript from Apple Events in the browser Develop/View menu when required. ' + String(e));
    }
  }
  function readJS(source) { return executeJS(source, true); }

  if (action === 'launch' && payload.url) {
    tab.url = payload.url;
    delay(0.8);
  } else if (action === 'goto') {
    tab.url = payload.url;
    delay(0.8);
  } else if (action === 'back') {
    key('[', ['command down']);
  } else if (action === 'forward') {
    key(']', ['command down']);
  } else if (action === 'reload') {
    key('r', ['command down']);
    delay(0.4);
  } else if (action === 'new_tab' || action === 'switch_or_open_tab') {
    const created = app.Tab({ url: payload.url || 'about:blank' });
    win.tabs.push(created);
    win.activeTabIndex = win.tabs.length;
    delay(0.5);
    tab = win.activeTab();
  } else if (action === 'next_tab') {
    key(']', ['command down', 'shift down']);
    tab = win.activeTab();
  } else if (action === 'previous_tab') {
    key('[', ['command down', 'shift down']);
    tab = win.activeTab();
  } else if (action === 'switch_tab') {
    win.activeTabIndex = Math.min(win.tabs.length, Math.max(1, Number(payload.tabIndex || 0) + 1));
    tab = win.activeTab();
  } else if (action === 'close_tab') {
    tab.close();
    delay(0.25);
    if (!app.windows.length || !win.tabs.length) return JSON.stringify({ state: { browser: payload.browserLabel, processName: payload.browserName, pid: 0, title: '', url: '', text: '', refs: [], tabs: [] }, screenshot: '' });
    tab = win.activeTab();
  } else if (action === 'duplicate_tab') {
    const created = app.Tab({ url: tab.url() });
    win.tabs.push(created);
    win.activeTabIndex = win.tabs.length;
    tab = win.activeTab();
  } else if (action === 'press') {
    const parts = String(payload.key || 'Enter').split('+');
    const raw = (parts.pop() || '+').toLowerCase();
    const names = { controlormeta: 'command down', cmd: 'command down', command: 'command down', meta: 'command down', ctrl: 'command down', control: 'control down', alt: 'option down', option: 'option down', shift: 'shift down' };
    const modifiers = parts.map(function(part) { return names[part.toLowerCase()]; }).filter(Boolean);
    const keyMap = { enter: 36, escape: 53, tab: 48, backspace: 51, delete: 117, arrowleft: 123, arrowright: 124, arrowdown: 125, arrowup: 126, pageup: 116, pagedown: 121 };
    if (keyMap[raw] != null) systemEvents.keyCode(keyMap[raw], { using: modifiers });
    else key(raw, modifiers);
  } else if (action === 'click') {
    executeJS("(function(){var e=document.elementFromPoint(" + Number(payload.x || 0) + "," + Number(payload.y || 0) + ");if(!e)return false;e.focus&&e.focus();e.click&&e.click();return true})()");
  } else if (action === 'dblclick') {
    executeJS("(function(){var e=document.elementFromPoint(" + Number(payload.x || 0) + "," + Number(payload.y || 0) + ");if(!e)return false;e.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return true})()");
  } else if (action === 'hover') {
    executeJS("(function(){var e=document.elementFromPoint(" + Number(payload.x || 0) + "," + Number(payload.y || 0) + ");if(!e)return false;e.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));return true})()");
  } else if (action === 'fill' || action === 'type') {
    const encoded = JSON.stringify(String(payload.text || ''));
    executeJS("(function(){var e=document.activeElement;if(!e)return false;var v=" + encoded + ";var replace=" + (action === 'fill' ? 'true' : 'false') + ";if(e.isContentEditable){if(replace){var r=document.createRange();r.selectNodeContents(e);var s=getSelection();s.removeAllRanges();s.addRange(r)}return document.execCommand('insertText',false,v)}if(!('value' in e)||e.disabled||e.readOnly)return false;var old=e.value||'';var start=replace?0:(e.selectionStart==null?old.length:e.selectionStart);var end=replace?old.length:(e.selectionEnd==null?start:e.selectionEnd);var setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value');var next=old.slice(0,start)+v+old.slice(end);if(setter&&setter.set)setter.set.call(e,next);else e.value=next;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()");
  } else if (action === 'clear') {
    key('a', ['command down']); systemEvents.keyCode(51);
  } else if (action === 'scroll') {
    executeJS("window.scrollBy(" + (payload.direction === 'left' ? -500 : payload.direction === 'right' ? 500 : 0) + "," + (payload.direction === 'up' ? -Math.abs(Number(payload.amount || 500)) : payload.direction === 'down' ? Math.abs(Number(payload.amount || 500)) : 0) + ");true");
  } else if (action === 'wait') {
    delay(Math.min(10, Math.max(0, Number(payload.amount || 0) / 1000)));
  }

  tab = win.activeTab();
  let dom = '';
  dom = readJS("(function(){var q='a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true]';var refs=Array.from(document.querySelectorAll(q)).filter(function(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.visibility!=='hidden'&&s.display!=='none'}).slice(0," + Number(payload.maxRefs || 180) + ").map(function(e,i){var r=e.getBoundingClientRect();return {ref:i+1,name:(e.innerText||e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.value||'').trim().slice(0,180),role:(e.getAttribute('role')||e.tagName).toLowerCase(),value:e.value||'',x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),centerX:Math.round(r.x+r.width/2),centerY:Math.round(r.y+r.height/2)}});return JSON.stringify({url:location.href,title:document.title,text:(document.body&&document.body.innerText||'').slice(0," + Number(payload.maxText || 30000) + "),refs:refs})})()");
  let parsed = {};
  try { parsed = dom ? JSON.parse(dom) : {}; } catch (e) {}
  const allTabs = win.tabs();
  const activeIndex = Number(win.activeTabIndex()) - 1;
  const tabs = allTabs.map(function(item, index) {
    let title = '';
    try { title = item.title(); } catch (e) {}
    return { id: 'native_tab_' + index, title: title, isActive: index === activeIndex };
  });
  return JSON.stringify({
    state: {
      browser: payload.browserLabel,
      processName: payload.browserName,
      pid: 0,
      title: parsed.title || tab.title(),
      url: parsed.url || tab.url(),
      text: parsed.text || '',
      refs: parsed.refs || [],
      tabs: tabs
    },
    screenshot: '',
    windowId: Number(win.id()),
    windowBounds: win.bounds()
  });
}
`;

type NativeRef = {
  ref: number;
  name: string;
  role: string;
  value?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
};

type NativeState = {
  browser: string;
  processName: string;
  pid: number;
  title: string;
  url: string;
  text: string;
  refs: NativeRef[];
  tabs: Array<{ id: string; title: string; isActive: boolean }>;
};

export type NativeBrowserResult = {
  success: boolean;
  action: string;
  result: any;
  currentUrl?: string;
  pageTitle?: string;
  snapshotText?: string;
  screenshotBase64?: string;
  screenshotMimeType?: 'image/jpeg' | 'image/png';
  recovery?: string;
  nextAction?: string;
};

const WINDOWS_BROWSER_SCRIPT = String.raw`
$Action = [Environment]::GetEnvironmentVariable('ETERX_NATIVE_BROWSER_ACTION')
$PayloadB64 = [Environment]::GetEnvironmentVariable('ETERX_NATIVE_BROWSER_PAYLOAD')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[void][System.Reflection.Assembly]::LoadWithPartialName('UIAutomationClient')
[void][System.Reflection.Assembly]::LoadWithPartialName('UIAutomationTypes')

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class EterXBrowserNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
}
'@
try { [EterXBrowserNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null }
catch { [EterXBrowserNative]::SetProcessDPIAware() | Out-Null }

function Decode-Payload {
  if ([string]::IsNullOrWhiteSpace($PayloadB64)) { return @{} }
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadB64))
  if ([string]::IsNullOrWhiteSpace($json)) { return @{} }
  return ConvertFrom-Json $json
}

function Get-DefaultBrowser {
  $progId = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -ErrorAction SilentlyContinue).ProgId
  if ($progId -match 'Brave') {
    return [pscustomobject]@{ Browser='Brave'; ProcessName='brave' }
  }
  if ($progId -match 'MSEdge|MicrosoftEdge') {
    return [pscustomobject]@{ Browser='Edge'; ProcessName='msedge' }
  }
  if ($progId -match 'Chrome') {
    return [pscustomobject]@{ Browser='Chrome'; ProcessName='chrome' }
  }
  throw 'The default browser must be Chrome, Edge, or Brave.'
}

function Get-BrowserProcess($spec) {
  return Get-Process -Name $spec.ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle } |
    Sort-Object StartTime |
    Select-Object -First 1
}

function Focus-Browser($proc) {
  [EterXBrowserNative]::ShowWindowAsync($proc.MainWindowHandle, 9) | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  $shell.AppActivate($proc.Id) | Out-Null
  [EterXBrowserNative]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 180
}

function Send-Keys([string]$keys) {
  [System.Windows.Forms.SendKeys]::SendWait($keys)
  Start-Sleep -Milliseconds 120
}

function Paste-Text([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return }
  $old = $null
  try {
    $current = [System.Windows.Forms.Clipboard]::GetDataObject()
    $old = New-Object System.Windows.Forms.DataObject
    if ($null -ne $current) {
      foreach ($format in $current.GetFormats($false)) {
        try { $old.SetData($format, $false, $current.GetData($format, $false)) } catch {}
      }
    }
  } catch {}
  try {
    [System.Windows.Forms.Clipboard]::SetText([string]$text)
    Send-Keys '^v'
  } finally {
    if ($null -ne $old) {
      Start-Sleep -Milliseconds 80
      try {
        if ($old.GetFormats().Length) { [System.Windows.Forms.Clipboard]::SetDataObject($old, $true) }
        else { [System.Windows.Forms.Clipboard]::Clear() }
      } catch {}
    }
  }
}

function Get-WindowElement($proc) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
    $proc.Id
  )
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}

function Read-NativeState($spec, $proc, [int]$maxText, [int]$maxRefs) {
  $window = Get-WindowElement $proc
  $url = ''
  $text = ''
  $refs = New-Object System.Collections.Generic.List[object]
  $tabs = New-Object System.Collections.Generic.List[object]
  if ($null -ne $window) {
    $all = $window.FindAll(
      [System.Windows.Automation.TreeScope]::Subtree,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    $refIndex = 1
    foreach ($el in $all) {
      try {
        $controlType = $el.Current.ControlType.ProgrammaticName.Replace('ControlType.','')
        $name = [string]$el.Current.Name
        $rect = $el.Current.BoundingRectangle
        $offscreen = $el.Current.IsOffscreen
        $value = ''
        try {
          $valuePattern = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
          if ($null -ne $valuePattern) { $value = [string]$valuePattern.Current.Value }
        } catch {}

        if (
          -not $url -and
          $controlType -eq 'Edit' -and
          (
            $value -match '^(https?://|chrome://|edge://|brave://|file://)' -or
            ($name -match '(?i)address|search' -and $value -match '\.')
          )
        ) {
          $url = $value
        }
        if ($controlType -eq 'Document' -and -not $text) {
          try {
            $textPattern = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
            if ($null -ne $textPattern) {
              $text = [string]$textPattern.DocumentRange.GetText($maxText)
            }
          } catch {}
        }
        if ($controlType -eq 'TabItem' -and $name) {
          $tabs.Add([pscustomobject]@{
            id = "native_tab_$($tabs.Count)"
            title = $name
            isActive = $el.Current.HasKeyboardFocus
          })
        }
        $interactive = @('Button','Hyperlink','Edit','ComboBox','CheckBox','RadioButton','MenuItem','TabItem','ListItem')
        if ($refs.Count -lt $maxRefs -and $interactive -contains $controlType -and -not $offscreen -and $rect.Width -gt 2 -and $rect.Height -gt 2) {
          $refs.Add([pscustomobject]@{
            ref = $refIndex
            name = $name
            role = $controlType
            value = $value
            x = [int]$rect.X
            y = [int]$rect.Y
            width = [int]$rect.Width
            height = [int]$rect.Height
            centerX = [int]($rect.X + ($rect.Width / 2))
            centerY = [int]($rect.Y + ($rect.Height / 2))
          })
          $refIndex++
        }
      } catch {}
    }
  }
  return [pscustomobject]@{
    browser = $spec.Browser
    processName = $spec.ProcessName
    pid = $proc.Id
    title = $proc.MainWindowTitle
    url = $url
    text = $text
    refs = @($refs)
    tabs = @($tabs)
  }
}

function Capture-Browser($proc) {
  $rect = New-Object EterXBrowserNative+RECT
  [EterXBrowserNative]::GetWindowRect($proc.MainWindowHandle, [ref]$rect) | Out-Null
  $w = [Math]::Max(1, $rect.Right - $rect.Left)
  $h = [Math]::Max(1, $rect.Bottom - $rect.Top)
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w,$h)))
  $g.Dispose()
  $stream = New-Object System.IO.MemoryStream
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]78)
  $bmp.Save($stream, $codec, $params)
  $bmp.Dispose()
  $bytes = $stream.ToArray()
  $stream.Dispose()
  return [Convert]::ToBase64String($bytes)
}

$payload = Decode-Payload
$spec = Get-DefaultBrowser
$proc = Get-BrowserProcess $spec
if ($null -eq $proc) {
  if ($Action -ne 'connect' -and $Action -ne 'launch') { throw "$($spec.Browser) is not running." }
  $launchTarget = if ($payload.url) { [string]$payload.url } else { 'https://www.google.com' }
  Start-Process $launchTarget
  $deadline = [DateTime]::UtcNow.AddSeconds(8)
  do {
    Start-Sleep -Milliseconds 250
    $proc = Get-BrowserProcess $spec
  } while ($null -eq $proc -and [DateTime]::UtcNow -lt $deadline)
  if ($null -eq $proc) { throw "$($spec.Browser) did not open." }
}

Focus-Browser $proc
if ($payload.coordinateSpace -eq 'screenshot' -and $null -ne $payload.x -and $null -ne $payload.y) {
  $bounds = New-Object EterXBrowserNative+RECT
  if (-not [EterXBrowserNative]::GetWindowRect($proc.MainWindowHandle, [ref]$bounds)) { throw 'Browser window bounds are unavailable.' }
  $payload.x = [int]$payload.x + $bounds.Left
  $payload.y = [int]$payload.y + $bounds.Top
}
switch ($Action) {
  'launch' {
    if ($payload.url) {
      Send-Keys '^l'
      Paste-Text ([string]$payload.url)
      Send-Keys '{ENTER}'
      Start-Sleep -Milliseconds 900
    }
  }
  'connect' {}
  'goto' {
    Send-Keys '^l'
    Paste-Text ([string]$payload.url)
    Send-Keys '{ENTER}'
    Start-Sleep -Milliseconds 900
  }
  'back' { Send-Keys '%{LEFT}' }
  'forward' { Send-Keys '%{RIGHT}' }
  'reload' { Send-Keys '^r'; Start-Sleep -Milliseconds 500 }
  'new_tab' {
    Send-Keys '^t'
    if ($payload.url) {
      Paste-Text ([string]$payload.url)
      Send-Keys '{ENTER}'
      Start-Sleep -Milliseconds 700
    }
  }
  'switch_or_open_tab' {
    Send-Keys '^t'
    if ($payload.url) {
      Paste-Text ([string]$payload.url)
      Send-Keys '{ENTER}'
      Start-Sleep -Milliseconds 700
    }
  }
  'next_tab' { Send-Keys '^{TAB}' }
  'previous_tab' { Send-Keys '^+{TAB}' }
  'switch_tab' {
    $index = [Math]::Max(0, [int]$payload.tabIndex)
    if ($index -lt 8) { Send-Keys "^$($index + 1)" } else { Send-Keys '^9' }
  }
  'close_tab' { Send-Keys '^w' }
  'close_other_tabs' { throw 'Closing other tabs requires CDP browser control.' }
  'duplicate_tab' {
    Send-Keys '^l'
    Send-Keys '%{ENTER}'
    Start-Sleep -Milliseconds 350
  }
  'press' { Send-Keys ([string]$payload.sendKeys) }
  'type' {
    if ($payload.replace) { Send-Keys '^a' }
    Paste-Text ([string]$payload.text)
  }
  'fill' {
    Send-Keys '^a'
    if ([string]::IsNullOrEmpty([string]$payload.text)) { Send-Keys '{BACKSPACE}' }
    else { Paste-Text ([string]$payload.text) }
  }
  'clear' { Send-Keys '^a'; Send-Keys '{BACKSPACE}' }
  'click' {
    [EterXBrowserNative]::SetCursorPos([int]$payload.x, [int]$payload.y) | Out-Null
    [EterXBrowserNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 45
    [EterXBrowserNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  }
  'dblclick' {
    1..2 | ForEach-Object {
      [EterXBrowserNative]::SetCursorPos([int]$payload.x, [int]$payload.y) | Out-Null
      [EterXBrowserNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
      [EterXBrowserNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
      Start-Sleep -Milliseconds 80
    }
  }
  'hover' { [EterXBrowserNative]::SetCursorPos([int]$payload.x, [int]$payload.y) | Out-Null }
  'scroll' {
    $delta = if ($payload.direction -eq 'up') { 4 } else { -4 }
    [EterXBrowserNative]::mouse_event(0x0800,0,0,$delta * 120,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 180
  }
  'wait' { Start-Sleep -Milliseconds ([Math]::Min(10000,[Math]::Max(0,[int]$payload.amount))) }
}

$state = Read-NativeState $spec $proc ([Math]::Min(50000,[Math]::Max(1000,[int]$payload.maxText))) ([Math]::Min(300,[Math]::Max(20,[int]$payload.maxRefs)))
$shot = ''
if ($payload.capture) {
  try { $shot = Capture-Browser $proc } catch { $shot = '' }
}
[pscustomobject]@{ state=$state; screenshot=$shot } | ConvertTo-Json -Depth 8 -Compress
`;

function encodePayload(payload: Record<string, any>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function normalizeArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function sendKeysFor(key: string): string {
  const parts = String(key || 'Enter').split('+');
  const normalized = parts.pop() || '+';
  const modifiers = parts.map(part => /^(controlormeta|control|ctrl|cmd|command|meta)$/i.test(part) ? '^' : /^(alt|option)$/i.test(part) ? '%' : /^shift$/i.test(part) ? '+' : '').join('');
  const named: Record<string, string> = {
    Enter: '{ENTER}',
    Escape: '{ESC}',
    Tab: '{TAB}',
    Backspace: '{BACKSPACE}',
    Delete: '{DELETE}',
    ArrowUp: '{UP}',
    ArrowDown: '{DOWN}',
    ArrowLeft: '{LEFT}',
    ArrowRight: '{RIGHT}',
    PageUp: '{PGUP}',
    PageDown: '{PGDN}',
    Home: '{HOME}',
    End: '{END}',
    ' ': ' ',
  };
  const namedKey = Object.keys(named).find(name => name.toLowerCase() === normalized.toLowerCase());
  const value = namedKey ? named[namedKey] : /^F(?:[1-9]|1\d|2[0-4])$/i.test(normalized) ? `{${normalized.toUpperCase()}}` : normalized.replace(/[+^%~(){}\[\]]/g, character => `{${character}}`);
  return modifiers + value;
}

class NativeCurrentBrowserController {
  private active = false;
  private lastState: NativeState | null = null;
  private refs = new Map<number, NativeRef>();
  private macCapture: { windowId: number; width: number; height: number } | null = null;

  get connected(): boolean {
    return this.active;
  }

  get info() {
    return {
      connected: this.active,
      mode: 'native-current-window',
      browser: this.lastState?.browser || '',
      activeTabId: this.lastState?.tabs.find((tab) => tab.isActive)?.id || 'native_active',
      tabCount: this.lastState?.tabs.length || 0,
      ownsBrowserConnection: false,
    };
  }

  get tabs() {
    return this.lastState?.tabs || [];
  }

  disconnect() {
    this.active = false;
    this.lastState = null;
    this.refs.clear();
    this.macCapture = null;
  }

  async connect(url?: string): Promise<NativeBrowserResult> {
    return this.execute(url ? 'launch' : 'connect', { url });
  }

  async execute(action: string, input: any = {}): Promise<NativeBrowserResult> {
    if (!['win32', 'darwin', 'linux'].includes(process.platform)) {
      return {
        success: false,
        action,
        result: `Native current-window browser control is unavailable on ${process.platform}.`,
        recovery: 'Enable browser remote debugging or use an explicitly managed browser profile.',
        nextAction: 'launch',
      };
    }

    const supported = new Set([
      'launch', 'connect', 'goto', 'back', 'forward', 'reload',
      'observe', 'snapshot', 'read_page', 'get_text', 'get_url', 'get_title',
      'screenshot', 'click', 'dblclick', 'hover', 'focus', 'type', 'fill', 'clear',
      'check', 'uncheck', 'select', 'press', 'scroll', 'wait', 'wait_for',
      'new_tab', 'switch_or_open_tab', 'switch_tab', 'next_tab', 'previous_tab',
      'duplicate_tab', 'close_tab', 'close_other_tabs', 'list_tabs',
      'start_browser_session', 'end_browser_session',
    ]);
    if (!supported.has(action) || ['check', 'uncheck', 'select', 'wait_for', 'close_other_tabs'].includes(action)) {
      return {
        success: false,
        action,
        result: `${action} requires CDP browser control and is unavailable in native current-window mode.`,
        recovery: 'Use navigation, accessible refs, keyboard, mouse, screenshots, or tab controls; enable CDP for cookies, storage, script evaluation, and network inspection.',
        nextAction: 'snapshot',
      };
    }

    let targetRef: NativeRef | undefined;
    if (input.ref != null) targetRef = this.refs.get(Number(input.ref));
    if ((input.ref != null && !targetRef) || input.selector) {
      return { success: false, action, result: input.selector ? 'CSS selectors require CDP browser control.' : 'This native control reference is no longer available.', recovery: 'Take a fresh snapshot and use a visible ref or screenshot coordinates.', nextAction: 'snapshot' };
    }
    const x = input.x ?? targetRef?.centerX;
    const y = input.y ?? targetRef?.centerY;
    if (['click', 'dblclick', 'hover', 'focus', 'check', 'uncheck', 'select'].includes(action) && (x == null || y == null)) {
      return {
        success: false,
        action,
        result: 'A visible x/y position or current native snapshot ref is required.',
        recovery: 'Take a fresh snapshot and use one of its refs.',
        nextAction: 'snapshot',
      };
    }

    let nativeAction = action;
    if (['observe', 'snapshot', 'read_page', 'get_text', 'get_url', 'get_title', 'screenshot', 'list_tabs', 'start_browser_session', 'end_browser_session', 'wait_for'].includes(action)) {
      nativeAction = 'connect';
    }
    if (['focus', 'check', 'uncheck', 'select'].includes(action)) nativeAction = 'click';
    if (action === 'type' && targetRef) nativeAction = 'click';

    const tabIndexMatch = String(input.tabId || '').match(/(\d+)$/);
    if (action === 'switch_tab') {
      const tabs = this.lastState?.tabs || [];
      const index = tabIndexMatch ? Number(tabIndexMatch[1]) : -1;
      if (index < 0 || !tabs.some(tab => tab.id === input.tabId) || (process.platform !== 'darwin' && index >= 8 && index !== tabs.length - 1)) {
        return { success: false, action, result: 'This tab cannot be selected by its native shortcut.', recovery: 'Use next_tab/previous_tab, or connect through CDP to select any tab by ID.', nextAction: 'list_tabs' };
      }
    }
    const payload = {
      url: input.url || '',
      x,
      y,
      coordinateSpace: targetRef && input.x == null && input.y == null ? 'ref' : 'screenshot',
      text: input.text ?? input.value ?? '',
      replace: action === 'fill',
      direction: input.direction || 'down',
      amount: input.amount || (action === 'wait_for' ? 500 : 0),
      sendKeys: sendKeysFor(input.key || input.text || 'Enter'),
      key: input.key || input.text || 'Enter',
      tabIndex: tabIndexMatch ? Number(tabIndexMatch[1]) : 0,
      maxText: Number(input.maxTextChars || 30000),
      maxRefs: Number(input.maxElements || 180),
      capture: input.visualFeedback !== false || action === 'screenshot' || action === 'observe',
    };

    try {
      if (['type', 'fill', 'clear'].includes(action) && x != null && y != null) {
        await this.run('click', { ...payload, capture: false });
        nativeAction = action;
      }
      const raw = await this.run(nativeAction, payload);
      const state = raw.state as NativeState;
      if (action === 'screenshot' && !raw.screenshot) throw new Error('No screenshot was captured. Check screen capture permission and the installed capture utility.');
      state.refs = normalizeArray(state.refs);
      state.tabs = normalizeArray(state.tabs);
      this.lastState = state;
      this.refs = new Map(state.refs.map((ref) => [Number(ref.ref), ref]));
      this.active = true;
      if (action === 'get_url' && !state.url) throw new Error('This native provider cannot read the current URL. Use CDP browser control.');
      if (['read_page', 'get_text'].includes(action) && process.platform === 'linux') throw new Error('Native Linux control does not expose page text. Use a screenshot or CDP browser control.');

      const snapshotText = this.formatSnapshot(state);
      let result: any = {
        mode: 'native-current-window',
        browser: state.browser,
        url: state.url,
        title: state.title,
      };
      if (['observe', 'snapshot'].includes(action)) {
        result = { ...result, elements: state.refs.length };
      } else if (['read_page', 'get_text'].includes(action)) {
        result = { ...result, text: state.text };
      } else if (action === 'list_tabs') {
        result = { tabs: state.tabs, count: state.tabs.length, mode: 'native-current-window' };
      } else if (action === 'get_url') {
        result = state.url;
      } else if (action === 'get_title') {
        result = state.title;
      } else if (action === 'launch' || action === 'connect') {
        result = { ...result, connected: true, realProfile: true };
      } else {
        result = { ...result, completed: action };
      }

      return {
        success: true,
        action,
        result,
        currentUrl: state.url,
        pageTitle: state.title,
        snapshotText: ['observe', 'snapshot'].includes(action) ? snapshotText : undefined,
        screenshotBase64: raw.screenshot || undefined,
        screenshotMimeType: raw.screenshot ? (String(raw.screenshot).startsWith('iVBORw0KGgo') ? 'image/png' : 'image/jpeg') : undefined,
      };
    } catch (error: any) {
      const recovery = process.platform === 'darwin'
        ? 'Allow EterX in macOS Automation, Accessibility, and Screen Recording settings, then retry.'
        : process.platform === 'linux'
          ? 'Use an X11 session with xdotool available, or enable CDP on Wayland where global desktop automation is restricted.'
          : 'Bring the default browser window to the current desktop and retry.';
      return {
        success: false,
        action,
        result: `Native browser control failed: ${String(error?.message || error).slice(0, 500)}`,
        recovery,
        nextAction: action === 'launch' ? 'launch' : 'snapshot',
      };
    }
  }

  private async run(action: string, payload: Record<string, any>): Promise<any> {
    if (process.platform === 'darwin') return this.runMac(action, payload);
    if (process.platform === 'linux') return this.runLinux(action, payload);

    const encodedScript = Buffer.from(WINDOWS_BROWSER_SCRIPT, 'utf16le').toString('base64');
    const powershell = resolveTerminalShell('powershell');
    let stdout = '';
    try {
      ({ stdout } = await execFileAsync(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle', 'Hidden',
          '-ExecutionPolicy', 'Bypass',
          '-EncodedCommand', encodedScript,
        ],
        {
          timeout: 20_000,
          maxBuffer: 30 * 1024 * 1024,
          windowsHide: true,
          env: {
            ...process.env,
            ETERX_NATIVE_BROWSER_ACTION: action,
            ETERX_NATIVE_BROWSER_PAYLOAD: encodePayload(payload),
          },
        },
      ));
    } catch (error: any) {
      const stderr = String(error?.stderr || '').trim();
      const failedStdout = String(error?.stdout || '').trim();
      const detail = [stderr, failedStdout].filter(Boolean).join(' | ').slice(0, 900);
      throw new Error(detail || String(error?.message || error));
    }
    const output = String(stdout || '').trim();
    if (!output) throw new Error('The browser accessibility bridge returned no state.');
    const start = output.lastIndexOf('{"state"');
    return JSON.parse(start >= 0 ? output.slice(start) : output);
  }

  private async runMac(action: string, payload: Record<string, any>): Promise<any> {
    const { stdout: bundleOut } = await execFileAsync(
      'osascript',
      ['-e', 'id of app (path to default application for URL "https://example.com")'],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    const bundleId = String(bundleOut || '').trim().toLowerCase();
    const browser = bundleId.includes('brave')
      ? { name: 'Brave Browser', label: 'Brave' }
      : bundleId.includes('edgemac')
        ? { name: 'Microsoft Edge', label: 'Edge' }
        : bundleId.includes('google.chrome')
          ? { name: 'Google Chrome', label: 'Chrome' }
          : null;
    if (!browser) throw new Error('The macOS default browser must be Chrome, Edge, or Brave.');

    const macPayload = {
      ...payload,
      browserName: browser.name,
      browserLabel: browser.label,
    };
    let scriptAction = action;
    if (payload.coordinateSpace === 'screenshot' && ['click', 'dblclick', 'hover'].includes(action)) {
      const { stdout: stateOutput } = await execFileAsync(
        'osascript', ['-l', 'JavaScript', '-e', MAC_BROWSER_SCRIPT, 'connect', JSON.stringify(macPayload)],
        { timeout: 20_000, maxBuffer: 30 * 1024 * 1024 },
      );
      const current = JSON.parse(String(stateOutput || '').trim());
      const bounds = current.windowBounds;
      const capture = this.macCapture;
      if (!capture || capture.windowId !== current.windowId || !bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
        throw new Error('Take a fresh browser screenshot before using screenshot coordinates.');
      }
      const clicked = await executePlatformScreenAction(action === 'dblclick' ? 'double_click' : action, {
        x: bounds.x + Number(payload.x) * bounds.width / capture.width,
        y: bounds.y + Number(payload.y) * bounds.height / capture.height,
      });
      if (!clicked?.success) throw new Error(String(clicked?.result || 'Native pointer input is unavailable.'));
      scriptAction = 'connect';
    }
    const { stdout } = await execFileAsync(
      'osascript',
      ['-l', 'JavaScript', '-e', MAC_BROWSER_SCRIPT, scriptAction, JSON.stringify(macPayload)],
      { timeout: 20_000, maxBuffer: 30 * 1024 * 1024 },
    );
    const parsed = JSON.parse(String(stdout || '').trim());
    if (payload.capture) {
      const tempPath = path.join(os.tmpdir(), `eterx-browser-${process.pid}-${Date.now()}.jpg`);
      this.macCapture = null;
      try {
        if (!parsed.windowId) throw new Error('No browser window is available to capture.');
        // Exclude shadows and retain pixel dimensions for Retina coordinate conversion.
        const captureArgs = ['-x', '-o', '-l', String(parsed.windowId), '-t', 'jpg', tempPath];
        await execFileAsync('screencapture', captureArgs, { timeout: 8000 });
        const { stdout: dimensions } = await execFileAsync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', tempPath], { timeout: 5000 });
        const width = Number(dimensions.match(/pixelWidth:\s*(\d+)/)?.[1]);
        const height = Number(dimensions.match(/pixelHeight:\s*(\d+)/)?.[1]);
        if (!(width > 0 && height > 0)) throw new Error('Browser screenshot dimensions are unavailable.');
        this.macCapture = { windowId: parsed.windowId, width, height };
        parsed.screenshot = (await fs.readFile(tempPath)).toString('base64');
      } catch {
        parsed.screenshot = '';
      } finally {
        await fs.remove(tempPath).catch(() => {});
      }
    }
    return parsed;
  }

  private async runLinux(action: string, payload: Record<string, any>): Promise<any> {
    const { stdout: desktopOut } = await execFileAsync(
      'xdg-settings',
      ['get', 'default-web-browser'],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    const desktop = String(desktopOut || '').trim().toLowerCase();
    const browser = desktop.includes('brave')
      ? { className: 'brave-browser', label: 'Brave' }
      : desktop.includes('edge')
        ? { className: 'microsoft-edge', label: 'Edge' }
        : desktop.includes('chrome')
          ? { className: 'google-chrome', label: 'Chrome' }
          : desktop.includes('chromium')
            ? { className: 'chromium', label: 'Chromium' }
            : null;
    if (!browser) throw new Error('The Linux default browser must be Chrome, Chromium, Edge, or Brave.');

    let windowId = '';
    try {
      const { stdout } = await execFileAsync(
        'xdotool',
        ['search', '--onlyvisible', '--class', browser.className],
        { timeout: 5000, maxBuffer: 1024 * 1024 },
      );
      windowId = String(stdout || '').trim().split(/\r?\n/)[0] || '';
    } catch {}

    if (!windowId && ['launch', 'connect'].includes(action)) {
      await execFileAsync('xdg-open', [payload.url || 'about:blank'], { timeout: 5000 }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const { stdout } = await execFileAsync(
        'xdotool',
        ['search', '--onlyvisible', '--class', browser.className],
        { timeout: 5000, maxBuffer: 1024 * 1024 },
      );
      windowId = String(stdout || '').trim().split(/\r?\n/)[0] || '';
    }
    if (!windowId) {
      throw new Error('No accessible browser window was found. On Wayland, enable CDP because global desktop automation is restricted.');
    }

    const xdo = async (...args: string[]) => {
      await execFileAsync('xdotool', args, { timeout: 8000, maxBuffer: 1024 * 1024 });
    };
    await xdo('windowactivate', '--sync', windowId);
    const key = async (value: string) => xdo('key', '--clearmodifiers', value);
    const navigate = async (url: string) => {
      await key('ctrl+l');
      await xdo('type', '--clearmodifiers', '--delay', '1', '--', url);
      await key('Return');
      await new Promise((resolve) => setTimeout(resolve, 700));
    };

    if ((action === 'launch' || action === 'goto') && payload.url) await navigate(payload.url);
    else if (action === 'back') await key('alt+Left');
    else if (action === 'forward') await key('alt+Right');
    else if (action === 'reload') await key('ctrl+r');
    else if (action === 'new_tab' || action === 'switch_or_open_tab') {
      await key('ctrl+t');
      if (payload.url) await navigate(payload.url);
    } else if (action === 'next_tab') await key('ctrl+Tab');
    else if (action === 'previous_tab') await key('ctrl+shift+Tab');
    else if (action === 'switch_tab') await key(`ctrl+${Math.min(9, Math.max(1, Number(payload.tabIndex || 0) + 1))}`);
    else if (action === 'close_tab') await key('ctrl+w');
    else if (action === 'duplicate_tab') {
      await key('ctrl+l');
      await key('alt+Return');
    } else if (action === 'press') await key(this.linuxKey(String(payload.key || 'Return')));
    else if (action === 'click') await xdo('mousemove', '--window', windowId, '--sync', String(payload.x), String(payload.y), 'click', '1');
    else if (action === 'dblclick') await xdo('mousemove', '--window', windowId, '--sync', String(payload.x), String(payload.y), 'click', '--repeat', '2', '--delay', '80', '1');
    else if (action === 'hover') await xdo('mousemove', '--window', windowId, '--sync', String(payload.x), String(payload.y));
    else if (action === 'type' || action === 'fill') {
      if (action === 'fill') await key('ctrl+a');
      if (action === 'fill') await key('BackSpace');
      await xdo('type', '--clearmodifiers', '--delay', '1', '--', String(payload.text || ''));
    } else if (action === 'clear') {
      await key('ctrl+a');
      await key('BackSpace');
    } else if (action === 'scroll') {
      const button = payload.direction === 'up' ? '4' : payload.direction === 'left' ? '6' : payload.direction === 'right' ? '7' : '5';
      await xdo('click', '--repeat', '4', '--delay', '45', button);
    } else if (action === 'wait') {
      await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, Math.max(0, Number(payload.amount || 0)))));
    }

    const { stdout: titleOut } = await execFileAsync(
      'xdotool',
      ['getwindowname', windowId],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    let screenshot = '';
    if (payload.capture) {
      const tempPath = path.join(os.tmpdir(), `eterx-browser-${process.pid}-${Date.now()}.jpg`);
      try {
        try {
          await execFileAsync('import', ['-window', windowId, tempPath], { timeout: 8000 });
        } catch {
          await execFileAsync('gnome-screenshot', ['-w', '-f', tempPath], { timeout: 8000 });
        }
        screenshot = (await fs.readFile(tempPath)).toString('base64');
      } catch {
        screenshot = '';
      } finally {
        await fs.remove(tempPath).catch(() => {});
      }
    }
    return {
      state: {
        browser: browser.label,
        processName: browser.className,
        pid: 0,
        title: String(titleOut || '').trim(),
        // Without CDP/DOM access the current URL cannot be observed after a
        // redirect or tab change. Do not report a stale requested URL as fact.
        url: '',
        text: '',
        refs: [],
        tabs: [],
      },
      screenshot,
    };
  }

  private linuxKey(value: string): string {
    const keys: Record<string, string> = {
      Enter: 'Return',
      Escape: 'Escape',
      Tab: 'Tab',
      Backspace: 'BackSpace',
      Delete: 'Delete',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      PageUp: 'Page_Up',
      PageDown: 'Page_Down',
    };
    return value.split('+').map(part => {
      if (/^(ControlOrMeta|Control|Ctrl|Meta|Cmd|Command)$/i.test(part)) return 'ctrl';
      if (/^(Alt|Option)$/i.test(part)) return 'alt';
      if (/^Shift$/i.test(part)) return 'shift';
      const name = Object.keys(keys).find(key => key.toLowerCase() === part.toLowerCase());
      return name ? keys[name] : part;
    }).join('+');
  }

  private formatSnapshot(state: NativeState): string {
    const lines = [
      `Page: ${state.title || '(untitled)'}`,
      `URL: ${state.url || '(address unavailable)'}`,
      `Browser: ${state.browser} (current signed-in window)`,
      '',
      'Interactive controls:',
      ...state.refs.map((ref) => {
        const label = ref.name || ref.value || '(unlabelled)';
        return `[${ref.ref}] ${ref.role} "${label.slice(0, 140)}"`;
      }),
    ];
    if (state.text) lines.push('', 'Page text:', state.text.slice(0, 30000));
    return lines.join('\n');
  }
}

export const nativeCurrentBrowser = new NativeCurrentBrowserController();
