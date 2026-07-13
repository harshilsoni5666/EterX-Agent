/**
 * EterX — Setup Logger
 * Writes all setup output to a log file for debugging.
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.resolve(__dirname, '..', '.workspaces');
const LOG_FILE = path.join(LOG_DIR, 'setup.log');

function initLog() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `\n${'═'.repeat(60)}\nEterX Setup — ${new Date().toISOString()}\nPlatform: ${process.platform} | Node: ${process.version}\n${'═'.repeat(60)}\n`);
  } catch {}
}

function log(level, msg) {
  try {
    const ts = new Date().toISOString().slice(11, 19);
    fs.appendFileSync(LOG_FILE, `[${ts}] [${level}] ${msg}\n`);
  } catch {}
}

function logInfo(msg) { log('INFO', msg); }
function logWarn(msg) { log('WARN', msg); }
function logError(msg) { log('ERROR', msg); }
function logOk(msg) { log('OK', msg); }

/**
 * Wrap console methods to also write to log
 */
function patchConsoleForLogging() {
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args) => {
    origLog.apply(console, args);
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').replace(/\x1b\[[0-9;]*m/g, '');
    logInfo(text);
  };

  console.warn = (...args) => {
    origWarn.apply(console, args);
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').replace(/\x1b\[[0-9;]*m/g, '');
    logWarn(text);
  };

  console.error = (...args) => {
    origError.apply(console, args);
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').replace(/\x1b\[[0-9;]*m/g, '');
    logError(text);
  };
}

module.exports = { initLog, log, logInfo, logWarn, logError, logOk, patchConsoleForLogging };
