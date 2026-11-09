import path from 'node:path';
import { createRequire } from 'node:module';

type Row = Record<string, any>;
export interface ReadonlyDatabase {
  prepare(sql: string): { all(...values: string[]): Row[]; get(...values: string[]): Row | undefined; iterate(...values: string[]): IterableIterator<Row> };
  close(): void;
}

/** Desktop Electron and dev Node do not necessarily ship the same Node version.
 * Use Node's reader when available and the existing Koffi dependency + OS SQLite
 * otherwise. Both paths open READONLY, including the source's committed WAL. */
export function openReadonlyDatabase(file: string): ReadonlyDatabase {
  try {
    const builtinRequire = createRequire(path.join(process.cwd(), 'package.json'));
    const sqlite = builtinRequire('node:sqlite') as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => ReadonlyDatabase };
    return new sqlite.DatabaseSync(file, { readOnly: true });
  } catch (error) {
    // A database error is not evidence that the built-in module is unavailable.
    if (!['ERR_UNKNOWN_BUILTIN_MODULE', 'MODULE_NOT_FOUND'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
  }
  return openNativeReader(file);
}

let nativeApi: ReturnType<typeof loadNativeApi> | undefined;
function loadNativeApi() {
  const koffi = require('koffi') as typeof import('koffi');
  const library = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'winsqlite3.dll')
    : process.platform === 'darwin' ? '/usr/lib/libsqlite3.dylib' : 'libsqlite3.so.0';
  const lib = koffi.load(library);
  const open = lib.func('int sqlite3_open_v2(const char *file, _Out_ void **db, int flags, const char *vfs)');
  const close = lib.func('int sqlite3_close_v2(void *db)');
  const prepare = lib.func('int sqlite3_prepare_v2(void *db, const char *sql, int length, _Out_ void **statement, void *tail)');
  const bind = lib.func('int sqlite3_bind_text(void *statement, int index, const void *value, int length, void *destroy)');
  const step = lib.func('int sqlite3_step(void *statement)');
  const finalize = lib.func('int sqlite3_finalize(void *statement)');
  const columns = lib.func('int sqlite3_column_count(void *statement)');
  const columnName = lib.func('const char *sqlite3_column_name(void *statement, int index)');
  const columnText = lib.func('const char *sqlite3_column_text(void *statement, int index)');
  const columnType = lib.func('int sqlite3_column_type(void *statement, int index)');
  const errorMessage = lib.func('const char *sqlite3_errmsg(void *db)');
  const busyTimeout = lib.func('int sqlite3_busy_timeout(void *db, int milliseconds)');
  return { lib, open, close, prepare, bind, step, finalize, columns, columnName, columnText, columnType, errorMessage, busyTimeout };
}

function openNativeReader(file: string): ReadonlyDatabase {
  const { open, close, prepare, bind, step, finalize, columns, columnName, columnText, columnType, errorMessage, busyTimeout } = nativeApi ||= loadNativeApi();
  const connection: any[] = [null];
  const opened = open(file, connection, 0x00000001, null); // SQLITE_OPEN_READONLY
  let handle = connection[0];
  if (opened !== 0 || !handle) {
    const message = handle ? errorMessage(handle) : 'Could not open the database';
    if (handle) close(handle);
    throw new Error(String(message));
  }
  busyTimeout(handle, 200);
  const statements = new Set<any>();
  function* rows(sql: string, values: string[]): IterableIterator<Row> {
    if (!handle) throw new Error('Database is closed.');
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error('The import reader accepts SELECT statements only.');
    const pointer: any[] = [null];
    const prepared = prepare(handle, sql, -1, pointer, null);
    const statement = pointer[0];
    if (prepared !== 0 || !statement) { if (statement) finalize(statement); throw new Error(String(errorMessage(handle))); }
    statements.add(statement);
    const buffers = values.map(value => Buffer.from(`${value}\0`, 'utf8'));
    try {
      for (let index = 0; index < buffers.length; index++) if (bind(statement, index + 1, buffers[index], buffers[index].length - 1, null) !== 0) throw new Error('Could not bind a database key.');
      const count = columns(statement);
      const names = Array.from({ length: count }, (_, index) => String(columnName(statement, index)));
      let code: number;
      while ((code = step(statement)) === 100) { // SQLITE_ROW
        const row: Row = Object.create(null);
        for (let index = 0; index < count; index++) {
          const type = columnType(statement, index);
          const value = type === 5 ? null : columnText(statement, index);
          row[names[index]] = type === 1 || type === 2 ? Number(value) : value;
        }
        yield row;
      }
      if (code !== 101) throw new Error(String(errorMessage(handle))); // SQLITE_DONE
    } finally { if (statements.delete(statement)) finalize(statement); buffers.length = 0; }
  }
  return {
    prepare: sql => ({
      all: (...values) => [...rows(sql, values)],
      get: (...values) => { const iterator = rows(sql, values); try { return iterator.next().value; } finally { iterator.return?.(undefined); } },
      iterate: (...values) => rows(sql, values),
    }),
    close: () => {
      if (!handle) return;
      for (const statement of statements) finalize(statement);
      statements.clear(); close(handle); handle = null;
    },
  };
}
