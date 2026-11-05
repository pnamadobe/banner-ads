# banner-ads

An Edge Delivery Services site that renders **animated HTML5 banner ads** and packages them for
**Google Campaign Manager 360 (CM360)**. It is the site half of the
[idapi-banner-auto](https://github.com/pnamadobe/idapi-banner-auto) pipeline: the AEM Assets View extension
renders an InDesign template with the InDesign API, writes one ad page per size and a variations sheet into
Document Authoring (DA), and this repo's code turns those pages into live, animated ads.

How the whole pipeline works (the INDD export, the EDS pages, variations and packaging) is in
[HTML5-HOW-IT-WORKS.md](https://github.com/pnamadobe/idapi-banner-auto/blob/main/docs/HTML5-HOW-IT-WORKS.md).
One-time setup for your own copy of this site is in
[HTML5-SETUP.md](https://github.com/pnamadobe/idapi-banner-auto/blob/main/docs/HTML5-SETUP.md).

## Environments

- Preview: https://main--banner-ads--pnamadobe.aem.page/
- Live: https://main--banner-ads--pnamadobe.aem.live/

## What is in this repo

| Path | What it does |
|---|---|
| `blocks/ad/ad.js`, `ad.css` | The `ad` block: reads the layer table, binds `{label}` cells to a variations row, lays out the stage and fits text |
| `blocks/ad/ad-motion.js` | Motion presets, default motion assignment, timeline timing and keyframes |
| `tools/package/run.mjs`, `lib.mjs` | The CM360 packager (zip, budget ladder, GIF preview, storyboard, fidelity check, CM360 checks) |
| `.github/workflows/package.yml` | Runs the packager on a `package` repository_dispatch from the AEM extension |
| `test/` | Unit tests for the block and the packager (`node --test`) |

## The `ad` block

Each ad page has one `ad` block. The extension writes it; authors can edit motion in DA afterwards.

```
| ad       |        |            |               |                                       |
| size     | 300x250| duration 6 | loops 1       | rows /ads/<template>/<campaign>/variations.json |
| static-0 | image  | <url>      | 0,0,300,250   | none                                  |
| hero     | image  | {hero}     | 0,0,300,250   | kenburns · focus:50,30                |
| headline | text   | {headline} | 16,150,268,48 | fadeUp@0.4 · Sans Bold 22/24 #fff     |
```

- **Config row:** `size WxH`, `duration N` (seconds), `loops N`, `rows <sheet path>`, optional `clickthrough`.
  Duration × loops is capped at 30 s (at most 3 loops).
- **Layer rows** are drawn bottom to top: name | kind (`image` or `text`) | source | box `x,y,w,h` (px) |
  motion, optionally followed by `·` and style | style (optional 6th cell).
- **`{label}`** binds to the sheet column of that name. `?v=<outputFileName>` picks the variations row.
- **`?export=cm360`** adds the `ad.size` meta and `clickTag` the packager needs.
- `window.adTimeline` exposes `{ duration, loops, total, ready, seek(t), play(), restart() }`; the packager uses
  `seek` to capture frames.

### Motion

A motion cell is `preset[@delay][/duration]`, for example `fadeUp@0.4`, `wipe@1/0.8` or `kenburns`. Seconds can
carry an `s`. Presets:

`none`, `fade`, `fadeUp`, `fadeDown`, `slideLeft`, `slideRight`, `wipe`, `zoomIn`, `kenburns`, `pulse`

Layers without motion get a default: `static`/`background` slices stay still; a full-bleed `hero` gets
`kenburns` for the whole timeline (a smaller hero fades in); other layers enter in reading order, text with
`fadeUp` and images with `fade` (0.5 s each, 0.3 s apart); a `cta` then gets `pulse`.

## The CM360 packager

`package.yml` runs `node tools/package/run.mjs payload.json` on Ubuntu with Node 24 and Playwright (installed
in CI only). The payload comes from the extension's **Package for CM360** button and holds the ad list and a
short-lived writeback token; it is written to a file and never logged. For each ad the packager:

1. Opens the ad page with `?export=cm360`.
2. Builds a zip (`index.html` plus assets, with `clickTag`) and tries image scale/quality steps until it fits
   the size budget (going over is a warning).
3. Renders the zip offline to make a GIF preview, a storyboard and a fidelity score against the InDesign backup
   JPG, and runs the CM360 checks (zip ≤ 10 MB, ≤ 100 files, and so on).
4. Uploads everything through the extension's `html5-writeback` action, which writes to the job's
   `output/html5/cm360` folder in AEM. This repo holds no AEM credentials.

`PACKAGE_CONCURRENCY` (default 3) sets how many ads render at once.

This repo needs no secrets. The extension's GitHub token (set in the extension's deployment, not here) must be
allowed to send `repository_dispatch` to this repo.

## Local development

```sh
npm i
npm test          # block and packager unit tests
npm run lint
```

1. Add the [AEM Code Sync GitHub App](https://github.com/apps/aem-code-sync) to the repository.
2. Install the [AEM CLI](https://github.com/adobe/helix-cli): `npm install -g @adobe/aem-cli`.
3. Run `aem up` (opens `http://localhost:3000`) and open an ad page, e.g. `/ads/<template>/<campaign>/<page>?v=<row>`.

To try the packager locally, install Playwright without saving it (`npm install --no-save playwright@1 &&
npx playwright install chromium`) and run `node tools/package/run.mjs payload.json` with a payload from a real
job. It needs a valid writeback URL and token.

See [aem.live docs](https://www.aem.live/docs/) for general EDS development.
