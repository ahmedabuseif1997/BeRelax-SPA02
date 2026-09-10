# BE RELAX — Massage Center and Spa

The website for **BE RELAX Massage Center and Spa**, Abu Dhabi.

The whole site is a **single file**: `index.html`. Layout, styling, text and
animations all live inside it. There is no build step, no framework and nothing
to install — the only other things in the project are the pictures and video
clips in `assets/`.

---

## Preview the site

**The simple way:** double-click `index.html` and it opens in your browser.

**The better way** — this behaves exactly like the live site. Run this from the
project folder, then visit <http://localhost:8000>:

```bash
python3 -m http.server 8000
```

Press `Ctrl + C` in the terminal to stop it.

---

## Folder layout

```
BeRelax-SPA02/
├── index.html          The entire website — layout, styles, text and animations
├── README.md           This file
└── assets/
    ├── logo/           2 files   the BE RELAX logo, black and white versions
    ├── photos/         3 files   the spa photographs
    ├── team/          19 files   the therapist portraits
    └── videos/         2 files   the two vertical tour clips
```

Every folder has its own README explaining what is in it and how to replace a
file. Start at [`assets/README.md`](assets/README.md) for the full index.

---

## What's on the page

Top to bottom:

| Section | What it is |
|---|---|
| **Hero** | Headline, booking buttons and the candlelit pool photo, over an **animated waterfall** background — streams, droplets, mist and ripples drawn in CSS |
| **Trust strip** | Four short reassurances: licensed, expert therapists, hygiene, open late |
| **About** | "Rest is not a luxury" — the philosophy, a tick-list of what's included, and a photo |
| **Treatments** | Nine signature treatments, each with a description, duration and price |
| **Meet Our Therapists** | The 19 portraits, each captioned *Certified Therapist* |
| **Gallery** | The three spa photographs; clicking one opens it larger |
| **Step Inside** | The two portrait video clips, shown side by side as vertical reels |
| **What People Say** | Three five-star guest reviews |
| **Book Your Escape** | Address, phone numbers, opening hours, and a booking form |
| **Footer** | Logo, quick links, visiting details and social icons |

Small touches throughout: a sticky header, a gold scroll-progress bar at the very
top, sections that fade in as you scroll, hero figures that count up, a floating
WhatsApp button, and a mobile menu. The layout adapts to phones on its own.

The booking form does not email anyone — it **opens WhatsApp with the guest's
details already typed in**, ready to send to 052 510 8633.

---

## Contact details on the site

These appear in the top bar, the Contact section and the footer, and are already
correct:

| | |
|---|---|
| **Address** | 250 Al Meena Street, Al Zahiyah, E14, Abu Dhabi, United Arab Emirates |
| **Call or WhatsApp** | 052 510 8633 |
| **Mobile** | 056 342 9399 |
| **Landline** | 02 557 6533 |
| **Opening hours** | Every day, 10:00 – 23:00 |

There is **no email address** anywhere on the site — guests reach you by phone or
WhatsApp only.

If a number ever changes, open `index.html` and use **Find** (`Ctrl + F` /
`Cmd + F`) to search for the old number. Each phone link holds the number twice —
once in the `tel:` or `wa.me` part that actually dials, written with the `+971`
country code and no spaces, and once as the text visitors read. **Change both.**

---

## Editing the text

All wording lives in `index.html`. Open it in any text editor, use **Find** to
jump to the words you want, change the text between the tags, and save.

The capitalised comment markers show where each section starts:

```html
<!-- ============ TEAM ============ -->
```

---

## Colour palette

The whole site is themed from a set of colours defined once at the top of the
`<style>` block in `index.html`, in the two `:root` groups. Change a value there
and it updates everywhere that colour is used.

The palette is warm — cream, teak, candlelight gold, with a teal accent.

| Variable | Value | Used for |
|---|---|---|
| `--mint-50` | `#FBF6EF` | Page background, and form fields |
| `--mint-100` | `#F5EDE1` | Soft fills — icon tiles, note pills |
| `--mint-200` | `#EDE0CE` | Placeholder artwork, review avatar circles |
| `--mint-300` | `#DCC8AC` | Hairlines, ornaments, outline-button borders |
| `--mint-400` | `#C9AE8B` | Border of a form field you are typing in |
| `--mint-500` | `#5FB8AC` | Teal accent — tick marks, the bar across a treatment card |
| `--mint-600` | `#3E9A8E` | Teal accent — small captions, italic words in the headline |
| `--mint-700` | `#2A6E66` | Deep teal — prices, hero figures |
| `--mint-800` | `#2A2724` | Dark brown — nav links, the trust strip background |
| `--mint-900` | `#1B1A17` | Near-black — top bar, footer, video frames |
| `--ink` | `#26241F` | Body text |
| `--muted` | `#6E675D` | Secondary and intro text |
| `--line` | `#E6D8C4` | Borders and dividers |
| `--sand` | `#C08A43` | Gold accent, set on the review star row (the same gold as `--gold-1`) |
| `--oat` | `#F2E9DC` | Background of alternating sections |
| `--gold-1` | `#C08A43` | Gold — section ornaments, the review stars, the underline under the current menu link, the scroll-progress bar |
| `--gold-2` | `#F0C283` | Lighter gold, for the shine in gold gradients |
| `--gold-3` | `#A0703A` | Deeper gold — the small uppercase labels above headings |

> The `--mint-*` names are historical, from an earlier green version of the site.
> The names stayed; the values are the warm palette above.

Three more colours — `--clay`, `--ivory` and `--glass` — are defined in the same
block but are not currently used anywhere.

---

## Brand rules

- The logo is used **exactly as supplied** — never recoloured, cropped, redrawn
  or re-exported. See [`assets/logo/README.md`](assets/logo/README.md).
- The name is **BE RELAX**, with the line **Massage Center and Spa**.
- Keep imagery calm and natural — warm wood, water, candlelight, steam, stone,
  greenery — so it sits comfortably with the palette above.

---

## Before you go live

Two things on the page are still samples and need your real content:

- [ ] **The treatment prices.** The nine treatments in the Treatments section
      carry example rates (AED 120 – AED 450). Replace them with your real prices
      in `index.html`, and delete the grey note underneath that reads *"Sample
      pricing — replace with your real rates."*
- [ ] **The three guest reviews.** The names and quotes in the "What People Say"
      section are written examples, not real guests. Swap in three real Google
      reviews, and delete the grey note underneath that reads *"Sample reviews —
      swap in your real Google reviews before publishing."*

Everything else — the address, all three phone numbers, the opening hours, the
logo, the photographs, the portraits and the video clips — is real and in place.

Two smaller loose ends you may also want to settle: the **Instagram and Facebook
icons** in the footer do not yet point at your profiles, and the **booking form**
currently hands the guest's details to WhatsApp rather than to a booking system.

Worth doing either way: open the finished page on a phone as well as a laptop
before you share the link.
