# `.assets/` — generated README assets

Everything the README renders that is not markdown. Single dot-folder at the repo root, referenced
from `README.md` with relative paths (`./.assets/...`).

| File | What it is | How it was made |
| --- | --- | --- |
| `banner.png` | 2400×800 README header | HTML/CSS → Playwright, 2× DPR, `pngquant`-compressed to 192 KB |
| `banner-prompt.md` | the AI photo-banner prompt + composite recipe | written by hand |
| `layers.html` | **interactive** diagram — rotates on its own, click to hold | pure-CSS rotation + a small JS override |
| `layers.gif` | 760×392, 20 frames, 6.3 s loop. What the README shows | re-shoot the 4 states, blend, quantise to 48 colours |
| `layers.webp` | same animation, lossy WebP. Smaller than the GIF on the wire | same frames, `quality=82` |
| `layers.png` | static frame, default state (layer 1) | `layers.html` → Playwright 2× |
| `layers-jev.png` | static frame with layer 3 selected | `layers.html` → Playwright 2× |

## Why a dot-folder

It keeps generated binaries out of the way of the authored tree, it is one obvious place to look when
a README image 404s, and it survives `docs/` being reorganised. The leading dot also stops it
colliding with the common `assets/` convention that other tooling auto-generates into.

**It must stay tracked in git** — a README banner that is not committed renders as a broken image.

## Regenerating

### The diagram

`layers.html` is the source of truth. The two PNGs are screenshots of it, so re-shoot after any edit:

```bash
# add a fourth state by clicking the node you want before screenshotting
python3 - <<'PY'
from playwright.sync_api import sync_playwright
import pathlib
src = pathlib.Path(".assets/layers.html").resolve().as_uri()
out = pathlib.Path(".assets")
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 940, "height": 600}, device_scale_factor=2)
    pg.goto(src); pg.wait_for_timeout(300)
    pg.screenshot(path=str(out / "layers.png"), full_page=True)
    pg.click('.node[data-i="2"]'); pg.wait_for_timeout(250)
    pg.screenshot(path=str(out / "layers-jev.png"), full_page=True)
    b.close()
PY
pngquant --quality=85-100 --strip --force --output .assets/layers.png .assets/layers.png
```

### The banner

Currently HTML/CSS, rendered by the `readme-enhancer` skill's `generate_banner.py` with a brand
theme built from the product's own tokens (`--ink #0b0b0a`, `--hot #ff5a1f`). A **photographic**
banner is the intended upgrade — see `banner-prompt.md` for the prompt and the compositing recipe.

## Colour tokens

Taken from `web/src/styles.css` `:root`, so the assets and the product cannot drift apart.

| Token | Hex | Role |
| --- | --- | --- |
| `--bg` | `#ebe9e4` | diagram background |
| `--paper` | `#faf9f6` | card / chart surface |
| `--ink` | `#0b0b0a` | text, banner background |
| `--hot` | `#ff5a1f` | the single accent |
