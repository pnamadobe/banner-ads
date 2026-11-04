/*
 * Pure helpers for the CM360 packager (tools/package/run.mjs): zip writer, index.html
 * assembly, asset naming and budget steps, GIF encoder, pixel diff and the CM360 spec check.
 * No dependencies beyond Node itself, so all of it is unit-tested (test/package.test.mjs).
 */
import { deflateRawSync } from 'node:zlib';

// ---- zip (store or deflate, whichever is smaller; fixed timestamps for stable output) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_DATE = (1 << 5) | 1; // 1980-01-01
const DOS_TIME = 0;

/** files: [{ name, data: Buffer|string }] -> Buffer */
export function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  files.forEach(({ name, data }) => {
    if (!/^[\w.-]+(\/[\w.-]+)*$/.test(name) || name.split('/').includes('..')) throw new Error(`zip: bad name ${name}`);
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const fname = Buffer.from(name);
    const crc = crc32(raw);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // utf-8 names
    head.writeUInt16LE(useDeflate ? 8 : 0, 8);
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(fname.length, 26);
    head.writeUInt16LE(0, 28);
    locals.push(head, fname, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cen.writeUInt16LE(DOS_TIME, 12);
    cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(fname.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, fname);
    offset += head.length + fname.length + body.length;
  });
  const cdir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdir, end]);
}

// ---- index.html ----
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
/** What Element.outerHTML writes for an attribute value. */
export const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u00a0/g, '&nbsp;');

/**
 * blockHtml: the decorated `.ad` block (outerHTML) from ?export=cm360; its clickTag script is
 * dropped and a fresh one goes in the head. css: blocks/ad/ad.css.
 */
export function assembleIndex({
  blockHtml, css, width, height, clickTag, title = 'Ad',
}) {
  const block = String(blockHtml).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const tag = JSON.stringify(String(clickTag || '')).replace(/</g, '\\u003c');
  return [
    '<!doctype html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    `<meta name="ad.size" content="width=${Number(width)},height=${Number(height)}">`,
    `<title>${escHtml(title)}</title>`,
    `<script>var clickTag = ${tag};</script>`,
    `<style>html,body{margin:0;padding:0;overflow:hidden}\n${css}</style>`,
    '</head>',
    `<body class="ad-export">${block}</body>`,
    '</html>',
  ].join('\n');
}

// ---- assets ----
const EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
};
export const mimeOf = (name) => EXT[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';

const slug = (s) => String(s || 'img').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'img';

/** An Edge Delivery media bus image (media_<hash>.png), which the EDS optimizer can resize and re-encode. */
export function isEdsMedia(src) {
  try {
    return /\/media_[0-9a-f]+\.(png|jpe?g|gif|webp)$/i.test(new URL(src).pathname);
  } catch {
    return false;
  }
}

/**
 * images: [{ src, label, box, back }] -> [{ src, rel, label, box, jpg }] (one entry per unique src).
 * back marks the back-most layer: nothing is under it, so an EDS slice there can ship as JPEG.
 */
export function planAssets(images) {
  const seen = new Map();
  const used = new Set();
  images.forEach(({
    src, label, box, back,
  }) => {
    if (!src || seen.has(src)) return;
    let ext = 'png';
    try {
      const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(src).pathname);
      if (m && EXT[m[1].toLowerCase()]) ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    } catch { /* relative or bad url: keep png */ }
    const jpg = Boolean(back) && isEdsMedia(src);
    if (jpg) ext = 'jpg';
    const base = slug(label);
    let rel = `assets/${base}.${ext}`;
    for (let n = 2; used.has(rel); n += 1) rel = `assets/${base}-${n}.${ext}`;
    used.add(rel);
    seen.set(src, {
      src, rel, label, box, jpg,
    });
  });
  return [...seen.values()];
}

/** Budget ladder: tried in order until the zip fits. */
export const BUDGET_STEPS = [
  { scale: 2, quality: 85 },
  { scale: 2, quality: 70 },
  { scale: 2, quality: 55 },
  { scale: 1.5, quality: 55 },
  { scale: 1, quality: 55 },
];

/**
 * Image URL at a budget step. Dynamic Media takes width + quality. EDS media takes width and
 * a format: progressive JPEG when jpg (the opaque back slice), else PNG to keep alpha. EDS has
 * no quality knob, so only the scale steps shrink it. Other URLs are fetched as is.
 */
export function atStep(src, box, step, { jpg = false } = {}) {
  try {
    const u = new URL(src);
    const width = String(Math.max(1, Math.ceil((box && box.w ? box.w : 1) * step.scale)));
    if (u.pathname.includes('/adobe/assets/')) {
      u.searchParams.set('width', width);
      u.searchParams.set('quality', String(step.quality));
      return u.href;
    }
    if (!isEdsMedia(src)) return src;
    u.search = '';
    u.searchParams.set('width', width);
    u.searchParams.set('format', jpg ? 'pjpg' : 'png');
    u.searchParams.set('optimize', 'medium');
    return u.href;
  } catch {
    return src;
  }
}

/** Swap every planned src in the serialized block for its zip-relative path. */
export function rewriteAssets(html, assets) {
  let out = String(html);
  assets.forEach(({ src, rel }) => { out = out.split(`"${escAttr(src)}"`).join(`"${rel}"`); });
  return out;
}

/**
 * Tries BUDGET_STEPS in order. build(step) -> Promise<{ zip: Buffer, ... }>.
 * Returns the first build under budget, else the smallest step's build with over: true.
 */
export async function fitBudget(budgetBytes, build, steps = BUDGET_STEPS) {
  const tried = [];
  let last;
  for (let i = 0; i < steps.length; i += 1) {
    last = await build(steps[i]);
    tried.push({ ...steps[i], bytes: last.zip.length });
    if (last.zip.length <= budgetBytes) {
      return {
        ...last, step: steps[i], tried, over: false,
      };
    }
  }
  return {
    ...last, step: steps.at(-1), tried, over: true,
  };
}

// ---- pixels ----
/** Root-mean-square difference of two same-size RGBA buffers, 0 (same) .. 1. Alpha ignored. */
export function rmse(a, b) {
  if (a.length !== b.length || a.length % 4) throw new Error('rmse: size mismatch');
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const d = a[i + c] - b[i + c];
      sum += d * d;
    }
  }
  return Math.sqrt(sum / ((a.length / 4) * 3)) / 255;
}

export function fidelityVerdict(score) {
  if (score <= 0.02) return 'pass';
  if (score <= 0.05) return 'warn';
  return 'fail';
}

// ---- GIF (global median-cut palette, LZW, loops forever) ----
const bin = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/** Median cut over a 15-bit histogram of every frame. Returns [[r,g,b], ...] (<= max). */
export function palette(frames, max = 256) {
  const hist = new Uint32Array(32768);
  frames.forEach((f) => {
    for (let i = 0; i < f.length; i += 4) hist[bin(f[i], f[i + 1], f[i + 2])] += 1;
  });
  const bins = [];
  for (let i = 0; i < hist.length; i += 1) if (hist[i]) bins.push(i);
  const ch = (v, c) => (v >> (10 - c * 5)) & 31;
  let boxes = [bins];
  while (boxes.length < max) {
    let pick = -1;
    let best = 0;
    let axis = 0;
    boxes.forEach((box, bi) => {
      if (box.length < 2) return;
      for (let c = 0; c < 3; c += 1) {
        let lo = 31;
        let hi = 0;
        box.forEach((v) => { const x = ch(v, c); if (x < lo) lo = x; if (x > hi) hi = x; });
        if (hi - lo > best) { best = hi - lo; pick = bi; axis = c; }
      }
    });
    if (pick < 0) break;
    const box = boxes[pick].slice().sort((p, q) => ch(p, axis) - ch(q, axis));
    const total = box.reduce((s, v) => s + hist[v], 0);
    let acc = 0;
    let cut = 1;
    for (; cut < box.length - 1; cut += 1) {
      acc += hist[box[cut - 1]];
      if (acc >= total / 2) break;
    }
    boxes = [...boxes.slice(0, pick), box.slice(0, cut), box.slice(cut), ...boxes.slice(pick + 1)];
  }
  return boxes.map((box) => {
    const s = [0, 0, 0];
    let n = 0;
    box.forEach((v) => {
      const w = hist[v];
      for (let c = 0; c < 3; c += 1) s[c] += ((ch(v, c) << 3) + 4) * w;
      n += w;
    });
    return s.map((x) => Math.round(x / n));
  });
}

function indexer(pal) {
  const cache = new Int16Array(32768).fill(-1);
  return (r, g, b) => {
    const k = bin(r, g, b);
    if (cache[k] < 0) {
      let best = 0;
      let bd = Infinity;
      pal.forEach(([pr, pg, pb], i) => {
        const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
        if (d < bd) { bd = d; best = i; }
      });
      cache[k] = best;
    }
    return cache[k];
  };
}

function lzw(indices, minCodeSize) {
  const out = [];
  let cur = 0;
  let shift = 0;
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let size = minCodeSize + 1;
  let next = eoi + 1;
  let table = new Map();
  const emit = (code) => {
    cur |= code << shift;
    shift += size;
    while (shift >= 8) { out.push(cur & 0xff); cur >>>= 8; shift -= 8; }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const hit = table.get(key);
    if (hit === undefined) {
      emit(prefix);
      if (next === 4096) {
        emit(clear);
        next = eoi + 1;
        size = minCodeSize + 1;
        table = new Map();
      } else {
        if (next >= (1 << size)) size += 1;
        table.set(key, next);
        next += 1;
      }
      prefix = k;
    } else prefix = hit;
  }
  emit(prefix);
  emit(eoi);
  if (shift > 0) out.push(cur & 0xff);
  return out;
}

/** frames: [Uint8Array RGBA (w*h*4)]; delayCs: centiseconds per frame. -> Buffer */
export function encodeGif(frames, width, height, delayCs = 10) {
  const pal = palette(frames);
  while (pal.length < 2) pal.push([0, 0, 0]);
  let bits = 1;
  while ((1 << bits) < pal.length) bits += 1;
  const n = 1 << bits;
  const bytes = [];
  const u16 = (v) => bytes.push(v & 0xff, (v >> 8) & 0xff);
  bytes.push(...Buffer.from('GIF89a'));
  u16(width);
  u16(height);
  bytes.push(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0);
  for (let i = 0; i < n; i += 1) bytes.push(...(pal[i] || [0, 0, 0]));
  bytes.push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0);
  const index = indexer(pal);
  const minCode = Math.max(2, bits);
  frames.forEach((f) => {
    bytes.push(0x21, 0xf9, 4, 0x04);
    u16(delayCs);
    bytes.push(0, 0);
    bytes.push(0x2c);
    u16(0); u16(0); u16(width); u16(height);
    bytes.push(0);
    const idx = new Uint8Array(width * height);
    for (let p = 0; p < idx.length; p += 1) idx[p] = index(f[p * 4], f[p * 4 + 1], f[p * 4 + 2]);
    bytes.push(minCode);
    const data = lzw(idx, minCode);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      bytes.push(chunk.length, ...chunk);
    }
    bytes.push(0);
  });
  bytes.push(0x3b);
  return Buffer.from(bytes);
}

/** Frame times (s) for the animated preview: one loop at fps. */
export function gifTimes(duration, fps = duration <= 10 ? 10 : 5) {
  const count = Math.max(1, Math.round(duration * fps));
  return { fps, times: Array.from({ length: count }, (_, i) => i / fps) };
}

/** Storyboard frames: six evenly spaced moments of one loop, ending on the last. */
export const storyboardTimes = (duration, count = 6) => Array.from({ length: count }, (_, i) => Math.round(((duration * (i + 1)) / count) * 100) / 100);

// ---- CM360 spec check (the spec, not the CM360 validator) ----
const MAX_ZIP = 10 * 1024 * 1024;
const MAX_FILES = 100;

/**
 * files: Map(name -> Buffer); zipBytes; width, height; totalSeconds; external: [url]
 * requested during the offline render. Returns [{ code, message }] (empty = conforms).
 */
export function checkCm360({
  files, zipBytes, width, height, totalSeconds, external = [],
}) {
  const issues = [];
  const add = (code, message) => issues.push({ code, message });
  const html = files.get('index.html');
  if (!html) {
    add('CM360_NO_INDEX', 'index.html is not at the root of the zip');
    return issues;
  }
  const text = html.toString('utf8');
  const meta = /<meta\s+name="ad\.size"\s+content="width=(\d+),height=(\d+)"/i.exec(text);
  if (!meta) add('CM360_NO_AD_SIZE', 'index.html has no ad.size meta tag');
  else if (Number(meta[1]) !== width || Number(meta[2]) !== height) add('CM360_AD_SIZE', `ad.size is ${meta[1]}x${meta[2]}, expected ${width}x${height}`);
  if (!/var\s+clickTag\s*=/.test(text)) add('CM360_NO_CLICKTAG', 'index.html does not declare var clickTag');
  if (!/window\.open\(\s*(window\.)?clickTag\s*\)/.test(text)) add('CM360_NO_CLICKTHROUGH', 'the click-through does not use window.open(clickTag)');
  const refs = [...text.matchAll(/\s(?:src|href)="([^"]*)"|url\(\s*['"]?([^'")]+)/gi)].map((m) => m[1] || m[2]);
  refs.filter((r) => /^(https?:)?\/\//i.test(r)).forEach((r) => add('CM360_ABSOLUTE_URL', `absolute reference ${r.slice(0, 120)}`));
  refs.filter((r) => r && !/^(https?:|\/\/|javascript:|data:|#)/i.test(r) && !files.has(r.split(/[?#]/)[0]))
    .forEach((r) => add('CM360_MISSING_FILE', `${r} is referenced but not in the zip`));
  external.forEach((u) => add('CM360_EXTERNAL_REQUEST', `the ad requested ${String(u).slice(0, 120)} at render time`));
  if (files.size > MAX_FILES) add('CM360_TOO_MANY_FILES', `${files.size} files, CM360 allows ${MAX_FILES}`);
  if (zipBytes > MAX_ZIP) add('CM360_ZIP_TOO_LARGE', `zip is ${zipBytes} bytes, CM360 allows ${MAX_ZIP}`);
  if (totalSeconds > 30) add('CM360_TOO_LONG', `animation runs ${totalSeconds} s, the limit is 30 s`);
  return issues;
}
