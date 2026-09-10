# Video clips

The two short clips shown in the **Step Inside** section of the website.

## The two files

| File | Length | Size | Shape |
|---|---|---|---|
| `spa-tour-01.mp4` | about 17 seconds | ~3.3 MB | Portrait 9:16 (576 × 1024) |
| `spa-tour-02.mp4` | about 17 seconds | ~3.5 MB | Portrait 9:16 (576 × 1024) |

Both are **portrait** clips — the tall shape you get filming with a phone held
upright, the same shape as an Instagram Reel or TikTok.

## How they appear on the page

The two clips sit **side by side as vertical reels**, each in a tall 9:16 frame,
with normal play, pause and volume controls. They load muted, so nothing starts
making noise on its own — a visitor turns the sound on if they want it.

On a phone the two reels stack into a single column, one above the other.

Because the frames are 9:16, **portrait footage fits perfectly**. A landscape
(wide) clip will still play, but it gets cropped hard down the sides to fill the
tall frame, so film upright wherever possible.

## Replacing a clip

Upload the new file under **the same filename** — `spa-tour-01.mp4` or
`spa-tour-02.mp4` — and it takes the old one's place. Any other name and the page
will not find it; the frame stays dark.

## File size limits on GitHub

GitHub, where this website is stored, enforces hard limits on any single file:

- **Over 50 MB** — GitHub shows a warning.
- **Over 100 MB** — GitHub **blocks the upload completely.** It simply will not
  go through.

This catches people out with video more than anything else. A few minutes of
phone footage is easily 300 MB or more, so it must be compressed before you
upload it. Large videos also make the site slow for visitors on mobile data — the
two clips here are around 3.5 MB each, which is a good target to aim for.

## Compressing a clip for the web

If you have [ffmpeg](https://ffmpeg.org/download.html) installed, this one command
turns almost any recording into a web-friendly portrait clip. Replace
`input.mp4` with the name of your original file:

```bash
ffmpeg -i input.mp4 \
  -vf "scale=720:-2" \
  -c:v libx264 -preset slow -crf 26 \
  -profile:v high -pix_fmt yuv420p \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  spa-tour-01.mp4
```

What the settings do:

- `scale=720:-2` — resizes to 720px wide, working out the height automatically so
  the clip keeps its original shape.
- `-crf 26` — the quality dial. **Lower means better quality and a bigger file.**
  Try `23` if the result looks soft, or `30` if the file is still too large.
- `-movflags +faststart` — lets the clip start playing before it has fully
  downloaded.
- `-c:v libx264` / `-c:a aac` — the video and audio formats every browser can play.

Keep clips short. Ten to thirty seconds holds attention and keeps the file small.

## Adding a third clip

The section is built for these two. To show a third, upload it here and add one
more `<div class="reel"> … </div>` block in the `<!-- ============ VIDEO
============ -->` section of `index.html`, copying the two already there. A file
uploaded without that edit will sit in the folder unused.
