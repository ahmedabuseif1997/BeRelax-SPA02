# Website assets

This folder holds **every image, video and logo file the website loads** — the
logo at the top of the page, the spa photographs, the therapist portraits and the
tour video.

You do not need to touch any code to add them. Every picture and video slot on the
page already shows a hand-drawn mint SVG placeholder, so the site looks complete
and polished even while it is empty. The moment you upload a real file with the
right name into the right folder, the page **swaps it in automatically** — no code
change, no developer, nothing to switch on.

That means you can upload your files a few at a time, in any order, and the site
keeps looking finished the whole way through.

## Folder structure

```
assets/
├── logo/      → the BE RELAX logo and the browser-tab icon
├── photos/    → hero image, About pictures, gallery
├── team/      → the six therapist portraits
└── videos/    → the spa tour video and its cover image
```

Each folder has its own README with more detail on what to shoot and how to
prepare it.

## Every file the site looks for

The names below are the **exact** names the website expects. Upload a file with a
different name and the page will simply carry on showing the placeholder.

| Folder | Filename | What it is | Recommended size |
|---|---|---|---|
| `assets/logo` | `be-relax-logo.png` | Black logo for the light header | Transparent PNG, min 600px wide |
| `assets/logo` | `be-relax-logo-white.png` | White logo for the dark footer | Transparent PNG, min 600px wide |
| `assets/logo` | `favicon.png` | Butterfly mark only, square | 512 × 512 |
| `assets/photos` | `hero.jpg` | Main hero image | Portrait 4:5 — 1600 × 2000 |
| `assets/photos` | `about-01.jpg` | About section, left frame | Portrait 3:4 — 1200 × 1600 |
| `assets/photos` | `about-02.jpg` | About section, right frame | Portrait 3:4 — 1200 × 1600 |
| `assets/photos` | `gallery-01.jpg` … `gallery-06.jpg` | The six gallery tiles | 1600 × 1200 or larger |
| `assets/team` | `team-01.jpg` … `team-06.jpg` | The six therapist portraits | Portrait 3:4 — 1200 × 1600 |
| `assets/videos` | `spa-tour.mp4` | The spa walkthrough video | 1080p H.264/AAC, under 25MB |
| `assets/videos` | `spa-tour-poster.jpg` | Still frame shown before the video plays | 1920 × 1080 |

That is **17 files in total** once everything is in place.

## Upload straight from your browser

You do not need any software installed. Each link below opens GitHub's
drag-and-drop upload page for that folder:

| What you're uploading | Click here |
|---|---|
| Team photos | https://github.com/ahmedabuseif1997/BeRelax-SPA02/upload/claude/optimistic-goldberg-4f598r/assets/team |
| Videos | https://github.com/ahmedabuseif1997/BeRelax-SPA02/upload/claude/optimistic-goldberg-4f598r/assets/videos |
| Logo files | https://github.com/ahmedabuseif1997/BeRelax-SPA02/upload/claude/optimistic-goldberg-4f598r/assets/logo |
| Spa & nature photos | https://github.com/ahmedabuseif1997/BeRelax-SPA02/upload/claude/optimistic-goldberg-4f598r/assets/photos |

### How to upload

1. **Open the link** for the folder you want (sign in to GitHub if it asks).
2. **Drag your files** onto the page — or click *choose your files* and pick them.
   You can drop several at once.
3. **Scroll down** to the box at the bottom of the page.
4. Click the green **"Commit changes"** button.

Give it a minute, then refresh the website — your files will be live.

> **Names must match the table above exactly.** All lowercase, hyphens instead of
> spaces, leading zeros kept (`team-01.jpg`, not `Team 1.JPG`), and the right
> extension (`.jpg`, `.png`, `.mp4`). If the name is even slightly different, the
> page keeps showing the placeholder. Rename files on your computer *before* you
> drag them in.

> [!CAUTION]
> **GitHub rejects any single file over 100MB.** The upload will fail outright —
> this catches people out with video most often. Compress the video first (see
> below, and `videos/README.md` for the exact command).

## File size tips

Big files do not look any better on a website — they just make it slow to load,
especially for visitors on mobile data. A few quick rules:

- **Compress JPGs to around 80% quality.** Most photo apps offer this under
  *Export* or *Save for web*. The difference is invisible on screen; the file is
  often 5–10× smaller.
- **Keep photos at most 2400px wide**, even if the original is 4K. A 4K photo
  straight from a camera can be 8–15MB — resized it is usually a few hundred KB.
- **Compress the video before uploading.** Aim for 1080p and under 25MB. A phone
  recording of a couple of minutes can easily be 300MB+, which GitHub will refuse.

A good target is **under 500KB per photo** and **under 25MB for the video**.
