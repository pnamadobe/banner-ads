/*
 * `ad` block: one HTML5 banner, laid out from the InDesign export.
 *
 *   | ad       |        |            |              |                                   |
 *   | size     | 300x250| duration 6 | loops 1      | rows /ads/<campaign>/variations.json |
 *   | static-0 | image  | <url>      | 0,0,300,250  | none                              |
 *   | hero     | image  | {hero}     | 0,0,300,250  | kenburns · focus:50,30            |
 *   | headline | text   | {headline} | 16,150,268,48| fadeUp@0.4 · Sans Bold 22/24 #fff |
 *
 * Rows are layers, bottom to top. `{label}` binds to the sheet column of that name; `?v=` picks
 * the row (by outputFileName). `?export=cm360` adds ad.size + clickTag for packaging.
 * `window.adTimeline` = { duration, loops, total, ready, seek(t), play(), restart() }.
 */
import {
  timing, parseMotion, assignMotion, keyframesFor, keyframesCss, isFullBleed,
} from './ad-motion.js';

const CONFIG_KEYS = ['size', 'duration', 'loops', 'rows', 'clickthrough'];
const KINDS = ['image', 'text'];
const WEIGHTS = {
  thin: 100,
  extralight: 200,
  light: 300,
  regular: 400,
  book: 400,
  roman: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
  heavy: 900,
};
const ALIGN = ['left', 'center', 'right', 'justify'];

const cellText = (cell) => (cell ? cell.textContent.trim() : '');

/** http(s) or same-origin relative URLs only; anything else (javascript:, data:) is dropped. */
export function safeUrl(value, base = 'https://localhost/') {
  if (!value) return null;
  try {
    const u = new URL(value, base);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

export function parseBox(str) {
  const n = (str || '').split(/[\s,]+/).filter(Boolean).map(Number);
  if (n.length !== 4 || n.some(Number.isNaN)) return null;
  const [x, y, w, h] = n;
  return {
    x, y, w, h,
  };
}

export function parseSize(str) {
  const m = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(str || '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** Pattern tokens: [regex, (match, css, flags) => void]. First match wins. */
const STYLE_RULES = [
  [/^#[0-9a-f]{3,8}$/i, ([hex], css) => { css.color = hex; }],
  [/^bg:(#[0-9a-f]{3,8})$/i, ([, hex], css) => { css.backgroundColor = hex; }],
  [/^(\d*\.?\d+)(?:\/(\d*\.?\d+))?(?:px)?$/, ([, size, lead], css) => {
    css.fontSize = `${size}px`;
    if (lead) css.lineHeight = `${lead}px`;
  }],
  [/^track:(-?\d*\.?\d+)$/i, ([, n], css) => { css.letterSpacing = `${Number(n) / 1000}em`; }],
  [/^radius:(\d*\.?\d+)$/i, ([, n], css) => { css.borderRadius = `${n}px`; }],
  [/^valign:(top|middle|center|bottom)$/i, ([, v], css, flags) => { flags.valign = v.toLowerCase(); }],
  [/^focus:(\d*\.?\d+),(\d*\.?\d+)$/i, ([, x, y], css) => { css.objectPosition = `${x}% ${y}%`; }],
  [/^fit:(cover|contain|fill)$/i, ([, fit], css) => { css.objectFit = fit.toLowerCase(); }],
  // the CSS `rotate` property, not `transform`: it composes with the motion keyframes
  [/^rotate:(-?\d*\.?\d+)(?:deg)?$/i, ([, n], css) => { css.rotate = `${Number(n)}deg`; }],
];

/** Bare-word tokens (case-insensitive). */
function wordRule(t, css, flags) {
  if (WEIGHTS[t]) css.fontWeight = String(WEIGHTS[t]);
  else if (t === 'italic') css.fontStyle = 'italic';
  else if (ALIGN.includes(t)) css.textAlign = t;
  else if (t === 'caps' || t === 'upper') css.textTransform = 'uppercase';
  else if (t === 'lower') css.textTransform = 'lowercase';
  else if (t === 'button') flags.button = true;
  else return false;
  return true;
}

/**
 * Style tokens exported by the capability,
 * e.g. `"Proxima Nova" Bold 22/24 #fff center caps track:20`.
 * Unrecognised bare words make up the font family. Returns CSS property map + flags.
 */
export function parseStyle(str) {
  const css = {};
  const flags = {};
  const family = [];
  const tokens = (str || '').match(/"[^"]*"|\S+/g) || [];
  tokens.forEach((tok) => {
    if (tok.startsWith('"')) {
      family.push(tok.slice(1, -1));
      return;
    }
    const rule = STYLE_RULES.find(([re]) => re.test(tok));
    if (rule) rule[1](rule[0].exec(tok), css, flags);
    else if (!wordRule(tok.toLowerCase(), css, flags)) family.push(tok);
  });
  const name = family.join(' ').replace(/["\\;{}<>]/g, '').trim();
  if (name) css.fontFamily = `"${name}", sans-serif`;
  return { css, flags };
}

/** Value of an image cell: picture/img src, link href, or text (a URL or `{label}`). */
function cellSource(cell) {
  if (!cell) return '';
  const img = cell.querySelector('img');
  if (img) return img.getAttribute('src');
  const a = cell.querySelector('a[href]');
  if (a) return a.getAttribute('href');
  return cellText(cell);
}

/** Reads the authored table into { config, layers }. Tolerates missing and extra cells. */
export function readBlock(block) {
  const config = {};
  const layers = [];
  [...block.children].forEach((row) => {
    const cells = [...row.children];
    const first = cellText(cells[0]);
    const key = first.toLowerCase();
    if (!first) return;
    if (CONFIG_KEYS.includes(key)) {
      config[key] = key === 'rows' ? cellSource(cells[1]) : cellText(cells[1]);
      cells.slice(2).forEach((c) => {
        const m = /^(\w+)\s*[:=]?\s*(.*)$/.exec(cellText(c));
        if (m && CONFIG_KEYS.includes(m[1].toLowerCase())) {
          config[m[1].toLowerCase()] = m[1].toLowerCase() === 'rows' ? (cellSource(c).replace(/^rows\s*/i, '') || m[2]) : m[2];
        }
      });
      return;
    }
    const kind = cellText(cells[1]).toLowerCase();
    const box = parseBox(cellText(cells[3]));
    if (!KINDS.includes(kind) || !box) {
      // eslint-disable-next-line no-console
      console.warn(`ad: skipping layer "${first}" (needs kind image|text and a box x,y,w,h)`);
      return;
    }
    const [motionPart, ...styleParts] = cellText(cells[4]).split('·');
    const styleStr = [...styleParts, cellText(cells[5])].join(' ').trim();
    layers.push({
      name: first,
      kind,
      source: kind === 'image' ? cellSource(cells[2]) : cellText(cells[2]),
      box,
      motion: parseMotion(motionPart),
      style: parseStyle(styleStr),
    });
  });
  return { config, layers };
}

/** Replaces `{column}` with the row's value. Unknown columns become empty. */
export function bind(value, row) {
  return (value || '').replace(/\{([\w.-]+)\}/g, (_, k) => {
    const hit = Object.keys(row || {}).find((c) => c.toLowerCase() === k.toLowerCase());
    return hit ? String(row[hit] ?? '') : '';
  });
}

/** Rows from an EDS sheet JSON (single or multi-sheet). */
export function sheetRows(json) {
  if (!json) return [];
  if (Array.isArray(json.data)) return json.data;
  const names = json[':names'] || Object.keys(json).filter((k) => !k.startsWith(':'));
  const sheet = json.default || json[names[0]];
  return (sheet && Array.isArray(sheet.data)) ? sheet.data : [];
}

export function pickRow(rows, v) {
  if (!v) return rows[0] || {};
  return rows.find((r) => String(r.outputFileName || '').toLowerCase() === v.toLowerCase()) || null;
}

/**
 * Asks for a 2x rendition: Dynamic Media OpenAPI delivery when the URL carries no width, and
 * EDS media (media_<hash>.png, which EDS writes at width=750 whatever the ad size) as WebP.
 */
export function deliveryUrl(url, box) {
  try {
    const u = new URL(url);
    const width = String(Math.ceil(box.w * 2));
    if (u.pathname.includes('/adobe/assets/') && !u.searchParams.has('width')) {
      u.searchParams.set('width', width);
    } else if (/\/media_[0-9a-f]+\.(png|jpe?g|gif|webp)$/i.test(u.pathname)) {
      u.search = '';
      u.searchParams.set('width', width);
      u.searchParams.set('format', 'webply');
      u.searchParams.set('optimize', 'medium');
    }
    return u.href;
  } catch {
    return url;
  }
}

const px = (n) => `${n}px`;

function place(el, box) {
  Object.assign(el.style, {
    left: px(box.x), top: px(box.y), width: px(box.w), height: px(box.h),
  });
}

/**
 * Builds the stage for one row. Returns { stage, css, missing } where css is the keyframes
 * stylesheet text and missing lists bound columns the row has no value for.
 * @param {Document} doc
 */
export function buildStage(doc, {
  size, layers, row, duration, loops, id = 'ad',
}) {
  const stage = doc.createElement('div');
  stage.className = 'ad-stage is-loading';
  stage.style.width = px(size.width);
  stage.style.height = px(size.height);
  const rules = [];
  const missing = [];
  const ctx = { stage: size, duration };

  assignMotion(layers, ctx);
  layers.forEach((layer, i) => {
    const el = doc.createElement('div');
    el.className = `ad-layer ad-${layer.kind}`;
    el.dataset.label = layer.name;
    el.dataset.motion = `${layer.motion.preset}@${layer.motion.delay}/${layer.motion.duration}`;
    place(el, layer.box);
    const { css, flags } = layer.style;
    if (css.rotate) el.style.rotate = css.rotate;
    const bound = /\{[\w.-]+\}/.test(layer.source);
    const value = bind(layer.source, row);
    if (bound && !value) missing.push(layer.name);

    let animated = el;
    if (layer.kind === 'image') {
      const src = safeUrl(value, doc.baseURI);
      if (src) {
        const img = doc.createElement('img');
        img.src = deliveryUrl(src, layer.box);
        img.alt = bind(`{${layer.name}_alt}`, row);
        img.decoding = 'sync';
        img.loading = 'eager';
        if (css.objectPosition) img.style.objectPosition = css.objectPosition;
        if (css.objectFit) img.style.objectFit = css.objectFit;
        el.append(img);
        // kenburns moves the picture inside its frame; the frame clips it
        if (layer.motion.preset === 'kenburns') animated = img;
      }
    } else {
      el.textContent = value;
      const {
        objectPosition, objectFit, rotate, ...textCss
      } = css;
      Object.assign(el.style, textCss);
      if (flags.button) el.classList.add('ad-button');
      if (flags.valign) el.dataset.valign = flags.valign === 'center' ? 'middle' : flags.valign;
    }

    const frames = keyframesFor(layer.motion, { ...ctx, box: layer.box });
    if (frames.length) {
      const name = `${id}-k${i}`;
      rules.push(keyframesCss(name, frames));
      animated.style.animation = `${name} ${duration}s linear 0s ${loops} both`;
    }
    stage.append(el);
  });
  return { stage, css: rules.join('\n'), missing };
}

function waitReady(stage, doc) {
  const imgs = [...stage.querySelectorAll('img')].map((img) => (img.decode
    ? img.decode().catch(() => {})
    : Promise.resolve()));
  const fonts = doc.fonts && doc.fonts.ready ? doc.fonts.ready : Promise.resolve();
  const timeout = new Promise((r) => { setTimeout(r, 10000); });
  return Promise.race([Promise.all([...imgs, fonts]), timeout]);
}

function makeTimeline(stage, { duration, loops }, ready) {
  const anims = () => (stage.getAnimations ? stage.getAnimations({ subtree: true }) : []);
  return {
    duration,
    loops,
    total: duration * loops,
    ready,
    /** Pauses every layer at t seconds (0..total). */
    seek(t) {
      const ms = Math.min(Math.max(Number(t) || 0, 0), duration * loops) * 1000;
      anims().forEach((a) => { a.pause(); a.currentTime = ms; });
    },
    play() { anims().forEach((a) => a.play()); },
    restart() { anims().forEach((a) => { a.currentTime = 0; a.play(); }); },
  };
}

/** CM360 essentials: ad.size meta, var clickTag, click-through via window.open(clickTag). */
function applyExport(doc, block, stage, { size, clickthrough }) {
  let meta = doc.head.querySelector('meta[name="ad.size"]');
  if (!meta) {
    meta = doc.createElement('meta');
    meta.name = 'ad.size';
    doc.head.append(meta);
  }
  meta.content = `width=${size.width},height=${size.height}`;
  const script = doc.createElement('script');
  script.dataset.clicktag = '';
  script.textContent = `var clickTag = ${JSON.stringify(clickthrough || '').replace(/</g, '\\u003c')};`;
  block.append(script);
  const a = doc.createElement('a');
  a.className = 'ad-click';
  a.setAttribute('aria-label', 'Open advertiser site');
  a.setAttribute('href', 'javascript:window.open(window.clickTag)'); // eslint-disable-line no-script-url
  a.append(stage);
  doc.body.classList.add('ad-export');
  return a;
}

function previewControls(doc, rows, current, timeline) {
  const nav = doc.createElement('div');
  nav.className = 'ad-controls';
  const replay = doc.createElement('button');
  replay.type = 'button';
  replay.textContent = 'Replay';
  replay.addEventListener('click', () => timeline.restart());
  nav.append(replay);
  rows.forEach((r) => {
    if (!r.outputFileName) return;
    const link = doc.createElement('a');
    const u = new URL(doc.location.href);
    u.searchParams.set('v', r.outputFileName);
    link.href = u.pathname + u.search;
    link.textContent = r.outputFileName;
    if (r === current) link.setAttribute('aria-current', 'true');
    nav.append(link);
  });
  return nav;
}

async function fetchRows(path) {
  if (!path) return [];
  const url = safeUrl(path, window.location.href);
  if (!url || new URL(url).origin !== window.location.origin) {
    throw new Error(`rows must be a same-site sheet path, got "${path}"`);
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`rows ${path}: HTTP ${resp.status}`);
  return sheetRows(await resp.json());
}

function fail(block, code, message) {
  block.dataset.adError = code;
  const p = document.createElement('p');
  p.className = 'ad-error';
  p.textContent = message;
  block.replaceChildren(p);
  // eslint-disable-next-line no-console
  console.error(`ad: ${message}`);
}

export default async function decorate(block) {
  const params = new URLSearchParams(window.location.search);
  const exportMode = params.get('export') === 'cm360';
  const { config, layers } = readBlock(block);

  const size = parseSize(config.size) || layers.reduce((s, { box }) => ({
    width: Math.max(s.width, box.x + box.w), height: Math.max(s.height, box.y + box.h),
  }), { width: 0, height: 0 });
  if (!size.width || !size.height || !layers.length) {
    fail(block, 'no-layers', 'ad block needs a size row and at least one layer');
    return;
  }

  let rows = [];
  try {
    rows = await fetchRows(config.rows);
  } catch (e) {
    fail(block, 'rows-unavailable', e.message);
    return;
  }
  const v = params.get('v');
  const row = pickRow(rows, v);
  if (!row) {
    fail(block, 'row-not-found', `no row with outputFileName "${v}"`);
    return;
  }

  const t = timing(config.duration, config.loops);
  const id = `ad${[...document.querySelectorAll('.ad')].indexOf(block) + 1 || 1}`;
  const { stage, css, missing } = buildStage(document, {
    size, layers, row, ...t, id,
  });
  if (missing.length) block.dataset.adMissing = missing.join(',');
  block.dataset.adRow = row.outputFileName || '';
  block.dataset.adSize = `${size.width}x${size.height}`;
  block.dataset.adFullBleed = String(layers.some((l) => isFullBleed(l.box, size)));

  const style = document.createElement('style');
  style.dataset.adKeyframes = '';
  style.textContent = css;
  block.replaceChildren(style);

  const clickthrough = safeUrl(row.clickthrough || config.clickthrough, window.location.href);
  if (exportMode) {
    block.append(applyExport(document, block, stage, { size, clickthrough }));
  } else if (clickthrough) {
    const a = document.createElement('a');
    a.className = 'ad-click';
    a.setAttribute('aria-label', 'Open advertiser site (new tab)');
    a.href = clickthrough;
    a.target = '_blank';
    a.rel = 'noopener';
    a.append(stage);
    block.append(a);
  } else {
    block.append(stage);
  }

  const ready = waitReady(stage, document).then(() => {
    stage.classList.remove('is-loading');
    block.dataset.adReady = 'true';
  });
  const timeline = makeTimeline(stage, t, ready);
  block.adTimeline = timeline;
  if (!window.adTimeline) window.adTimeline = timeline;
  if (!exportMode) block.append(previewControls(document, rows, row, timeline));
}
