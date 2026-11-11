// Injects ../content.js into the Teams desktop app on macOS.
//
// New Teams for Mac is a WebView2 (Edge/Chromium) app. When it is started with
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<PORT>
// its WebView exposes the Chrome DevTools Protocol on 127.0.0.1:<PORT>. This script
// connects to that port, attaches to every page (main window, pop-out meeting windows),
// and runs the same content.js the Chrome extension uses, with chrome.storage replaced
// by the names in names.txt. Editing names.txt applies at once, even mid-call.
//
// It runs forever: when Teams is not running (or was started without the port) it waits
// and retries, so it can be left running as a launch agent.
//
// Usage: node inject.mjs [--port 29229] [--names /path/to/names.txt] [--once]

import { readFileSync, watch, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const PORT = Number(opt('--port', process.env.HTC_PORT || 29229));
const NAMES_FILE = opt('--names', join(here, 'names.txt'));
const ONCE = args.includes('--once');
const CONTENT_JS = readFileSync(join(here, '..', 'content.js'), 'utf8');
// The page hook is keyed by the script's hash, so an edited content.js installs fresh
// instead of only passing new names to the old copy.
const VERSION = createHash('sha1').update(CONTENT_JS).digest('hex').slice(0, 8);

const log = (...a) => console.log(new Date().toISOString(), ...a);

// names.txt: one name per line, same syntax as the extension popup ("quoted" = exact).
// Lines starting with # are comments. A line "off" (alone) disables hiding.
function readConfig() {
  if (!existsSync(NAMES_FILE)) return { names: [], enabled: true };
  const lines = readFileSync(NAMES_FILE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const enabled = !lines.some((l) => l.toLowerCase() === 'off');
  return { names: lines.filter((l) => l.toLowerCase() !== 'off'), enabled };
}

// Page-side wrapper: shims chrome.storage for content.js and runs it once per document.
// window[Symbol.for('hide-teams-camera')] holds the running copy: the same version only
// gets the new names; a different version (content.js was edited) stops the old copy's
// observer and timer first, so two copies never fight over the tiles.
function pageScript(config) {
  return `(function () {
  if (!/(^|\\.)(teams\\.microsoft\\.com|teams\\.cloud\\.microsoft|teams\\.live\\.com)$/.test(location.hostname)) return;
  const config = ${JSON.stringify(config)};
  const key = Symbol.for('hide-teams-camera');
  const running = window[key];
  if (running && running.version === '${VERSION}') { running.update(config); return; }
  if (running) running.dispose();
  let current = config;
  const listeners = [];
  const disposers = [];
  const MutationObserver = class extends window.MutationObserver {
    constructor(cb) { super(cb); disposers.push(() => this.disconnect()); }
  };
  const setInterval = (fn, ms) => { const id = window.setInterval(fn, ms); disposers.push(() => window.clearInterval(id)); return id; };
  Object.defineProperty(window, key, { configurable: true, writable: true, value: {
    version: '${VERSION}',
    update: (c) => { current = c; listeners.forEach((f) => f()); },
    dispose: () => { disposers.forEach((f) => f()); listeners.length = 0; },
  } });
  const chrome = { storage: {
    sync: { get: (defaults, cb) => cb({ ...defaults, ...current }) },
    onChanged: { addListener: (f) => listeners.push(f) },
  } };
  const module = undefined;
${CONTENT_JS}
})();`;
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.handlers.get(msg.method)?.(msg.params, msg.sessionId);
      }
    };
    this.closed = new Promise((r) => (this.ws.onclose = r));
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, fn) {
    this.handlers.set(method, fn);
  }
}

async function run() {
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.opened;
  log(`connected to ${version.Browser} on port ${PORT}`);

  let config = readConfig();
  const sessions = new Map(); // sessionId -> { scriptId, url }

  async function inject(sessionId) {
    const s = sessions.get(sessionId);
    const source = pageScript(config);
    if (s.scriptId) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: s.scriptId }, sessionId).catch(() => {});
    const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
    s.scriptId = identifier;
    await cdp.send('Runtime.evaluate', { expression: source }, sessionId);
  }

  // Attach to each page window after it exists, never pausing it. (Auto-attach with
  // waitForDebuggerOnStart froze the meeting pop-up: it opens in its opener's renderer
  // and Teams showed "Debugger paused in another tab".) Tiles appear long after a window
  // loads, and content.js's MutationObserver marks them whenever they show up.
  //
  // A new meeting window starts as a blank page that Teams swaps out while it loads, so the
  // first attach often fails ("No target with given id", "Session ... not found"). Retry,
  // and re-attach whenever a still-open window changes URL or drops our session.
  const attached = new Set(); // targetIds
  const live = new Map(); // targetId -> latest targetInfo
  async function attach(targetId, attempt = 0) {
    const info = live.get(targetId);
    if (!info || info.type !== 'page' || attached.has(targetId)) return;
    attached.add(targetId);
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      sessions.set(sessionId, { targetId });
      await inject(sessionId);
      log(`injected: ${info.title || ''} ${info.url.slice(0, 80)}`);
    } catch (err) {
      attached.delete(targetId);
      if (attempt < 10) setTimeout(() => attach(targetId, attempt + 1), 500 * (attempt + 1));
      else log(`inject failed for ${info.url}: ${err.message}`);
    }
  }
  const seen = ({ targetInfo }) => {
    live.set(targetInfo.targetId, targetInfo);
    attach(targetInfo.targetId);
  };
  cdp.on('Target.targetCreated', seen);
  cdp.on('Target.targetInfoChanged', seen);
  cdp.on('Target.targetDestroyed', ({ targetId }) => {
    live.delete(targetId);
    attached.delete(targetId);
  });
  cdp.on('Target.detachedFromTarget', ({ sessionId }) => {
    const targetId = sessions.get(sessionId)?.targetId;
    sessions.delete(sessionId);
    attached.delete(targetId);
    if (targetId) setTimeout(() => attach(targetId), 500);
  });
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  let reloadTimer;
  const watcher = watch(dirname(NAMES_FILE), (_, file) => {
    if (file && !NAMES_FILE.endsWith(file)) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      config = readConfig();
      log(`names.txt changed: ${config.enabled ? JSON.stringify(config.names) : 'off'}`);
      for (const sessionId of sessions.keys()) await inject(sessionId).catch((e) => log(e.message));
    }, 200);
  });

  log(`hiding: ${config.enabled ? JSON.stringify(config.names) : 'off'}`);
  if (ONCE) {
    await new Promise((r) => setTimeout(r, 1500));
    cdp.ws.close();
  }
  await cdp.closed;
  watcher.close();
  log('disconnected');
}

// Teams running without the port (e.g. it started at login before the launch agent set the
// variable) means cameras are NOT being hidden. Say so once, visibly.
function teamsRunning() {
  try {
    execFileSync('pgrep', ['-x', 'MSTeams'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
function warnUnprotected() {
  const msg = 'Teams is running without hide-camera support. Quit Teams (Cmd+Q) and open it again.';
  log(msg);
  execFile('osascript', ['-e', `display notification "${msg}" with title "Hide Teams Camera"`], () => {});
}

let waitingLogged = false;
let unprotectedSince = 0;
let warned = false;
for (;;) {
  try {
    await run();
    waitingLogged = false;
    unprotectedSince = 0;
    warned = false;
  } catch (err) {
    if (!waitingLogged) log(`waiting for Teams on port ${PORT} (${err.cause?.code || err.message})`);
    waitingLogged = true;
    if (!teamsRunning()) {
      unprotectedSince = 0;
      warned = false;
    } else if (!unprotectedSince) {
      unprotectedSince = Date.now();
    } else if (!warned && !ONCE && Date.now() - unprotectedSince > 30000) {
      warnUnprotected();
      warned = true;
    }
  }
  if (ONCE) break;
  await new Promise((r) => setTimeout(r, 3000));
}
