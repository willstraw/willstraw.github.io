# CyberStarA3

Personal portfolio site (owner's initials "WB") for mechanical/CAD engineering work done in Fusion 360. It is a plain static site:
hand-written HTML, CSS and vanilla JS. There is no build step, no package.json, no framework and no tests. three.js 0.160.0 comes
from the jsDelivr CDN through an import map in each page that needs it.

## Working with the owner

- They preview with VS Code **Live Server**. Pages that fetch files (any `.bin` model) must be served over http and won't load from `file://`.
- **They commit and push themselves.** Don't commit unless asked. Commit messages are short and lowercase ("nav bar update", "phone updates").
- Performance and refactoring work must cause **no visible change** unless they asked for one.
- On long or unusual steps (local servers, headless browsers, pixel diffs), say what you're doing first and keep them updated.
- Code comments are plain English and explain *why*, in full sentences. Match that density and tone, with British spelling in prose ("colour", "optimisation", "centre").

## File map

| File | Role |
|---|---|
| `index.html` | Home. A 3D extruded "WELCOME" (Archivo Black) spinning in the viewer, then a Space Grotesk "Hi, I’m Will" intro in `<main id="content">` whose heading overlaps the bottom of the viewer. On desktop it is a **scroll drawing**: `.home-stage` (nav, `.viewer-band`, viewer, intro, `.sheet`) is pinned inside a 320vh `.home-scroll`, and the page's module script maps scroll progress to fading the UI, turning WELCOME front on (field of view 30° → 1°), then an ISO-style drawing sheet (zones, title block, parts list linking the pages, dimensions). The viewer canvas covers the whole stage and is told to fit the word into `.viewer-band`. Below the About Me sheet sit the Timeline (clickable events and projects with a picture panel), Projects (inline SVG sketches whose dimensions are held at 10px) and FAQ sheets, each filled from a `<template id="sheet-…">`. |
| `projects.html` + `projects.css` | Projects page: full-height hero with the MUR montage (`media/MUR_edit_16x9.mp4`, muted loop, paused off screen) behind the heading, then four portfolio tiles (Formula SAE, Rear Suspension, Tyre Model, Cyberstar) linking to their pages. The CSS still lays out a fifth and sixth tile. |
| `formula-sae.html`, `tyre-model.html`, `cyberstar.html` | Project pages: a picture across the top three fifths of the screen with the project's name over it, and room below for the write-up. |
| `rear-suspension.html` | 3D viewer of the VD26 rear suspension `.bin` across the top three fifths of the screen (with `viewer-fade`), opened from the Rear Suspension tile on Projects. Its nav marks Projects as the current page. |
| `cv.html` | The CV shown on the site: PDF.js 4.4.168 (jsDelivr) draws `media/cv.pdf` as a white sheet per page, with the PDF's links laid over it and a Download PDF link. Works on phones, where an embedded PDF often doesn't. Needs http (Live Server). Replacing `media/cv.pdf` is all an update needs. |
| `style.css` | Shared base styles and the blueprint-grid nav bar: "William Bartholomew" (`.nav-name`, plain text, not a link) on the left and the page links on the right, with a burger menu at ≤720px where the name is hidden and nav.js's "WB" shows instead. Defines `--nav-height` and `--name-inset` (the space before the name, which the Home heading also uses so the two line up). |
| `nav.js` | Burger toggle, plus it injects the mobile page title (from the `aria-current` link) and the "WB" home link. |
| `viewer.js` + `viewer.css` | Reusable Fusion-style 3D viewer (see below). |
| `model.js` | ES module for the compact `.bin` model format: `encodeModel`, `downloadModel`, `readModel`. |
| `tools/convert-model.html` | In-browser tool that turns a Fusion OBJ + MTL export into a `.bin`. Must be opened via Live Server. |
| `VD26_Rear_Suspension.bin` | Converted model (2.4 MB). The 64 MB source OBJ and its MTL were deleted (they're still in git history). Shown on `rear-suspension.html`. |
| `media/` | Pictures, sketches and the video. Photos are saved as web-sized JPEG copies (about 1200–2400px wide), not the camera originals. `cv.pdf` is the CV with the personal email and mobile taken out (a redacted copy of the owner's own PDF, not a re-export, so update it by redacting a new export again). |
| `fonts/` | `ArchivoBlack-Regular.ttf` and `SpaceGrotesk.ttf` (with OFL licences), loaded with `@font-face` in `projects.css` (Archivo) and `style.css` (Space Grotesk, shared with the Home intro). `texgyrebonum-{regular,bold}.otf` (GUST licence, files left unmodified) are declared in `style.css`. `archivo-black.js` holds the same Archivo glyphs pre-converted to three.js font JSON as `window.ARCHIVO_BLACK`, for the Home page's 3D text. |

## Conventions and gotchas

- **The nav markup is copied into every page.** Adding, renaming or reordering a link (or the name) means editing every HTML page (Home, Projects and the four project pages) and keeping
  `aria-current="page"` on the right one. The links are Home, Projects and CV (`cv.html`; the Home drawing's note 3 and CV box link there too, and note 3 pairs with the nav link by href, so keep their hrefs identical); `.nav-links` is a flex row with a gap, so any number of links fits. The CV page has the nav as well.
- **One breakpoint: `max-width: 720px`.** It's used in `style.css`, `viewer.css`, `projects.css`, the inline styles in `index.html`
  and the `staticOnPhones` media query in `viewer.js`. Keep them in step.
- Phone heights use a `vh` line followed by an `svh` override, for browsers without `svh`.
- Mobile hover: hover effects in `viewer.css` are wrapped in `@media (hover: hover)`. `projects.css` turns hover extras off at ≤720px instead.
- Performance patterns already in place (keep them): the renderer pixel ratio is capped at 1.5; the viewer and the Projects video stop
  while off screen (IntersectionObserver); hover effects only animate `transform`/`opacity`; tiles use `contain: layout paint`.
  Respect `prefers-reduced-motion` (see the end of `projects.css`).
- `projects.html` adds a `js` class to `<html>` early so tiles can start hidden and fade in. Without JS they just show.
- `viewer.js` is deliberately a **classic script** (not a module) that sets `window.createViewer`. Load it with `defer`, then call it
  from the page's `<script type="module">`.
- Fonts: nav links and tile titles use a Bookman font stack. Installed Bookmans come first, then the self-hosted "TeX Gyre Bonum" (a free Bookman copy), so phones get Bookman too. Keep Bonum in all three stacks (`style.css` ×2, `projects.css` ×1). The Projects hero `h1` uses Space Grotesk. The body uses Segoe UI/system-ui.

## The 3D viewer (`viewer.js`)

`createViewer(THREE, sectionEl, { load, staticOnPhones })` builds the canvas, a "Loading…" status, and a CSS 3D ViewCube with an XYZ
triad. It handles drag-to-rotate with inertia, wheel and pinch zoom, snapping to cube faces or Home, and an idle auto-spin. `load({ setStatus })`
must resolve to `{ model, radius, floorY, grid: { size, minor, major }, fit(vFovRad, aspect) → cameraDistance }`, with the model already
centred on the origin. It draws a fading grid with red X and green Y axes at `floorY`. Constants at the top of the file
(`AUTO_SPEED`, `HOME_TILT`, `HOME_TURN`, zoom limits) control the feel. `staticOnPhones: true` (used on Home) makes the viewer display-only
at ≤720px so swipes scroll the page. Add `class="viewer-fade"` to the section to fade its bottom into the page. Pages can override the
`#viewer` height inline, as `index.html` does.

`createViewer` also takes `wheelZoom: false` (Home uses it so the wheel scrolls the page) and returns an API for pages that steer
the view: `setFrame(rect)` fits the model into part of the canvas (via `camera.setViewOffset`), `setPose({ blend, x, y, fov })`
blends from the free view to a fixed one and pauses dragging while blended, `setGridOpacity(a)`, and `project(vector3)` for
screen positions. Pages that don't use them behave as before.

## CAD models: OBJ → `.bin` → page

1. Export OBJ + MTL from Fusion.
2. Open `tools/convert-model.html` via Live Server, pick both files (the edge angle defaults to 35°), and save the downloaded `.bin` beside the page.
3. Load it in a page's module script with `downloadModel(url, onProgress)` then `readModel(bytes)`. That returns
   `{ meshes: [{ color, geometry }], edges }`: one mesh per part colour, plus all the outline edges as one geometry.

The `.bin` layout is documented at the top of `model.js` (gzip, `MODL` magic, JSON header, delta + zigzag + byte-plane packed int32 blocks).
If you change the format, bump `VERSION` and re-convert every model.

The suspension used to be shown on `projects.html` until commit `bb9d91a` ("project page launch") replaced it with the tile grid. To reuse
the working page code (Z-up rotation, Fusion-like `MeshStandardMaterial` with `polygonOffset` under the edge lines, centring, grid sizing,
`fit`, and a `<link rel="preload" as="fetch" crossorigin>` for the `.bin`), run `git show 3442e5f:projects.html`. `rear-suspension.html` is that same code, and is the page to copy for any new model.

## Repo notes

- Remote: `github.com/willstraw/willstraw.github.io`, branch `main`. It's **public** and served by GitHub Pages at
  https://willstraw.github.io/, so every push to `main` goes live within a minute or two. `.nojekyll` stops Pages running Jekyll over the files.
- The repo started from a single clean commit, made with GitHub's noreply address so the owner's personal email isn't public.
  This repo's git config sets `user.email` to that noreply address; keep it that way. The earlier history (and the deleted 64 MB
  suspension OBJ, the Contact stub and the old Current Workbench board) is in the private `willstraw/CyberStarA3` repo.
- GitHub's servers are case-sensitive, unlike Windows and Live Server, so a path's capitals must match the file's exactly.
- Don't commit raw CAD exports (OBJ files are tens of MB). Only the `.bin` is needed at runtime, so convert, then keep the OBJ out of the repo.
- Everything in the repo is public, so nothing personal goes in it (the CV in `media/` has the personal email and mobile removed).
- Project write-ups go in a `<section class="writeup"><div class="writeup-body">` after the page's picture (shared
  styles in `style.css`); the Tyre Model page has the first one.
- Still to be filled in: the write-ups on the Formula SAE, Rear Suspension and Cyberstar pages, and the timeline text and pictures for the events still to
  come (the competition onwards; their buttons switch on by themselves once their date passes).
