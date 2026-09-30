# AI photo banner — prompt + composite recipe

The current `banner.png` is HTML/CSS, which is crisp and tiny but is not a *photo*. This is the
prompt for the photographic upgrade, plus how to composite the type on top so the image never has to
render text itself.

## Rules before you generate

1. **Ask for no text.** Every image model garbles lettering. The banner carries a title; that title
   is added afterwards in HTML/CSS where it is crisp, selectable and translatable.
2. **3:1, and oversample.** Prompt for the widest aspect your model allows, render at ≥1792 px wide,
   then downscale to 2400×800. Upscaling a 3:1 crop loses the grain.
3. **Leave the left ~45 % quiet.** The title goes there. A busy left third makes text unreadable and
   you will be tempted to add a scrim that flattens the whole image.
4. **Match the product's palette** or the banner will look like a stock photo stapled to a repo:
   warm off-white `#ebe9e4`, near-black `#0b0b0a`, one hot orange `#ff5a1f`, nothing else.

---

## Prompt A — precision instruments *(recommended)*

The strongest fit. Measurement and evidence, shot as a physical craft rather than a hologram.

```text
Editorial macro photograph of precision measuring instruments laid out on warm
off-white paper: a machinist's steel rule, a brass vernier caliper, a loupe, and
a small orange anodised aluminium gauge, arranged with strict Swiss-grid spacing
on a seamless bone-white surface. Hard raking side light from the left, long soft
shadows falling right, shallow depth of field with the caliper jaws in crisp focus
and the far edge of the rule falling gently out of focus. Warm neutral palette:
bone, graphite, brushed steel, and a single hot orange accent on one small part.
Subtle paper tooth and fine machining marks visible. Shot on a large format camera,
f/8, editorial product photography, calm and precise, no drama.

Composition: subject occupies the right third to right half of the frame. The left
45 percent is empty, evenly lit, uncluttered negative space. Wide cinematic banner,
3:1 aspect ratio, viewed slightly from above.
```

**Negative prompt** (SDXL / Flux / Stable Diffusion):

```text
text, letters, words, numbers, logo, watermark, signature, ui, hud, hologram,
neon, blue glow, purple glow, lens flare, bokeh balls, chromatic aberration,
cyberpunk, sci-fi, 3d render, cgi, plastic sheen, cluttered background, busy
left side, hands, people, faces, cluttered, messy, tilted, low contrast, blurry
```

## Prompt B — site topology

If you would rather signal "crawl" than "measure".

```text
Aerial top-down photograph of a physical relief map of a street grid, cast in
matte bone-white plaster on a warm off-white table, with a single arterial route
traced through it in hot orange enamel and raised slightly above the surface.
Soft overhead light with one low raking angle to throw long delicate shadows
along the street edges, revealing the grid as a genuine three-dimensional
topography. Minimal, architectural, museum-model aesthetic. Warm neutral palette,
no colour other than the single orange route and graphite shadow.

Composition: the traced route enters from the lower right and dissipates toward
the upper right. The entire left 45 percent is plain untraced plaster, evenly lit,
completely empty. Wide cinematic banner, 3:1 aspect ratio.
```

## Prompt C — the honest dashboard

The most literal option, and the easiest to get wrong. Only use it if you want the banner to show
the product rather than its values.

```text
Overhead photograph of a printed analytics report on warm off-white paper, the
kind that would come out of a laser printer: dense small tables of figures, a
handful of bar charts in grey, and a single bar highlighted in hot orange. The
paper is slightly rotated and not perfectly aligned, as if laid down by hand. Soft
diffuse overhead light, faint paper texture, one subtle shadow along the top edge
for depth. The typography is illegible abstract texture, not readable words.

Composition: the report occupies the right half, cropped by the frame edge. The
left 45 percent is blank paper. Wide cinematic banner, 3:1 aspect ratio.
```

Note the explicit "illegible abstract texture" line. Without it you will get pseudo-text, which is
the single most common tell of an AI-generated banner.

---

## Engine-specific parameters

| Engine | Append |
| --- | --- |
| Midjourney | `--ar 3:1 --style raw --stylize 150 --no text, letters, neon, 3d render` |
| DALL·E 3 | put the aspect and negative requirements in prose; it has no negative-prompt field |
| Flux.1 / SDXL | use the negative prompt above; 1792×896, steps 30–40, CFG 3.5–4.5 for Flux |
| Ideogram | `--ar 3:1 --style realistic`; best in class at honouring "no text" |
| Recraft / V0 | set size explicitly to 3:1 and style to "photographic" |

Generate four to eight, pick on **composition** first (is the left third actually empty?) and palette
second. Do not pick on detail sharpness.

---

## Compositing recipe

The photo is the plate; the type is HTML. Do not ask the model for the title.

1. Save the chosen image as `.assets/banner-photo.png`.
2. Load it as a background, scaled to cover, at 1200×400.
3. Add a scrim so the type holds. Because the product is a light warm design, use a **left-weighted
   dark gradient**, not a flat overlay — it keeps the right side of the photo readable:

   ```css
   background:
     linear-gradient(100deg, #0b0b0af2 0%, #0b0b0ac2 38%, #0b0b0a1a 68%, #0b0b0a00 100%),
     url("./banner-photo.png") center / cover;
   ```

4. Set the title in the product's key: 44–48 px, weight 800, `#faf9f6`, `letter-spacing: -0.5px`,
   positioned in the left 45 %. The `--hot` accent can carry one word or the badge dot.
5. Render at `device_scale_factor=2`, then `pngquant --quality=82-98 --strip` — a photographic
   banner needs a higher quality floor than the flat-colour one (192 KB is achievable at 2400×800).
6. Check it at 400 px wide, not just full size. Most people see a README in a narrow column, and a
   banner that only works at 1200 px is decoration.

## Rejected directions

Kept here so the next person does not retry them:

- **Glowing neural network / brain / synapse** — says "AI" while saying nothing about measurement,
  and every competitor's banner looks the same.
- **Holographic dashboard UI floating in space** — the product's whole argument is that the model
  does not write the findings. A floating fake-UI banner contradicts it.
- **Blue/purple neon gradient** — the default of every AI banner generator, and it is not this
  product's colour.
- **Rocket / growth chart going up and to the right** — the product publishes a "needs a human" pile
  and refuses to invent a search volume. A growth-at-all-costs image is tonally dishonest here.
