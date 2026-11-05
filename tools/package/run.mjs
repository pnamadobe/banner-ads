/*
 * CM360 packager: node tools/package/run.mjs payload.json
 *
 * Runs in GitHub Actions on a `package` repository_dispatch from the AEM extension. For each ad
 * it opens the EDS export page (?export=cm360), builds a CM360 zip that fits the budget, renders
 * the zip offline to make the preview GIF, the storyboard and the fidelity check against the
 * InDesign backup JPG, then hands everything to the extension's writeback action, which writes
 * to AEM. This repo is public: log the ad index, size and codes only, never names or the payload.
 *
 * payload: { job, origin, ads: [{ page, path, row, budgetKB, name, backup }], writeback: { url, token } }
 * Playwright is installed by the workflow (not a dependency of the site).
 */
import { readFileSync, appendFileSync } from 'node:fs';
import {
  zip, assembleIndex, planAssets, atStep, rewriteAssets, fitBudget, mimeOf,
  rmse, fidelityVerdict, encodeGif, gifTimes, storyboardTimes, checkCm360,
} from './lib.mjs';

const OFFLINE = 'https://ad.invalid/';
const PAGE_TIMEOUT = 60000;
// The GIF preview is a review aid, not the ad: its longer side is at most this many px. Full-size GIFs of
// 2880 px ads were slow (about 60 frames each) and could pass the 50 MB writeback file limit.
const PREVIEW_MAX = 800;
// Ads rendered at the same time (each in its own pages). Writeback calls stay one at a time.
const CONCURRENCY = Math.max(1, Number(process.env.PACKAGE_CONCURRENCY) || 3);
const log = (...a) => console.log(...a); // eslint-disable-line no-console

// ---- writeback (the extension action; it holds the AEM credentials) ----
function writeback(cfg) {
  return async (op, body = {}) => {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, op, token: cfg.token }),
    });
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (!res.ok) {
      const e = new Error(`writeback ${op} -> ${res.status} ${json.error || ''}`.trim());
      e.status = res.status;
      throw e;
    }
    return json;
  };
}

async function uploadParts(uris, buf) {
  const partSize = Math.ceil(buf.length / uris.length);
  for (let i = 0; i < uris.length; i += 1) {
    const part = buf.subarray(i * partSize, Math.min((i + 1) * partSize, buf.length));
    const res = await fetch(uris[i], { method: 'PUT', body: part });
    if (!(res.ok || res.status === 201)) throw new Error(`upload part ${i} -> ${res.status}`);
  }
}

// ---- fetch with a per-run cache (one asset can appear in many budget steps) ----
const cache = new Map();
async function fetchBuf(url) {
  if (!cache.has(url)) {
    cache.set(url, (async () => {
      const res = await fetch(url);
      if (!res.ok) throw Object.assign(new Error(`asset fetch -> ${res.status}`), { code: 'HTML5_ASSET_FETCH' });
      return Buffer.from(await res.arrayBuffer());
    })());
  }
  return cache.get(url);
}

// ---- browser helpers ----
/** RGBA pixels of an encoded image, resized to w x h, decoded in a plain page. */
async function decode(tool, buf, w, h) {
  const b64 = await tool.evaluate(async ({ data, width, height }) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes]), {
      resizeWidth: width, resizeHeight: height, resizeQuality: 'high',
    });
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, width, height).data;
    let s = '';
    for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode(...px.subarray(i, i + 0x8000));
    return btoa(s);
  }, { data: buf.toString('base64'), width: w, height: h });
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** Everything the export page knows about the ad. */
async function readExport(browser, url) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: PAGE_TIMEOUT });
    await page.waitForSelector('.ad[data-ad-ready="true"], .ad[data-ad-error]', { state: 'attached', timeout: PAGE_TIMEOUT });
    return await page.evaluate(() => {
      const block = document.querySelector('.ad');
      if (block.dataset.adError) return { error: block.dataset.adError };
      const meta = /width=(\d+),height=(\d+)/.exec(document.querySelector('meta[name="ad.size"]')?.content || '');
      const tl = window.adTimeline || {};
      return {
        blockHtml: block.outerHTML,
        clickTag: window.clickTag || '',
        width: meta ? Number(meta[1]) : 0,
        height: meta ? Number(meta[2]) : 0,
        duration: Number(tl.duration) || 0,
        loops: Number(tl.loops) || 1,
        total: Number(tl.total) || 0,
        missing: block.dataset.adMissing || '',
        images: [...block.querySelectorAll('.ad-layer img')].map((img) => {
          const layer = img.closest('.ad-layer');
          return {
            src: img.getAttribute('src'),
            label: img.closest('[data-label]')?.dataset.label || 'img',
            box: { w: parseFloat(layer?.style.width) || img.naturalWidth || 1 },
            // back-most layer: nothing under it, so it can ship without alpha
            back: Boolean(layer) && layer === block.querySelector('.ad-layer'),
          };
        }),
      };
    });
  } finally {
    await page.close();
  }
}

/** Open the zip with no network: files come from memory, anything else is blocked and noted. */
async function openOffline(browser, files, width, height) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const external = [];
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(OFFLINE)) {
      const name = decodeURIComponent(new URL(u).pathname.slice(1)) || 'index.html';
      const body = files.get(name);
      if (body) return route.fulfill({ status: 200, contentType: mimeOf(name), body });
      return route.fulfill({ status: 404, body: '' });
    }
    if (!u.startsWith('data:')) external.push(u);
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(`${OFFLINE}index.html`, { waitUntil: 'load', timeout: PAGE_TIMEOUT });
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: PAGE_TIMEOUT });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  // png for the fidelity frame; jpeg is faster to encode and fine for GIF/storyboard frames
  const shot = async (t, type = 'png') => {
    await page.evaluate((ms) => {
      document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ms; });
    }, t * 1000);
    return page.screenshot({
      type,
      ...(type === 'jpeg' ? { quality: 92 } : {}),
      clip: {
        x: 0, y: 0, width, height,
      },
      animations: 'allow',
    });
  };
  return { shot, external, close: () => context.close() };
}

async function storyboard(tool, pngs, times, width, height) {
  const cellW = Math.min(width, 320);
  const cellH = Math.round((height * cellW) / width);
  const cols = 3;
  const cells = pngs.map((p, i) => `<figure><img src="data:image/jpeg;base64,${p.toString('base64')}" width="${cellW}" height="${cellH}"><figcaption>${times[i].toFixed(1)} s</figcaption></figure>`).join('');
  await tool.setViewportSize({ width: cols * (cellW + 24) + 24, height: 2 * (cellH + 48) + 24 });
  await tool.setContent(`<!doctype html><style>
    body{margin:0;background:#f2f2f2;font:13px/1.2 system-ui,sans-serif;color:#333}
    #sb{display:grid;grid-template-columns:repeat(${cols},${cellW}px);gap:24px;padding:24px;width:max-content}
    figure{margin:0}img{display:block;background:#fff;box-shadow:0 0 0 1px #ccc}figcaption{padding-top:6px}
  </style><div id="sb">${cells}</div>`);
  return tool.locator('#sb').screenshot({ type: 'jpeg', quality: 85 });
}

// ---- one ad ----
async function packageAd(browser, tool, wb, origin, ad) {
  const url = new URL(ad.path, origin);
  url.searchParams.set('v', ad.row);
  url.searchParams.set('export', 'cm360');
  const info = await readExport(browser, url.href);
  if (info.error) throw Object.assign(new Error(`export page error ${info.error}`), { code: 'HTML5_EXPORT_ERROR' });
  const { width, height } = info;
  if (!width || !height) throw Object.assign(new Error('export page has no ad.size'), { code: 'HTML5_EXPORT_ERROR' });

  const cssRes = await fetch(new URL('/blocks/ad/ad.css', origin));
  if (!cssRes.ok) throw Object.assign(new Error(`ad.css -> ${cssRes.status}`), { code: 'HTML5_EXPORT_ERROR' });
  const css = await cssRes.text();
  const assets = planAssets(info.images);
  const issues = [];
  if (info.missing) issues.push({ code: 'HTML5_LAYER_MISSING', message: `layers without a value: ${info.missing}` });

  const build = async (step) => {
    const files = new Map();
    const bufs = await Promise.all(assets.map((a) => fetchBuf(atStep(a.src, a.box, step, { jpg: a.jpg }))));
    assets.forEach((a, i) => files.set(a.rel, bufs[i]));
    files.set('index.html', Buffer.from(assembleIndex({
      blockHtml: rewriteAssets(info.blockHtml, assets), css, width, height, clickTag: info.clickTag, title: ad.name,
    })));
    return { files, zip: zip([...files].map(([name, data]) => ({ name, data }))) };
  };
  const fit = await fitBudget((ad.budgetKB || 150) * 1024, build);
  if (fit.over) issues.push({ code: 'HTML5_OVER_BUDGET', message: `zip is ${Math.round(fit.zip.length / 1024)} KB at the smallest step, over the ${ad.budgetKB} KB budget` });

  // offline render: GIF, storyboard, end frame
  const view = await openOffline(browser, fit.files, width, height);
  let gif;
  let board;
  let endFrame;
  try {
    const duration = info.duration || info.total || 1;
    const { fps, times } = gifTimes(duration);
    const k = Math.min(1, PREVIEW_MAX / Math.max(width, height));
    const gw = Math.max(1, Math.round(width * k));
    const gh = Math.max(1, Math.round(height * k));
    const frames = [];
    for (const t of times) {
      frames.push(await decode(tool, await view.shot(t, 'jpeg'), gw, gh));
    }
    gif = encodeGif(frames, gw, gh, Math.round(100 / fps));
    const sbTimes = storyboardTimes(duration);
    const pngs = [];
    for (const t of sbTimes) pngs.push(await view.shot(t, 'jpeg'));
    board = await storyboard(tool, pngs, sbTimes, width, height);
    endFrame = await decode(tool, await view.shot(info.total || duration), width, height);
  } finally {
    await view.close();
  }

  // fidelity against the InDesign backup (a failure flags this ad, never the job)
  let fidelity = { verdict: 'unknown', score: null };
  const backup = ad.backup ? await wb('backup', { file: ad.backup }).catch(() => null) : null;
  if (backup && backup.data) {
    const score = rmse(endFrame, await decode(tool, Buffer.from(backup.data, 'base64'), width, height));
    fidelity = { verdict: fidelityVerdict(score), score: Math.round(score * 10000) / 10000 };
    if (fidelity.verdict === 'fail') issues.push({ code: 'HTML5_FIDELITY', message: `end frame differs from the backup (rmse ${fidelity.score})` });
  } else {
    issues.push({ code: 'HTML5_NO_BACKUP', message: 'no backup JPG to compare the end frame with' });
  }

  issues.push(...checkCm360({
    files: fit.files, zipBytes: fit.zip.length, width, height, totalSeconds: info.total, external: view.external,
  }));

  return {
    width,
    height,
    outputs: [
      { name: `${ad.name}.zip`, mime: 'application/zip', data: fit.zip },
      { name: `${ad.name}_preview.gif`, mime: 'image/gif', data: gif },
      { name: `${ad.name}_storyboard.jpg`, mime: 'image/jpeg', data: board },
    ],
    report: {
      bytes: fit.zip.length,
      budgetKB: ad.budgetKB,
      step: fit.step,
      tried: fit.tried,
      over: fit.over,
      fidelity,
      issues,
      clickthrough: info.clickTag,
      duration: info.duration,
      loops: info.loops,
      previewUrl: url.href.replace(/[?&]export=cm360/, ''),
    },
  };
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: node tools/package/run.mjs payload.json');
  const payload = JSON.parse(readFileSync(file, 'utf8'));
  if (payload.writeback?.token) log(`::add-mask::${payload.writeback.token}`);
  const wb = writeback(payload.writeback);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const summary = [];
  let failed = 0;
  // one writeback call chain: the action updates a single state record per run
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

  const one = async (tool, i) => {
    const ad = payload.ads[i];
    try {
      const out = await packageAd(browser, tool, wb, payload.origin, ad);
      await serial(async () => {
        const init = await wb('initiate', { ad: i, files: out.outputs.map((o) => ({ name: o.name, mime: o.mime, size: o.data.length })) });
        for (const o of out.outputs) {
          const f = (init.files || []).find((x) => x.name === o.name);
          if (!f || !f.uploadURIs?.length) throw new Error('writeback initiate: no upload URI');
          await uploadParts(f.uploadURIs, o.data);
          o.uploadToken = f.uploadToken;
        }
        await wb('complete', {
          ad: i,
          files: out.outputs.map((o) => ({
            name: o.name, mime: o.mime, size: o.data.length, uploadToken: o.uploadToken,
          })),
          report: out.report,
        });
      });
      const codes = [...new Set(out.report.issues.map((x) => x.code))].join(',') || '-';
      summary[i] = `| ${i + 1} | ${out.width}x${out.height} | ${Math.round(out.report.bytes / 1024)} KB | ${out.report.fidelity.verdict} | ${codes} |`;
      const gifKB = Math.round(out.outputs[1].data.length / 1024);
      log(`ad ${i + 1}: ${out.width}x${out.height} ${Math.round(out.report.bytes / 1024)} KB gif=${gifKB} KB fidelity=${out.report.fidelity.verdict} issues=${codes}`);
    } catch (e) {
      failed += 1;
      const code = e.code || 'HTML5_PACKAGE_ERROR';
      summary[i] = `| ${i + 1} | - | - | - | ${code} |`;
      log(`ad ${i + 1}: failed ${code}${e.status ? ` (${e.status})` : ''}`);
      await serial(() => wb('complete', { ad: i, files: [], report: { error: { code, message: e.message } } })).catch(() => {});
    }
  };

  // if the job is cancelled (timeout), close the run in AEM instead of leaving it "running"
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    const unreported = payload.ads.length - summary.filter(Boolean).length;
    await chain;
    await wb('done', { failed: failed + unreported }).catch(() => log('writeback done failed'));
  };
  ['SIGTERM', 'SIGINT'].forEach((sig) => process.once(sig, () => {
    log(`packager stopped (${sig})`);
    finish().finally(() => process.exit(1));
  }));

  try {
    let next = 0;
    const worker = async () => {
      const tool = await browser.newPage();
      await tool.setContent('<!doctype html><title>tool</title>');
      try {
        while (next < payload.ads.length) {
          const i = next;
          next += 1;
          await one(tool, i);
        }
      } finally {
        await tool.close().catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, payload.ads.length) }, worker));
  } finally {
    await browser.close();
    await finish();
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['## CM360 packages', '', '| ad | size | zip | fidelity | issues |', '|---|---|---|---|---|', ...summary.filter(Boolean), ''].join('\n'));
  }
  if (failed === payload.ads.length && failed) process.exitCode = 1;
}

main().catch((e) => {
  log(`packager failed: ${e.code || e.name}`);
  process.exitCode = 1;
});
