// Teams web wraps each remote participant's tile as
//   <div data-cid="calling-participant-stream" data-tid="Display Name" data-stream-type="Video"
//        role="menuitem" aria-label="Display Name, video is on, …">
//     <div data-tid="video-stream">…<video>…</div>
//     <div data-tid="participant-info">…<div data-tid="participant-info-nametag">Display Name</div>…</div>
//   </div>
// data-tid is usually the display name but can be a placeholder such as
// "unknown_email_address@invalid.teams.ms", so the script reads the name from the nametag
// and aria-label as well and marks matching tiles itself. The CSS attribute rules stay as
// a fast path that applies before any script runs.
// Only the picture is hidden: the tile, name label and speaking outline stay, so the
// person can still be pinned or right-clicked.

const STYLE_ID = 'hide-teams-camera-style';
const HIDDEN_ATTR = 'data-htc-hidden';
const TILE_SELECTOR = '[data-cid="calling-participant-stream"], [data-stream-type][data-tid]';

function cssString(value) {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// `Sam` matches any name containing "sam"; `"Sam Lee"` (in quotes) matches that exact name only.
function parseName(entry) {
  const text = entry.trim();
  const quoted = text.match(/^["“”'](.+)["“”']$/);
  return quoted ? { text: quoted[1].trim(), exact: true } : { text, exact: false };
}

function parseNames(names) {
  return names.map(parseName).filter(({ text }) => text);
}

function matchesRule(tileNames, { text, exact }) {
  const wanted = text.toLowerCase();
  return tileNames.some((name) => (exact ? name === wanted : name.includes(wanted)));
}

// Teams web draws the camera in a <video>. The Teams desktop app (WebView2) leaves
// [data-tid="calling-stream"] empty and transparent and draws the camera natively *under*
// the page, showing through that hole; an opaque background on the box covers it.
function hideRules(tileSelectors) {
  const pictures = tileSelectors.flatMap((tile) => [`${tile} video`, `${tile} canvas`]);
  const holes = tileSelectors.map((tile) => `${tile} [data-tid="calling-stream"]`);
  const labels = tileSelectors.map((tile) => `${tile}:has(video, [data-tid="calling-stream"][data-type="video" i])::after`);
  return [
    `${pictures.join(',\n')} { visibility: hidden !important; }`,
    `${holes.join(',\n')} { background: #292929 !important; }`,
    `${labels.join(',\n')} { content: "Camera hidden"; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #adadad; font: 14px system-ui, sans-serif; pointer-events: none; }`,
  ].join('\n');
}

function buildCss(names) {
  const rules = parseNames(names);
  if (!rules.length) return '';
  const tileSelectors = [`[${HIDDEN_ATTR}]`];
  for (const { text, exact } of rules) {
    const n = cssString(text);
    const tile = '[data-cid="calling-participant-stream"]';
    if (exact) {
      tileSelectors.push(
        `[data-stream-type="video" i][data-tid=${n} i]`,
        `${tile}[aria-label^=${cssString(text + ',')} i]`,
        `${tile}[aria-label^=${cssString(text + ' Unverified,')} i]`,
      );
    } else {
      // No aria-label rule here: the label also holds words like "muted" and "pinned",
      // so a short name fragment would match every tile.
      tileSelectors.push(`[data-stream-type="video" i][data-tid*=${n} i]`);
    }
  }
  return hideRules(tileSelectors);
}

function tileNames(tile) {
  const names = [];
  const nametag = tile.querySelector('[data-tid="participant-info-nametag"]');
  if (nametag) names.push(nametag.textContent);
  const label = tile.getAttribute('aria-label');
  if (label) names.push(label.split(',')[0].replace(/\s+unverified$/i, ''));
  names.push(tile.getAttribute('data-tid') || '');
  return names.map((name) => name.trim().toLowerCase()).filter(Boolean);
}

let activeRules = [];

function markTiles() {
  for (const tile of document.querySelectorAll(TILE_SELECTOR)) {
    // A screen share is a tile too, with the sharer's name in data-tid and
    // data-stream-type="ScreenSharing" (seen live 2026-11-11). Only camera tiles are hidden.
    const type = tile.getAttribute('data-stream-type');
    const isCamera = !type || type.toLowerCase() === 'video';
    const names = isCamera && activeRules.length ? tileNames(tile) : [];
    const hide = activeRules.some((rule) => matchesRule(names, rule));
    if (tile.hasAttribute(HIDDEN_ATTR) !== hide) tile.toggleAttribute(HIDDEN_ATTR, hide);
  }
}

function apply({ names = [], enabled = true }) {
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
  }
  style.textContent = enabled ? buildCss(names) : '';
  if (!style.isConnected) document.documentElement.appendChild(style);
  activeRules = enabled ? parseNames(names) : [];
  markTiles();
}

function refresh() {
  chrome.storage.sync.get({ names: [], enabled: true }, apply);
}

if (typeof chrome !== 'undefined' && chrome.storage) {
  refresh();
  chrome.storage.onChanged.addListener(refresh);

  // Mutation callbacks run before the next paint, so a new tile is marked before it is drawn.
  let scanQueued = false;
  new MutationObserver(() => {
    if (scanQueued || !activeRules.length) return;
    scanQueued = true;
    queueMicrotask(() => {
      scanQueued = false;
      markTiles();
    });
  }).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'data-tid'],
  });

  // Teams is a single-page app and can replace the document root; put the style back if it goes.
  setInterval(() => {
    if (!document.getElementById(STYLE_ID)) refresh();
  }, 3000);
}

if (typeof module !== 'undefined') module.exports = { buildCss, parseNames, matchesRule };
