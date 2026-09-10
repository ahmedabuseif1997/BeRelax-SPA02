# Photos

The main photography for the website: the large hero image, the two About
pictures, and the six gallery images.

Every slot shows a hand-drawn mint SVG scene until its file is uploaded, so the
page always looks complete. Add photos one at a time and each placeholder is
replaced as soon as the matching file appears.

## What to upload

| File name | Where it appears | Orientation | Aspect ratio |
|---|---|---|---|
| `hero.jpg` | The large image at the top of the page | Portrait | **4:5** |
| `about-01.jpg` | About section, first image | Portrait | **3:4** |
| `about-02.jpg` | About section, second image | Portrait | **3:4** |
| `gallery-01.jpg` … `gallery-06.jpg` | The six-image gallery | Mixed — see note | **any** |

The gallery is a mixed tile grid: two tiles are wide, one is tall, the rest are
square-ish. Every tile crops the image to fill its shape, so any orientation
works — just keep the subject roughly centred and supply at least 1600px on the
long edge. `gallery-01` is the tall tile; `gallery-02` and `gallery-06` are wide.

Names must be lowercase with hyphens and leading zeros — `gallery-01.jpg`, not
`Gallery1.JPG`.

## What the photos should show

Calm, natural, spa-like subjects. Think relaxation and natural materials:

- smooth stacked stones
- still or rippling water
- bamboo and green leaves
- orchids and white flowers
- lit candles
- warm wood and folded towels
- bath salts, oils and bowls

Keep the mood soft and airy so the photos sit well against the site's light mint
colours. Avoid busy backgrounds, harsh flash, visible clutter, and anything with
another business's branding in the frame.

## Image specifications

| Setting | Value |
|---|---|
| Format | JPG |
| Maximum width | **2400px** — even if your camera shot 4K, resize down |
| JPG quality | About **80** |
| File size | Aim for under 500KB per image |

A 4K photo straight from a camera can be 8–15MB. On a website that is wasted
weight: it will not look any better on screen, but it will make the page slow to
load, especially on a phone. Resizing to 2400px wide at quality 80 typically
brings the same photo down to a few hundred kilobytes with no visible difference.

Most photo apps can do this under **Export** or **Save for web**. If you have
ffmpeg or ImageMagick installed, this resizes and compresses one image:

```bash
# ImageMagick
magick input.jpg -resize 2400x2400\> -quality 80 hero.jpg
```

## Licensing

Only upload photos you own or have the right to use — photos taken at your own
spa, or stock images you have licensed. Do not save images from Google, Instagram
or another spa's website.
