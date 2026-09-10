# Spa photos

The three photographs of the centre used across the website.

## The three files

| File | What it shows | Where it appears on the page |
|---|---|---|
| `spa-01.jpg` | Wide interior view | The **full-width tile** at the top of the Gallery |
| `spa-02.jpg` | Candlelit pool | The **hero image** at the very top of the page, and again in the Gallery |
| `spa-03.jpg` | Massage in progress | The **About** block ("Rest is not a luxury"), and again in the Gallery |

Each photo is used at more than one size, and every frame crops the picture to
fit its own shape — so keep the main subject somewhere near the middle rather
than tight against an edge.

Clicking a gallery photo opens it larger in a lightbox.

## Replacing a photo

Upload the new picture under **the same filename** and it takes the old one's
place everywhere it appears. No code change needed.

If you upload under a different name, the page will not find it — it will show a
drawn placeholder illustration in that slot instead. Names are all lowercase with
a hyphen and a leading zero: `spa-01.jpg`, not `Spa 1.JPG`.

## What to send

| Setting | Value |
|---|---|
| Format | **JPEG** (`.jpg`) |
| Orientation | **Landscape** (wider than tall) — this suits the hero, About and gallery frames |
| Long edge | **At most 2400px** — resize down even if the camera shot 4K |
| Quality | About **80** |
| File size | Aim for under 500KB per photo |

A photo straight from a camera or phone can be 8–15MB. On a website that is
wasted weight — it will not look any better on screen, but it will make the page
slow to load, especially for visitors on mobile data. Resizing the long edge to
2400px at quality 80 typically brings the same photo down to a few hundred
kilobytes with no visible difference.

Most photo apps do this under **Export** or **Save for web**. If you have
ImageMagick installed, this resizes and compresses one image in place of the old
one:

```bash
magick input.jpg -resize 2400x2400\> -quality 80 spa-01.jpg
```

## What the photos should show

Calm, natural, spa-like subjects — warm wood, still water, candlelight, steam,
folded towels, stone, greenery. Keep the mood soft and low-lit so the pictures
sit comfortably with the site's warm cream and gold colours. Avoid harsh flash,
visible clutter, and anything carrying another business's branding.

## Licensing

Only upload photos you own or have the right to use — pictures taken at your own
centre, or stock images you have licensed. Do not save images from Google,
Instagram or another spa's website.

## Adding more photos

The Gallery currently holds these three. To add a fourth, upload it here (for
example `spa-04.jpg`) and add one matching tile to the `<!-- ============ GALLERY
============ -->` section of `index.html`, copying the shape of the tiles already
there. A photo uploaded without that edit will sit in the folder unused.
