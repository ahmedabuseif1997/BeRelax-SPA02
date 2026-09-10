# Promotional video

The short video clip that plays in the video section of the website.

## What to upload

| File name | What it is | Required? |
|---|---|---|
| `spa-tour.mp4` | The main promotional clip — a tour of the spa | Yes |
| `spa-tour-poster.jpg` | A single still frame, shown before the video starts playing | Optional but recommended |

Names must match exactly (lowercase, hyphens).

## Video specifications

| Setting | Value |
|---|---|
| Format | MP4 |
| Video codec | **H.264** |
| Audio codec | **AAC** |
| Resolution | 1920 x 1080 (Full HD) or higher |
| File size | Ideally **under 25MB** |
| Length | 30–90 seconds works best |

The poster image should be a JPG at the same shape as the video (1920 x 1080).
If you do not upload one, the browser shows a plain dark frame until playback
starts.

## Important: file size limits on GitHub

GitHub, where this website is stored, has hard limits:

- **Over 50MB** — GitHub shows a warning.
- **Over 100MB** — GitHub **blocks the upload completely**. It will not work.

A phone-recorded 4K video of two or three minutes is easily 300MB or more, so it
will be rejected. Large videos also make the website slow for visitors on mobile
data.

You have two options:

1. **Compress the video first** (see the command below), or
2. **Host it on YouTube or Vimeo** and embed it instead (see the last section).

## Compressing a large video

If you have [ffmpeg](https://ffmpeg.org/download.html) installed, this one command
converts almost any video into a web-friendly 1080p MP4. Replace `input.mp4` with
the name of your original file:

```bash
ffmpeg -i input.mp4 \
  -vf "scale=-2:1080" \
  -c:v libx264 -preset slow -crf 26 \
  -profile:v high -pix_fmt yuv420p \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  spa-tour.mp4
```

What the settings do:

- `scale=-2:1080` — resizes down to 1080p, keeping the original shape.
- `-crf 26` — quality level. **Lower = better quality and bigger file.** Try `23`
  if the result looks soft, or `30` if the file is still too large.
- `-movflags +faststart` — lets the video start playing before it has fully
  downloaded.

To grab a poster image from one second into the video:

```bash
ffmpeg -i spa-tour.mp4 -ss 00:00:01 -vframes 1 -q:v 3 spa-tour-poster.jpg
```

## Using YouTube instead

If the video is too large or too long to compress, upload it to YouTube or Vimeo,
then in `index.html` replace the whole `<video>...</video>` block with an iframe
such as `<iframe src="https://www.youtube.com/embed/VIDEO_ID" title="BE RELAX"
allowfullscreen></iframe>` — where `VIDEO_ID` is the code at the end of your
YouTube link.
