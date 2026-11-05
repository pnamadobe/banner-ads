/* eslint-disable import/no-extraneous-dependencies */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  parseMotion, timing, assignMotion, keyframesFor, keyframesCss,
} from '../blocks/ad/ad-motion.js';
import {
  parseStyle, parseBox, parseSize, safeUrl, bind, lineBreaks, pickRow, sheetRows, deliveryUrl, readBlock, fitText,
} from '../blocks/ad/ad.js';

const STAGE = { width: 300, height: 250 };

test('parseMotion', () => {
  assert.deepEqual(parseMotion('fadeUp@0.4'), { preset: 'fadeUp', delay: 0.4, duration: undefined });
  assert.deepEqual(parseMotion('WIPE @1s/0.8'), { preset: 'wipe', delay: 1, duration: 0.8 });
  assert.equal(parseMotion('explode'), null);
  assert.equal(parseMotion(''), null);
  assert.equal(parseMotion('fade; color:red'), null);
});

test('timing caps duration x loops at 30s', () => {
  assert.deepEqual(timing(), { duration: 6, loops: 1 });
  assert.deepEqual(timing(15, 3), { duration: 15, loops: 2 });
  assert.deepEqual(timing(99, 9), { duration: 30, loops: 1 });
});

test('assignMotion defaults: static none, hero kenburns, reading order, cta last', () => {
  const layers = [
    { name: 'static-0', kind: 'image', box: { x: 0, y: 0, w: 300, h: 250 } },
    { name: 'hero', kind: 'image', box: { x: 0, y: 0, w: 300, h: 250 } },
    { name: 'cta', kind: 'text', box: { x: 16, y: 200, w: 120, h: 32 } },
    { name: 'subhead', kind: 'text', box: { x: 16, y: 120, w: 268, h: 20 } },
    { name: 'headline', kind: 'text', box: { x: 16, y: 80, w: 268, h: 40 } },
    { name: 'logo', kind: 'image', box: { x: 16, y: 16, w: 80, h: 24 }, motion: { preset: 'wipe' } },
  ];
  assignMotion(layers, { stage: STAGE, duration: 6 });
  const by = Object.fromEntries(layers.map((l) => [l.name, l.motion]));
  assert.equal(by['static-0'].preset, 'none');
  assert.deepEqual(by.hero, { preset: 'kenburns', delay: 0, duration: 6 });
  assert.deepEqual(by.headline, { preset: 'fadeUp', delay: 0.3, duration: 0.5 });
  assert.equal(by.subhead.delay, 0.6);
  assert.equal(by.cta.preset, 'pulse');
  assert.ok(by.cta.delay > by.subhead.delay);
  assert.deepEqual(by.logo, { preset: 'wipe', delay: 0, duration: 0.5 });
});

test('keyframes span the timeline and end on the designed state', () => {
  const frames = keyframesFor({ preset: 'fadeUp', delay: 1.5, duration: 0.5 }, { box: {}, stage: STAGE, duration: 6 });
  assert.deepEqual(frames.map((f) => f.offset), [0, 0.25, 2 / 6, 1]);
  assert.deepEqual(frames.at(-1).props, { opacity: 1, transform: 'none' });
  assert.deepEqual(keyframesFor({ preset: 'none', delay: 0, duration: 0 }, { stage: STAGE, duration: 6 }), []);
  const css = keyframesCss('ad1-k0', frames);
  assert.match(css, /^@keyframes ad1-k0\{0%\{opacity:0;transform:translateY\(12px\)/);
  assert.match(css, /100%\{opacity:1;transform:none\}\}$/);
});

test('parseStyle rotate', () => {
  assert.equal(parseStyle('focus:50,30 rotate:-4.3').css.rotate, '-4.3deg');
  assert.equal(parseStyle('rotate:5.6deg').css.rotate, '5.6deg');
  assert.equal(parseStyle('rotate:abc').css.rotate, undefined);
});

test('parseStyle', () => {
  const { css, flags } = parseStyle('"Proxima Nova" Bold 22/24 #fff center caps track:20 valign:middle button');
  assert.deepEqual(css, {
    fontFamily: '"Proxima Nova", sans-serif',
    fontWeight: '700',
    fontSize: '22px',
    lineHeight: '24px',
    color: '#fff',
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: '0.02em',
  });
  assert.deepEqual(flags, { valign: 'middle', button: true });
  assert.equal(parseStyle('Evil};body{x').css.fontFamily, '"Evilbodyx", sans-serif');
});

test('parsers and binding', () => {
  assert.deepEqual(parseBox('16, 80, 268, 40'), {
    x: 16, y: 80, w: 268, h: 40,
  });
  assert.equal(parseBox('1,2,3'), null);
  assert.deepEqual(parseSize('300×250'), { width: 300, height: 250 });
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,x'), null);
  assert.equal(bind('{Headline}!', { headline: 'Hi' }), 'Hi!');
  assert.equal(bind('{missing}', {}), '');
  const rows = sheetRows({ ':names': ['a'], a: { data: [{ outputFileName: 'One' }] } });
  assert.equal(pickRow(rows, 'one').outputFileName, 'One');
  assert.equal(pickRow(rows, 'nope'), null);
  assert.equal(deliveryUrl('https://d.example/adobe/assets/urn:x/as/a.jpg', { w: 150 }), 'https://d.example/adobe/assets/urn:x/as/a.jpg?width=300');
  assert.equal(deliveryUrl('https://m--a--b.aem.page/ads/x/media_1a2b.png?width=750&format=png&optimize=medium', { w: 1080 }), 'https://m--a--b.aem.page/ads/x/media_1a2b.png?width=2160&format=webply&optimize=medium');
});

const BLOCK = `<div class="ad">
  <div><div>size</div><div>300x250</div><div>duration 6</div><div>loops 2</div><div>rows /drafts/variations.json</div></div>
  <div><div>static-0</div><div>image</div><div><img src="/drafts/bg.svg"></div><div>0,0,300,250</div><div>none</div></div>
  <div><div>hero</div><div>image</div><div>{hero}</div><div>0,0,300,250</div><div>kenburns · focus:50,30 rotate:-4.3</div></div>
  <div><div>headline</div><div>text</div><div>{headline}</div><div>16,150,268,48</div><div>fadeUp@0.4 · Sans Bold 22/24 #fff</div></div>
  <div><div>cta</div><div>text</div><div>{cta}</div><div>16,206,120,28</div><div></div><div>bg:#e00 #fff 13 button radius:4</div></div>
  <div><div>junk</div><div>video</div><div>x</div><div>0,0,1,1</div></div>
</div>`;

const ROWS = {
  data: [
    {
      outputFileName: 'Spring', headline: 'Spring <b>sale</b>', cta: 'Shop', hero: '/drafts/hero.svg', clickthrough: 'https://example.com/spring?a=1&b="</script>',
    },
    { outputFileName: 'Fall', headline: 'Fall', cta: 'Go' },
  ],
};

async function render(search) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body><main>${BLOCK}</main></body></html>`, {
    url: `https://main--banner-ads--pnamadobe.aem.page/ads/demo${search}`,
  });
  const { window } = dom;
  Object.assign(globalThis, { window, document: window.document });
  globalThis.fetch = async () => ({ ok: true, json: async () => ROWS });
  const { default: decorate } = await import('../blocks/ad/ad.js');
  const block = window.document.querySelector('.ad');
  await decorate(block);
  return { window, block };
}

test('readBlock reads config and skips invalid layers', () => {
  const { window } = new JSDOM(BLOCK);
  const { config, layers } = readBlock(window.document.querySelector('.ad'));
  assert.deepEqual(config, {
    size: '300x250', duration: '6', loops: '2', rows: '/drafts/variations.json',
  });
  assert.deepEqual(layers.map((l) => l.name), ['static-0', 'hero', 'headline', 'cta']);
  assert.equal(layers[0].source, '/drafts/bg.svg');
});

test('preview render: layout, motion, text-safe binding, controls', async () => {
  const { block } = await render('?v=spring');
  assert.equal(block.dataset.adRow, 'Spring');
  const stage = block.querySelector('.ad-stage');
  assert.equal(stage.style.width, '300px');
  const layers = [...stage.querySelectorAll('.ad-layer')];
  assert.equal(layers.length, 4);
  const headline = stage.querySelector('[data-label="headline"]');
  assert.equal(headline.textContent, 'Spring <b>sale</b>');
  // a tilted frame rotates the layer; kenburns still runs on the picture inside it
  const hero = stage.querySelector('[data-label="hero"]');
  assert.equal(hero.style.rotate, '-4.3deg');
  assert.match(hero.querySelector('img').style.animation, /-k1 /);
  assert.equal(headline.querySelector('b'), null);
  assert.equal(headline.style.top, '150px');
  assert.match(headline.style.animation, /ad1-k2 6s linear 0s 2 both/);
  const heroImg = stage.querySelector('[data-label="hero"] img');
  assert.match(heroImg.style.animation, /ad1-k1/); // kenburns animates the img, not the frame
  assert.equal(heroImg.style.objectPosition, '50% 30%');
  assert.ok(stage.querySelector('[data-label="cta"]').classList.contains('ad-button'));
  assert.match(block.querySelector('style').textContent, /@keyframes ad1-k2/);
  const a = block.querySelector('a.ad-click');
  assert.equal(a.target, '_blank');
  assert.equal(block.querySelectorAll('.ad-controls a').length, 2);
  assert.equal(typeof block.adTimeline.seek, 'function');
  assert.equal(block.adTimeline.total, 12);
});

test('export=cm360: ad.size, escaped clickTag, javascript click-through, no controls', async () => {
  const { window, block } = await render('?export=cm360&v=Spring');
  const doc = window.document;
  assert.equal(doc.querySelector('meta[name="ad.size"]').content, 'width=300,height=250');
  const script = block.querySelector('script[data-clicktag]').textContent;
  assert.ok(!script.includes('</script'), 'clickTag must not close the script element');
  const clickTag = new window.Function(`${script}; return clickTag;`)();
  assert.equal(clickTag, 'https://example.com/spring?a=1&b=%22%3C/script%3E');
  assert.equal(block.querySelector('a.ad-click').getAttribute('href'), 'javascript:window.open(window.clickTag)');
  assert.equal(block.querySelector('.ad-controls'), null);
  assert.ok(doc.body.classList.contains('ad-export'));
});

test('unknown row is an error, not a silent fallback', async () => {
  const { block } = await render('?export=cm360&v=Winter');
  assert.equal(block.dataset.adError, 'row-not-found');
  assert.equal(block.querySelector('.ad-stage'), null);
});

test('fitText shrinks overflowing copy to its frame, leaves fitting copy alone', () => {
  const { window } = new JSDOM('<div class="stage"></div>');
  const stage = window.document.querySelector('.stage');
  const layer = (text, frameH) => {
    const el = window.document.createElement('div');
    el.className = 'ad-layer ad-text';
    Object.assign(el.style, { fontSize: '40px', lineHeight: '40px' });
    const inner = window.document.createElement('span');
    inner.className = 'ad-text-in';
    inner.textContent = text;
    el.append(inner);
    // fake layout: copy is 3 lines of lineHeight tall, 100px wide
    Object.defineProperty(el, 'clientWidth', { value: 200 });
    Object.defineProperty(el, 'clientHeight', { value: frameH });
    Object.defineProperty(inner, 'offsetHeight', { get: () => 3 * parseFloat(el.style.lineHeight) });
    Object.defineProperty(inner, 'offsetWidth', { value: 100 });
    Object.defineProperty(inner, 'scrollWidth', { value: 100 });
    stage.append(el);
    return el;
  };
  const big = layer('too long', 90);
  const ok = layer('fits', 130);
  fitText(stage);
  assert.ok(parseFloat(big.style.fontSize) <= 30, big.style.fontSize);
  assert.ok(parseFloat(big.style.fontSize) >= 28);
  assert.equal(big.dataset.fit, String(parseFloat(big.style.fontSize) / 40));
  assert.equal(ok.style.fontSize, '40px');
  assert.equal(ok.dataset.fit, undefined);
});

test('lineBreaks', () => {
  assert.equal(lineBreaks('Fly to\\nDenver'), 'Fly to\nDenver');
  assert.equal(lineBreaks('Fly to \\n Denver\r\nnow'), 'Fly to\nDenver\nnow');
  assert.equal(lineBreaks(''), '');
});

test('parseStyle stroke', () => {
  const { css } = parseStyle('40 #3a1f6b stroke:2.3,#e0d8ff');
  assert.equal(css.webkitTextStroke, '2.3px #e0d8ff');
  assert.equal(css.paintOrder, 'stroke fill');
  assert.equal(css.color, '#3a1f6b');
  assert.equal(parseStyle('stroke:2;red').css.webkitTextStroke, undefined);
});
