# Logo files

This folder holds the **BE RELAX logo**. Nothing else belongs in here.

Both files are your own original artwork, renamed so the website can find them.
Nothing inside the images has been edited.

## The two files

| File | Version | Where it appears on the site |
|---|---|---|
| `be-relax-logo.jpg` | Black artwork on a white background | The **header** at the top of every page, and the small **icon in the browser tab** (favicon) |
| `be-relax-logo-white.jpg` | White artwork on a black background | The **dark footer** at the bottom of the page |

## How the page displays them

The two JPEGs have a flat background baked into them, because JPEG cannot store
transparency. Rather than editing your artwork to remove it, the page works
around it in its own styling:

- A **wrapper element crops the view down to the artwork's own bounding box**, so
  the surrounding empty margin of the JPEG is not shown.
- **CSS `mix-blend-mode`** hides the flat background — `multiply` in the light
  header (the white drops away) and `screen` in the dark footer (the black drops
  away).

Both effects live in `index.html` and act only on how the picture is *displayed*.
**The image files themselves are never altered** — they stay exactly as you
supplied them.

## Do not alter the artwork

The logo is used exactly as supplied. Please do **not**:

- recolour it — only the two versions above are used, black and white
- crop it, or cut off any part of the butterfly or the wordmark
- redraw, trace, "clean up" or re-export it
- stretch or squash it — width and height always scale together
- add shadows, outlines, glows or gradients

## If you ever replace the logo

Keep **the same two filenames**:

```
be-relax-logo.jpg
be-relax-logo-white.jpg
```

The page points at those exact paths. Upload a file under any other name and the
page will not find it — it will quietly fall back to the plain text wordmark
instead. Rename your new file on your computer *before* uploading it.

Names are case-sensitive and must stay all lowercase with hyphens:
`Be-Relax-Logo.JPG` and `be relax logo.jpg` will **not** work.

> **Note:** if you replace the artwork with a differently shaped image, the crop
> and blend settings in `index.html` were measured for the current files and will
> need adjusting to suit the new one.
