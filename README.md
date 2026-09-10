# BE RELAX — Massage Center and Spa

Website for **BE RELAX**, a massage centre and spa in Dubai, UAE.

The site is currently a **single-file HTML sample**: everything — layout, styling
and the illustrated placeholder artwork — lives inside `index.html`. There is no
build step, no framework and nothing to install. Open the file and it works.

---

## Preview the site

**The simple way:** double-click `index.html` and it opens in your browser.

**The slightly better way** (recommended, because it behaves exactly like the live
site) — run this from the project folder, then visit <http://localhost:8000>:

```bash
python3 -m http.server 8000
```

Press `Ctrl + C` in the terminal to stop it.

---

## Folder layout

```
BeRelax-SPA02/
├── index.html            The entire website — layout, styles and text
├── README.md             This file
└── assets/
    ├── logo/             The BE RELAX logo (black + white versions)
    ├── photos/           Hero, About and gallery photography
    ├── team/             Therapist portraits for the Our Team section
    └── videos/           The promotional video clip
```

---

## Where to put your images and video

Each folder has its own short README with the exact file names, sizes and formats
to use. **The file names must match exactly** — the page looks for specific paths.

| Folder | What goes in it | Instructions |
|---|---|---|
| `assets/logo/` | `be-relax-logo.png`, `be-relax-logo-white.png`, `favicon.png` | [assets/logo/README.md](assets/logo/README.md) |
| `assets/photos/` | `hero.jpg`, `about-01.jpg`, `about-02.jpg`, `gallery-01.jpg`–`gallery-06.jpg` | [assets/photos/README.md](assets/photos/README.md) |
| `assets/team/` | `team-01.jpg` – `team-06.jpg` | [assets/team/README.md](assets/team/README.md) |
| `assets/videos/` | `spa-tour.mp4`, `spa-tour-poster.jpg` | [assets/videos/README.md](assets/videos/README.md) |

Nothing breaks while a folder is empty. Every image slot shows a soft mint
illustration until the real file is uploaded, then swaps over automatically.

---

## Editing the site content

All text lives in `index.html`. Open it in any text editor, use **Find**
(`Ctrl + F` / `Cmd + F`) to jump to what you want, change the words between the
tags, and save. The comment markers in capitals — like `<!-- ===== TEAM ===== -->` — mark the
start of each section.

> **Before going live:** the phone number, WhatsApp number, address and opening
> hours currently in the file are **placeholder values**. They are examples only
> and must all be replaced with the real BE RELAX details.

### Phone number

Search for `tel:`. The number appears twice on each link and both must match:

```html
<a href="tel:+971XXXXXXXXX">+971 XX XXX XXXX</a>
```

- The part after `tel:` is what the phone dials — digits only, no spaces, with the
  `+971` country code.
- The part between `>` and `</a>` is what visitors read — format it however you
  like.

### WhatsApp number

Search for `wa.me`. Use the full international number with **no** `+`, spaces or
dashes:

```html
<a href="https://wa.me/971XXXXXXXXX">
```

### Address

Search for `<!-- ===== CONTACT ===== -->` (or for the word `Dubai`) and replace the
placeholder address lines with the real street, area and emirate. If a Google Maps
link or embedded map is present, update that too so it points at the real
location.

### Opening hours

Search for the word `Opening` (hours appear in three places: the top bar, the Contact block and the footer). Edit the days and times in the
list. Remember to update them for Ramadan and public holidays.

### Services and prices

Search for `<!-- ===== SERVICES ===== -->`. Each treatment is one block containing a name, a
short description and a price. To change one, edit the text in place. To add
another, copy an existing block from `<` to the matching closing tag, paste it
directly below, and change the wording.

Keep prices in the same format throughout (for example `AED 250`) so the list
stays tidy.

### Team members

Search for `<!-- ===== TEAM ===== -->`. Each therapist has a name, a specialty and the
languages they speak. Edit that text here; the **photo** for each person comes
from `assets/team/` — see that folder's README.

---

## Colour palette

The whole site is themed with a light mint green palette, defined once at the top
of the `<style>` block in `index.html` as CSS custom properties. Change a value
there and it updates everywhere it is used.

| Variable | Hex | Typical use |
|---|---|---|
| `--mint-50` | `#F4FBF8` | Page background — the lightest tint |
| `--mint-100` | `#E9F7F0` | Alternating section backgrounds, cards |
| `--mint-200` | `#D3EFE3` | Borders, dividers, soft fills |
| `--mint-300` | `#B2E1CD` | Placeholder artwork, hover tints |
| `--mint-400` | `#84CFB3` | Icons, decorative details |
| `--mint-500` | `#57B896` | Primary accent — buttons, links |
| `--mint-600` | `#3E9D7C` | Button hover state |
| `--mint-700` | `#2F7C63` | Headings on light backgrounds |
| `--mint-800` | `#245F4D` | Strong text, deep accents |
| `--mint-900` | `#174236` | Footer background, darkest text |
| `--sand` | `#C6A46B` | Gold accent — highlights, prices, fine rules |

To adjust the theme, edit only these values rather than hunting for colours
throughout the file.

---

## Brand rules

- The logo is used **exactly as supplied**. Never recolour, crop, stretch or
  redraw it. Only two versions exist: black (for light backgrounds) and white
  (for the dark footer).
- The full name is **BE RELAX**, with the tagline **MASSAGE CENTER AND SPA**.
- Keep imagery calm and natural — stones, water, bamboo, leaves, orchids,
  candles, wood — so it sits comfortably with the mint palette.

---

## Pre-launch checklist

- [ ] Real logo files uploaded to `assets/logo/`
- [ ] Real phone number in every `tel:` link
- [ ] Real WhatsApp number in every `wa.me` link
- [ ] Real address, and map link pointing at the right place
- [ ] Real opening hours
- [ ] Real service names and prices
- [ ] Real team names, specialties and languages
- [ ] Team photos uploaded, with each person's consent
- [ ] Hero, About and gallery photos uploaded
- [ ] Video uploaded (compressed) or swapped for a YouTube embed
- [ ] Checked on a phone as well as a laptop
