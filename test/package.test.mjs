import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import {
  crc32, zip, assembleIndex, escAttr, planAssets, atStep, rewriteAssets, fitBudget, BUDGET_STEPS,
  rmse, fidelityVerdict, encodeGif, palette, gifTimes, storyboardTimes, checkCm360, mimeOf,
} from '../tools/package/lib.mjs';

// ---- minimal readers used to verify the writers ----
function unzip(buf) {
  const out = new Map();
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const crc = buf.readUInt32LE(p + 14);
    const csize = buf.readUInt32LE(p + 18);
    const nlen = buf.readUInt16LE(p + 26);
    const xlen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nlen).toString();
    const body = buf.subarray(p + 30 + nlen + xlen, p + 30 + nlen + xlen + csize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    assert.equal(crc32(data), crc, `crc of ${name}`);
    out.set(name, data);
    p += 30 + nlen + xlen + csize;
  }
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50);
  assert.equal(buf.readUInt16LE(buf.length - 12), out.size);
  return out;
}

function decodeGif(buf) {
  let p = 0;
  const u16 = () => { const v = buf[p] | (buf[p + 1] << 8); p += 2; return v; };
  assert.equal(buf.subarray(0, 6).toString(), 'GIF89a');
  p = 6;
  const width = u16();
  const height = u16();
  const flags = buf[p]; p += 3;
  const size = 1 << ((flags & 7) + 1);
  const pal = [];
  for (let i = 0; i < size; i += 1) { pal.push([buf[p], buf[p + 1], buf[p + 2]]); p += 3; }
  const frames = [];
  let loop = false;
  let delay = 0;
  while (buf[p] !== 0x3b) {
    if (buf[p] === 0x21) {
      const label = buf[p + 1];
      p += 2;
      if (label === 0xff && buf.subarray(p + 1, p + 12).toString() === 'NETSCAPE2.0') loop = true;
      if (label === 0xf9) delay = buf[p + 2] | (buf[p + 3] << 8);
      while (buf[p]) p += buf[p] + 1;
      p += 1;
    } else {
      assert.equal(buf[p], 0x2c);
      p += 10;
      const min = buf[p]; p += 1;
      const data = [];
      while (buf[p]) { data.push(...buf.subarray(p + 1, p + 1 + buf[p])); p += buf[p] + 1; }
      p += 1;
      // LZW decode
      const clear = 1 << min;
      let codeSize = min + 1;
      let dict = [];
      const reset = () => { dict = []; for (let i = 0; i < clear; i += 1) dict[i] = [i]; dict[clear] = []; dict[clear + 1] = null; codeSize = min + 1; };
      reset();
      const px = [];
      let bit = 0;
      let prev = null;
      const read = () => {
        let v = 0;
        for (let i = 0; i < codeSize; i += 1, bit += 1) v |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
        return v;
      };
      for (;;) {
        const code = read();
        if (code === clear) { reset(); prev = null; } else if (code === clear + 1) break;
        else {
          let entry;
          if (code < dict.length && dict[code]) entry = dict[code];
          else entry = [...prev, prev[0]];
          px.push(...entry);
          if (prev) dict.push([...prev, entry[0]]);
          prev = entry;
          if (dict.length === (1 << codeSize) && codeSize < 12) codeSize += 1;
        }
      }
      frames.push({ px, delay });
    }
  }
  return {
    width, height, pal, frames, loop,
  };
}

// ---- zip ----
test('crc32 matches the reference value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('zip round-trips stored and deflated entries with stable bytes', () => {
  const big = 'a'.repeat(5000);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const files = [{ name: 'index.html', data: big }, { name: 'assets/hero.png', data: png }];
  const a = zip(files);
  assert.deepEqual(a, zip(files));
  const got = unzip(a);
  assert.equal(got.get('index.html').toString(), big);
  assert.deepEqual(got.get('assets/hero.png'), png);
  assert.ok(a.length < 1000, 'repetitive html was deflated');
  assert.throws(() => zip([{ name: '../x', data: '' }]), /bad name/);
  assert.throws(() => zip([{ name: '/abs', data: '' }]), /bad name/);
});

// ---- index.html ----
test('assembleIndex writes a self-contained CM360 index', () => {
  const html = assembleIndex({
    blockHtml: '<div class="ad"><a class="ad-click" href="javascript:window.open(window.clickTag)"></a><script data-clicktag="">var clickTag = "x";</script></div>',
    css: '.ad{position:relative}',
    width: 300,
    height: 250,
    clickTag: 'https://example.com/?a=1&b=</script>',
    title: 'Spring <A>',
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta name="ad.size" content="width=300,height=250">/);
  assert.match(html, /<title>Spring &lt;A&gt;<\/title>/);
  assert.match(html, /var clickTag = "https:\/\/example.com\/\?a=1&b=\\u003c\/script>";/);
  assert.equal((html.match(/<script/g) || []).length, 1, 'block script dropped');
  assert.match(html, /\.ad\{position:relative\}/);
  assert.match(html, /<body class="ad-export"><div class="ad">/);
});

// ---- assets ----
test('planAssets names one file per unique src; atStep and rewriteAssets', () => {
  const d = 'https://delivery-p1-e2.adobeaemcloud.com/adobe/assets/urn:aaid:aem:1/as/Hero%20Shot.JPEG?width=600&quality=85';
  const plan = planAssets([
    { src: d, label: 'Hero Shot', box: { w: 300 } },
    { src: d, label: 'dup', box: { w: 300 } },
    { src: 'https://x.example/static-0.png', label: 'static-0', box: { w: 300 } },
    { src: 'https://x.example/other', label: 'Hero Shot', box: { w: 10 } },
    { src: '', label: 'none' },
  ]);
  assert.deepEqual(plan.map((a) => a.rel), ['assets/hero-shot.jpg', 'assets/static-0.png', 'assets/hero-shot.png']);
  const u = new URL(atStep(d, { w: 300 }, { scale: 1.5, quality: 55 }));
  assert.equal(u.searchParams.get('width'), '450');
  assert.equal(u.searchParams.get('quality'), '55');
  assert.equal(atStep('https://x.example/a.png', { w: 1 }, BUDGET_STEPS[0]), 'https://x.example/a.png');
  const m = 'https://main--a--b.aem.page/ads/x/media_13ae1f35.png?width=750&format=png&optimize=medium';
  const up = new URL(atStep(m, { w: 1080 }, { scale: 1.5, quality: 55 }));
  assert.equal(up.searchParams.get('width'), '1620');
  assert.equal(up.searchParams.get('format'), 'png');
  assert.equal(up.searchParams.get('optimize'), 'medium');
  assert.equal(new URL(atStep(m, { w: 1080 }, BUDGET_STEPS[4], { jpg: true })).searchParams.get('format'), 'pjpg');
  const slices = planAssets([
    { src: m, label: 'static-0', box: { w: 1080 }, back: true },
    { src: m.replace('13ae', '14ae'), label: 'static-1', box: { w: 1080 } },
    { src: 'https://x.example/bg.png', label: 'bg', box: { w: 1 }, back: true },
  ]);
  assert.deepEqual(slices.map((a) => [a.rel, a.jpg]), [['assets/static-0.jpg', true], ['assets/static-1.png', false], ['assets/bg.png', false]]);
  const html = `<img src="${escAttr(d)}"><img src="https://x.example/static-0.png">`;
  assert.equal(rewriteAssets(html, plan), '<img src="assets/hero-shot.jpg"><img src="assets/static-0.png">');
  assert.equal(mimeOf('a/b.JPG'), 'image/jpeg');
  assert.match(mimeOf('index.html'), /^text\/html/);
  assert.equal(mimeOf('ad.css'), 'text/css');
});

test('fitBudget stops at the first step under budget, else flags over', async () => {
  const sizes = [500, 400, 300, 200, 150];
  let i = 0;
  const build = async () => ({ zip: Buffer.alloc(sizes[i++]) }); // eslint-disable-line no-plusplus
  const r = await fitBudget(350, build);
  assert.equal(r.over, false);
  assert.deepEqual(r.step, BUDGET_STEPS[2]);
  assert.deepEqual(r.tried.map((t) => t.bytes), [500, 400, 300]);
  i = 0;
  const o = await fitBudget(100, build);
  assert.equal(o.over, true);
  assert.equal(o.zip.length, 150);
  assert.equal(o.tried.length, 5);
});

// ---- pixels ----
test('rmse and fidelityVerdict', () => {
  const a = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]);
  assert.equal(rmse(a, a), 0);
  assert.equal(rmse(a, new Uint8Array([255, 255, 255, 0, 0, 0, 0, 0])), 1);
  assert.ok(Math.abs(rmse(a, new Uint8Array([10, 10, 10, 0, 255, 255, 255, 0])) - Math.sqrt(300 / 6) / 255) < 1e-9);
  assert.throws(() => rmse(a, new Uint8Array(4)), /size mismatch/);
  assert.equal(fidelityVerdict(0.01), 'pass');
  assert.equal(fidelityVerdict(0.04), 'warn');
  assert.equal(fidelityVerdict(0.2), 'fail');
});

// ---- GIF ----
const solid = (w, h, fn) => {
  const f = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p += 1) {
    const [r, g, b] = fn(p % w, Math.floor(p / w));
    f.set([r, g, b, 255], p * 4);
  }
  return f;
};

test('palette keeps distinct colours apart', () => {
  const f = solid(4, 1, (x) => [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]][x]);
  const pal = palette([f]);
  assert.equal(pal.length, 4);
  [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]].forEach((c) => {
    assert.ok(pal.some((q) => q.every((v, i) => Math.abs(v - c[i]) <= 4)), `has ${c}`);
  });
});

test('encodeGif round-trips through a decoder (looping, delays, LZW resets)', () => {
  const w = 64;
  const h = 48;
  // many colours + noise so the LZW table fills past 4096 and clears
  const frames = [0, 1, 2].map((t) => solid(w, h, (x, y) => [(x * 4 + t * 40) & 255, (y * 5) & 255, ((x * y) ^ (t * 77)) & 255]));
  const gif = encodeGif(frames, w, h, 7);
  const d = decodeGif(gif);
  assert.equal(d.width, w);
  assert.equal(d.height, h);
  assert.equal(d.loop, true);
  assert.equal(d.frames.length, 3);
  d.frames.forEach((fr, t) => {
    assert.equal(fr.delay, 7);
    assert.equal(fr.px.length, w * h);
    let err = 0;
    for (let p = 0; p < w * h; p += 1) {
      const c = d.pal[fr.px[p]];
      for (let k = 0; k < 3; k += 1) err += Math.abs(c[k] - frames[t][p * 4 + k]);
    }
    assert.ok(err / (w * h * 3) < 24, `frame ${t} close to source (${err / (w * h * 3)})`);
  });
  // two-colour image: exact
  const two = solid(5, 3, (x) => (x % 2 ? [255, 255, 255] : [0, 0, 0]));
  const d2 = decodeGif(encodeGif([two], 5, 3));
  d2.frames[0].px.forEach((i, p) => assert.deepEqual(d2.pal[i], p % 5 % 2 ? [252, 252, 252] : [4, 4, 4]));
});

test('gifTimes and storyboardTimes', () => {
  assert.deepEqual(gifTimes(0.3), { fps: 10, times: [0, 0.1, 0.2] });
  assert.equal(gifTimes(12).fps, 5);
  assert.equal(gifTimes(12).times.length, 60);
  assert.deepEqual(storyboardTimes(6), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(storyboardTimes(8, 3), [2.67, 5.33, 8]);
});

// ---- CM360 ----
test('checkCm360 passes a conforming package and names each problem', () => {
  const index = assembleIndex({
    blockHtml: '<div class="ad"><a class="ad-click" href="javascript:window.open(window.clickTag)"><img src="assets/a.png"></a></div>',
    css: '',
    width: 300,
    height: 250,
    clickTag: 'https://example.com',
  });
  const files = new Map([['index.html', Buffer.from(index)], ['assets/a.png', Buffer.alloc(1)]]);
  assert.deepEqual(checkCm360({
    files, zipBytes: 1000, width: 300, height: 250, totalSeconds: 16,
  }), []);

  const bad = index.replace('assets/a.png', 'https://cdn.example/a.png').replace('width=300', 'width=320')
    .replace('</body>', '<img src="assets/missing.png"><div style="background:url(//x.example/b.png)"></div></body>');
  const issues = checkCm360({
    files: new Map([['index.html', Buffer.from(bad)]]),
    zipBytes: 11 * 1024 * 1024,
    width: 300,
    height: 250,
    totalSeconds: 40,
    external: ['https://fonts.example/f.woff2'],
  }).map((i) => i.code);
  assert.deepEqual(issues.sort(), ['CM360_ABSOLUTE_URL', 'CM360_ABSOLUTE_URL', 'CM360_AD_SIZE', 'CM360_EXTERNAL_REQUEST', 'CM360_MISSING_FILE', 'CM360_TOO_LONG', 'CM360_ZIP_TOO_LARGE']);
  assert.deepEqual(checkCm360({ files: new Map(), zipBytes: 0 }).map((i) => i.code), ['CM360_NO_INDEX']);
  const noTag = index.replace(/var clickTag = [^;]*;/, '').replace('window.open(window.clickTag)', 'void 0');
  assert.deepEqual(checkCm360({
    files: new Map([['index.html', Buffer.from(noTag)], ['assets/a.png', Buffer.alloc(1)]]), zipBytes: 1, width: 300, height: 250, totalSeconds: 1,
  }).map((i) => i.code), ['CM360_NO_CLICKTAG', 'CM360_NO_CLICKTHROUGH']);
});
