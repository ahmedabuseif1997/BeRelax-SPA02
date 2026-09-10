# Team photos

The therapist portraits shown in the **Meet Our Therapists** section of the
website.

There are currently **19 photos** in this folder, `team-01.jpg` through
`team-19.jpg`, and the page shows all 19 in a grid. Each one is captioned with
the general title **"Certified Therapist"** — no individual names are published.

## Naming

Every photo follows the same pattern:

```
team-NN.jpg
```

Where `NN` is a two-digit number with a leading zero — `team-01.jpg`,
`team-07.jpg`, `team-19.jpg`. All lowercase, hyphen, `.jpg` extension.

`Team 1.JPG`, `team1.jpg` and `team-1.jpg` will **not** work. The page looks for
each exact filename, and if it does not find one it quietly shows a drawn
placeholder illustration in that slot instead.

## What makes a good photo

| Setting | Recommendation |
|---|---|
| Orientation | **Portrait** (taller than wide) — this suits the frame best |
| Format | JPG |
| Long edge | Around 1200–1600px is plenty |
| File size | Under about 500KB each |

**How the page crops them:** every portrait is cropped to a **3:4 frame**, and the
crop is **held near the top of the picture** so faces stay comfortably inside the
frame rather than being cut off at the forehead. A photo that is a different
shape still works — it is simply cropped to fit — but leave a little space around
the head and shoulders so nothing important sits at the very edge.

For a tidy, professional-looking grid, shoot everyone in the same spot, with the
same lighting and the same distance from the camera, so heads are roughly the
same size in every frame.

## Adding a twentieth photo

Two steps — the photo alone is not enough.

**1. Upload the photo** into this folder, named exactly:

```
team-20.jpg
```

**2. Add one more card** to `index.html`. Find the section marked:

```html
<!-- ============ TEAM ============ -->
```

Scroll to the last card in that section (the one pointing at `team-19.jpg`) and
paste this block directly below it, before the closing `</div>`:

```html
<div class="member">
  <div class="frame ph" data-src="assets/team/team-20.jpg"><img alt="BE RELAX therapist"><svg class="art"><use href="#a-portrait"/></svg></div>
  <span>Certified Therapist</span>
</div>
```

Save the file, refresh the page, and the new portrait appears. For a twenty-first
photo, repeat with `team-21.jpg`, and so on.

## Removing a photo

Also two steps:

1. **Delete the image file** from this folder.
2. **Delete that photo's card block** from the TEAM section of `index.html` — the
   whole `<div class="member"> … </div>` that names the file you removed.

If you delete only the file and leave the card in place, the grid keeps that slot
and shows a drawn placeholder illustration where the person used to be.

The remaining files do **not** need renumbering. A gap in the numbering is
harmless, because each card names its own file.

## Consent

Before publishing anyone's photo on the website, make sure that person has agreed
to it. Keep a simple written record of their permission — a signed note or a
saved message is enough — and remove a photo promptly if someone later asks you
to.
