/*
 * Motion for the `ad` block: parsing `preset[@delay][/duration]`, default motion,
 * and per-layer keyframes that span the whole timeline (so loops and seek(t) are exact).
 * Pure functions, no DOM: unit-tested in test/ad.test.mjs.
 */

export const MAX_DURATION = 30;
export const MAX_LOOPS = 3;
export const DEFAULT_DURATION = 6;
export const ENTRY = 0.5; // default entry length, seconds
export const STEP = 0.3; // gap between elements in reading order, seconds
const PULSE = 1; // pulse entry + bounce, seconds

const SHOWN = { opacity: 1, transform: 'none' };

const PRESETS = {
  none: null,
  fade: () => ({ from: { opacity: 0 }, to: { opacity: 1 } }),
  fadeUp: () => ({ from: { opacity: 0, transform: 'translateY(12px)' }, to: SHOWN }),
  fadeDown: () => ({ from: { opacity: 0, transform: 'translateY(-12px)' }, to: SHOWN }),
  slideLeft: ({ box, stage }) => ({
    from: { transform: `translateX(${Math.round(stage.width - box.x)}px)` },
    to: { transform: 'none' },
  }),
  slideRight: ({ box }) => ({
    from: { transform: `translateX(${-Math.round(box.x + box.w)}px)` },
    to: { transform: 'none' },
  }),
  wipe: () => ({ from: { 'clip-path': 'inset(0 100% 0 0)' }, to: { 'clip-path': 'inset(0 0 0 0)' } }),
  zoomIn: () => ({ from: { opacity: 0, transform: 'scale(0.9)' }, to: SHOWN }),
  kenburns: () => ({ from: { transform: 'scale(1.08)' }, to: { transform: 'none' }, easing: 'linear' }),
  pulse: null, // special-cased in keyframesFor
};

const CANONICAL = Object.fromEntries(Object.keys(PRESETS).map((k) => [k.toLowerCase(), k]));

export const PRESET_NAMES = Object.keys(PRESETS);

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Parses `preset[@delay][/duration]`, e.g. `fadeUp@0.4`, `wipe@1/0.8`, `kenburns`.
 * Seconds may carry an `s` suffix. Returns null when empty or the preset is unknown.
 */
export function parseMotion(str) {
  if (!str) return null;
  const m = /^\s*([a-z]+)\s*(?:@\s*(\d*\.?\d+)\s*s?)?\s*(?:\/\s*(\d*\.?\d+)\s*s?)?\s*$/i.exec(str);
  if (!m) return null;
  const preset = CANONICAL[m[1].toLowerCase()];
  if (!preset) return null;
  return {
    preset,
    delay: m[2] === undefined ? undefined : Number(m[2]),
    duration: m[3] === undefined ? undefined : Number(m[3]),
  };
}

/** Timeline length and plays, capped so duration x loops never exceeds 30 s. */
export function timing(duration, loops) {
  const d = clamp(Number(duration) || DEFAULT_DURATION, 0.5, MAX_DURATION);
  let l = clamp(Math.round(Number(loops) || 1), 1, MAX_LOOPS);
  while (l > 1 && d * l > MAX_DURATION) l -= 1;
  return { duration: d, loops: l };
}

export const isStatic = (l) => /^(static|background|bg)\b/i.test(l.name);
export const isHero = (l) => /^hero\b/i.test(l.name);
export const isCta = (l) => /^cta\b/i.test(l.name);

export function isFullBleed(box, stage) {
  return box.x <= 1 && box.y <= 1
    && box.x + box.w >= stage.width - 1 && box.y + box.h >= stage.height - 1;
}

const readingOrder = (a, b) => (a.box.y - b.box.y) || (a.box.x - b.box.x);

/**
 * Fills in motion for layers that have none: background/static visible at t=0, `hero` kenburns
 * (fade if not full-bleed), other elements fadeUp (text) or fade (images) in reading order
 * STEP apart, `cta` last with pulse. Explicit motion is kept; its missing delay/duration resolved.
 * Mutates and returns the layers.
 */
export function assignMotion(layers, { stage, duration }) {
  let t = STEP;
  layers
    .filter((l) => !l.motion && !isStatic(l) && !isHero(l) && !isCta(l))
    .sort(readingOrder)
    .forEach((l) => {
      l.motion = { preset: l.kind === 'text' ? 'fadeUp' : 'fade', delay: t, duration: ENTRY };
      t += STEP;
    });
  layers.filter((l) => !l.motion && isCta(l)).sort(readingOrder).forEach((l) => {
    l.motion = { preset: 'pulse', delay: t, duration: PULSE };
    t += STEP;
  });
  layers.forEach((l) => {
    if (!l.motion && isHero(l)) {
      l.motion = isFullBleed(l.box, stage)
        ? { preset: 'kenburns', delay: 0, duration }
        : { preset: 'fade', delay: 0, duration: ENTRY };
    }
    if (!l.motion) l.motion = { preset: 'none', delay: 0, duration: 0 };
    const m = l.motion;
    if (m.delay === undefined) m.delay = 0;
    if (m.duration === undefined) {
      if (m.preset === 'kenburns') m.duration = duration - m.delay;
      else if (m.preset === 'pulse') m.duration = PULSE;
      else m.duration = ENTRY;
    }
    // keep every motion inside the timeline, ending at the designed state
    m.duration = clamp(m.duration, 0, duration);
    m.delay = clamp(m.delay, 0, duration - m.duration);
  });
  return layers;
}

const pct = (n) => Number((n * 100).toFixed(3));

/**
 * Keyframes for one layer over the whole timeline: [{ offset (0..1), props, easing? }].
 * Returns [] for `none` (no animation). The last frame is always the designed state.
 */
export function keyframesFor(motion, { box, stage, duration }) {
  if (!motion || motion.preset === 'none' || !motion.duration) return [];
  const a = motion.delay / duration;
  const b = Math.min(1, (motion.delay + motion.duration) / duration);
  const at = (f) => a + (b - a) * f;
  let frames;
  if (motion.preset === 'pulse') {
    frames = [
      { offset: a, props: { opacity: 0, transform: 'none' }, easing: 'ease-out' },
      { offset: at(0.4), props: { opacity: 1, transform: 'scale(1)' }, easing: 'ease-in-out' },
      { offset: at(0.7), props: { opacity: 1, transform: 'scale(1.05)' }, easing: 'ease-in-out' },
      { offset: b, props: { opacity: 1, transform: 'scale(1)' } },
    ];
  } else {
    const p = PRESETS[motion.preset]({ box, stage });
    frames = [
      { offset: a, props: p.from, easing: p.easing || 'ease-out' },
      { offset: b, props: p.to },
    ];
  }
  if (a > 0) frames.unshift({ offset: 0, props: frames[0].props });
  if (b < 1) frames.push({ offset: 1, props: frames[frames.length - 1].props });
  return frames;
}

/** Serialises frames to a `@keyframes` rule. Values come only from PRESETS and numbers. */
export function keyframesCss(name, frames) {
  const body = frames.map(({ offset, props, easing }) => {
    const decls = Object.entries(props).map(([k, v]) => `${k}:${v}`);
    if (easing) decls.push(`animation-timing-function:${easing}`);
    return `${pct(offset)}%{${decls.join(';')}}`;
  }).join('');
  return `@keyframes ${name}{${body}}`;
}
