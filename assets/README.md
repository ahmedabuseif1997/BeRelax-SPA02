# Website assets

Everything the BE RELAX website loads — the logo, the spa photographs, the
therapist portraits and the two video clips. All of it is already in place and
live on the page.

Each folder has its own short README with the detail for that folder: what the
files are, what to send if you replace one, and how to add or remove one.

## Folder structure

```
assets/
├── logo/      2 files   the BE RELAX logo, black and white versions
├── photos/    3 files   the spa photographs
├── team/     19 files   the therapist portraits
└── videos/    2 files   the two vertical tour clips
```

## Every file the site uses

| Folder | File | What it is | Where it appears |
|---|---|---|---|
| `logo/` | `be-relax-logo.jpg` | Black logo on white | Header at the top of every page, and the browser-tab icon |
| `logo/` | `be-relax-logo-white.jpg` | White logo on black | The dark footer |
| `photos/` | `spa-01.jpg` | Wide interior view | The full-width tile in the Gallery |
| `photos/` | `spa-02.jpg` | Candlelit pool | The hero image at the top of the page, and the Gallery |
| `photos/` | `spa-03.jpg` | Massage in progress | The About block, and the Gallery |
| `team/` | `team-01.jpg` … `team-19.jpg` | 19 therapist portraits | The "Meet Our Therapists" grid, each captioned *Certified Therapist* |
| `videos/` | `spa-tour-01.mp4` | Portrait clip, about 17 seconds | Left vertical reel in "Step Inside" |
| `videos/` | `spa-tour-02.mp4` | Portrait clip, about 17 seconds | Right vertical reel in "Step Inside" |

**26 files in total.** Each folder also contains an empty `.gitkeep` file — that
is a leftover marker, it is not used by the site, and you can ignore it.

## Upload straight from your browser

You do not need any software installed. Each link below opens GitHub's
drag-and-drop upload page for that folder:

| What you're uploading | Click here |
|---|---|
| Team photos | https://github.com/ahmedabuseif1997/BeRelax-SPA02/upload/claude/optimistic-goldberg-4f598r/assets/team |
| Videos | https://github.com/ahmedabuseif1997/BeRelax-SPA02/upload/claude/optimistic-goldberg-4f598r/assets/videos |
| Logo files | https://github.com/ahmedabuseif1997/BeRelax-SPA02/upload/claude/optimistic-goldberg-4f598r/assets/logo |
| Spa photos | https://github.com/ahmedabuseif1997/BeRelax-SPA02/upload/claude/optimistic-goldberg-4f598r/assets/photos |

### How to upload

1. **Open the link** for the folder you want, and sign in to GitHub if it asks.
2. **Drag your files** onto the page — or click *choose your files* and pick them.
   You can drop several at once.
3. **Scroll down** to the box at the bottom of the page.
4. Click the green **"Commit changes"** button.

Give it a minute, then refresh the website.

## Important: a new file only shows up if the name matches

The page asks for each file by its exact path. So a file you upload appears on
the site in one of two situations:

- **Its name matches a name in the table above**, in which case it replaces that
  file wherever it appears — no code change needed; or
- **`index.html` is edited** to point at the new name.

Upload a file under any other name and nothing changes on the page. The file just
sits in the folder, unused, and the original stays on screen.

Names are case-sensitive. Keep them all lowercase, hyphens instead of spaces,
leading zeros intact (`team-01.jpg`, not `Team 1.JPG`), and the right extension
(`.jpg`, `.mp4`). Rename files on your computer *before* you drag them in.

> [!CAUTION]
> **GitHub blocks any single file over 100MB**, and warns above 50MB. This bites
> with video most often. Compress a clip before uploading — `videos/README.md`
> has a ready-to-paste command.

## Keeping files small

Large files do not look any better on screen; they just make the page slow,
especially for visitors on mobile data.

- **Photos:** at most 2400px on the long edge, JPEG quality around 80. Aim for
  under 500KB each.
- **Portraits:** portrait orientation, around 1200–1600px on the long edge.
- **Video:** aim for a few megabytes per clip — the two current clips are about
  3.5MB each.
