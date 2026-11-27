'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Braces, Clock3, Copy, Send, Table2 } from 'lucide-react';
import { workbenchAction } from '../../lib/workbench/client';
import { localWorkbenchUrl, type ApiResult } from '../../lib/workbench/contracts';

const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function describeJson(body: string) {
  try {
    const value: unknown = JSON.parse(body);
    const rows = Array.isArray(value) ? value : null;
    const records = rows && rows.slice(0, 150).every(row => row && typeof row === 'object' && !Array.isArray(row))
      ? rows.slice(0, 150) as Record<string, unknown>[] : null;
    const columns = records ? [...new Set(records.flatMap(row => Object.keys(row)))].slice(0, 20) : [];
    return { pretty: JSON.stringify(value, null, 2), rows: records, columns, total: rows?.length || 0 };
  } catch {
    return { pretty: body, rows: null, columns: [], total: 0 };
  }
}

export function WorkbenchApi({ chatId, initialUrl, desktop, onOpen }: { chatId: string; initialUrl?: string; desktop: boolean; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState(initialUrl || '');
  const [method, setMethod] = useState('GET');
  const [headers, setHeaders] = useState('');
  const [body, setBody] = useState('');
  const [mode, setMode] = useState<'body' | 'headers' | 'table'>('body');
  const [result, setResult] = useState<ApiResult | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const request = useRef<AbortController | null>(null);
  const json = useMemo(() => describeJson(result?.body || ''), [result?.body]);
  useEffect(() => {
    if (!initialUrl) return;
    request.current?.abort();
    request.current = null;
    setUrl(initialUrl);
    setResult(null);
    setPending(false);
    setError('');
  }, [initialUrl]);
  useEffect(() => () => request.current?.abort(), []);
  const send = async () => {
    if (!desktop || !url.trim()) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setResult(null);
    setError('');
    setMode('body');
    try {
      const endpoint = localWorkbenchUrl(url).href;
      const response = await workbenchAction<ApiResult>(chatId, 'api-call', { url: endpoint, method, headers, body }, controller.signal);
      if (!controller.signal.aborted) setResult(response);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Request failed.');
    } finally {
      if (request.current === controller) { request.current = null; setPending(false); }
    }
  };
  const canSendBody = method !== 'GET' && method !== 'HEAD';
  return <div className="eterx-wb-api eterx-scrollbar">
    <form className="eterx-wb-request" onSubmit={event => { event.preventDefault(); void send(); }}>
      <div className="eterx-wb-request-line">
        <select aria-label="HTTP method" value={method} onChange={event => setMethod(event.target.value)}>{methods.map(value => <option key={value}>{value}</option>)}</select>
        <input aria-label="Local endpoint" value={url} onChange={event => setUrl(event.target.value)} placeholder="http://localhost:3000/api" spellCheck={false} />
        {pending ? <button type="button" className="eterx-wb-button" onClick={() => request.current?.abort()}>Cancel</button>
          : <button type="submit" className="eterx-wb-button is-primary" disabled={!desktop || !url.trim()}><Send size={14} />Send</button>}
      </div>
      <details className="eterx-wb-request-details">
        <summary>Request headers{canSendBody && ' and body'}</summary>
        <label>Headers<textarea value={headers} onChange={event => setHeaders(event.target.value)} maxLength={8192} placeholder="Content-Type: application/json" spellCheck={false} rows={2} /></label>
        {canSendBody && <label>Body<textarea value={body} onChange={event => setBody(event.target.value)} maxLength={384000} placeholder={'{"key": "value"}'} spellCheck={false} rows={4} /></label>}
      </details>
    </form>
    {error && <p className="eterx-wb-error" role="alert">{error}</p>}
    {pending && <div className="eterx-wb-placeholder" role="status">Waiting for the local service…</div>}
    {!desktop && <div className="eterx-wb-placeholder">Open EterX Desktop on the development host to send local requests.</div>}
    {!result && !pending && !error && desktop && <div className="eterx-wb-placeholder"><Braces size={26} /><strong>Response</strong><span>Send a request to inspect its status, headers, and body.</span></div>}
    {result && <section className="eterx-wb-response" aria-label="API response">
      <div className="eterx-wb-response-meta">
        <span className="eterx-wb-status" data-status={result.status < 400 ? 'completed' : 'failed'}>{result.status} {result.statusText}</span>
        <span><Clock3 size={13} />{result.elapsedMs} ms</span>
        {result.truncated && <span>Response truncated</span>}
        {method === 'GET' && <button type="button" className="eterx-wb-icon" title="Open endpoint in browser" aria-label="Open endpoint in browser" onClick={() => onOpen(result.url)}><ArrowUpRight size={15} /></button>}
      </div>
      <div className="eterx-wb-response-tabs">
        <button type="button" aria-pressed={mode === 'body'} onClick={() => setMode('body')}>Body</button>
        <button type="button" aria-pressed={mode === 'headers'} onClick={() => setMode('headers')}>Headers</button>
        {json.columns.length > 0 && <button type="button" aria-pressed={mode === 'table'} onClick={() => setMode('table')}><Table2 size={13} />Table</button>}
        <button type="button" className="eterx-wb-icon" title="Copy response" aria-label="Copy response" onClick={() => void navigator.clipboard.writeText(mode === 'headers' ? result.headers.map(([key, value]) => key + ': ' + value).join('\n') : json.pretty).catch(() => setError('Clipboard access is unavailable.'))}><Copy size={15} /></button>
      </div>
      {mode === 'headers' && <dl className="eterx-wb-headers">{result.headers.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}
      {mode === 'body' && <pre className="eterx-wb-code eterx-scrollbar">{json.pretty || 'No response body.'}</pre>}
      {mode === 'table' && json.rows && <div className="eterx-wb-data eterx-scrollbar">
        <table><thead><tr>{json.columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>{json.rows.map((row, index) => <tr key={index}>{json.columns.map(name => <td key={name}>{typeof row[name] === 'object' ? JSON.stringify(row[name]) : String(row[name] ?? '')}</td>)}</tr>)}</tbody>
        </table>
        {json.rows.length < json.total && <p>Showing {json.rows.length} of {json.total} rows.</p>}
      </div>}
    </section>}
  </div>;
}
