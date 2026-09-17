# Attribution and the consent gate

Two files, plain ES5, no build step, no dependencies:

| File | What it is |
|---|---|
| `consent.js` | The PDPL consent gate (§11.3). It decides whether `attribution.js` ever loads. |
| `attribution.js` | The 90-day multi-touch store and the server beacon (§10.1–10.5). Loaded **only** by `consent.js`, and only after a granted consent. |

**Both are dormant as shipped.** Neither does anything — no banner, no
`localStorage`, no request, no change to the page — until
`window.BERELAX_ATTRIBUTION_API` is a non-empty string. The spa's API subdomain
does not exist yet, so that is exactly how they ship.

---

## 1. The snippet for `index.html`

Paste this immediately **before `</body>`**, after the site's existing
`<script>` block.

```html
<!-- ============ ATTRIBUTION + CONSENT · spec §10, §11.3 ============
     DORMANT AS PASTED. consent.js returns on its first statement while
     BERELAX_ATTRIBUTION_API is unset: no banner, no storage, no network,
     and the page behaves exactly as it does today.

     TO GO LIVE, uncomment exactly this one line:

         window.BERELAX_ATTRIBUTION_API = "https://api.berelax.ae/v1";

     To turn it all off again, comment it back. Nothing else changes.

     The API must be a SUBDOMAIN of this site's own domain (api.berelax.ae
     beside berelax.ae). On a different domain the durable cookie is
     third-party and Safari drops it — §10.5.
     ================================================================ -->
<script>
/* window.BERELAX_ATTRIBUTION_API = "https://api.berelax.ae/v1"; */

/* Optional, all with working defaults:
   window.BERELAX_PRIVACY_URL     = "privacy.html";  where the banner links
   window.BERELAX_PRIVACY_VERSION = "2026-01";       bump it to re-ask everyone
   window.BERELAX_ATTRIBUTION_SRC = "assets/js/attribution.js"; */
</script>
<script src="assets/js/consent.js" defer></script>
```

**The enabling line, exactly:**

```js
window.BERELAX_ATTRIBUTION_API = "https://api.berelax.ae/v1";
```

---

## 2. What goes live when that line is uncommented

**The visitor sees** a bottom sheet in the site's own palette — cream over a
`--line` hairline, Cormorant heading, Jost body, gold focus rings — headed
*"Before we count this visit"*, with two buttons: **Accept** and **Decline**.

They are the same element, the same class, the same size, weight and contrast.
There is no greyed-out refusal, nothing is pre-ticked, and declining is one
click. A dark-pattern banner is not valid consent under PDPL Art. 6, so both
answers share a single CSS class and cannot drift apart in a later edit.

Also on screen: an **Analytics choice** link in the footer's bottom bar, present
whatever the visitor chose, because consent must be as easy to withdraw as it
was to give. The WhatsApp floating button is lifted clear of the sheet while it
is open — a booking control must never sit behind an analytics banner.

Accessibility: real `<button>` elements, `role="dialog"` + `aria-modal`, labelled
and described by the heading and the body copy, focus moved into the sheet and
trapped there with Tab wrapping, focus returned to where it came from on close,
an `aria-live="polite"` region announcing the outcome, and visible focus rings.
**Escape closes the sheet but is neither consent nor refusal** — nothing is
stored, nothing loads, and the visitor is asked again next visit.

The banner respects `prefers-reduced-motion` (no slide-up) and
`prefers-color-scheme: dark` (it borrows the site's own dark surface, the
footer). Its CSS is injected by `consent.js`, not added to the stylesheet, so
removing the two script tags leaves no orphan rules behind.

**Never gated:** the booking form and every WhatsApp and call button. Those are
contract necessity, and holding a booking hostage to analytics would invalidate
the consent anyway. Declining costs the visitor nothing but the measurement.

---

## 3. What is stored

Only in this browser, only after **Accept** (except the consent record itself,
which is written on either answer because a refusal has to be remembered):

| Key | Written when | Contents |
|---|---|---|
| `berelax_consent` | On Accept or Decline | `granted\|2026-01` or `denied\|2026-01` — the answer and the privacy-notice version it was given against. A newer version re-asks. |
| `berelax_attr` | On Accept, then on each visit | The §10.1 store: `v`, `visitorId` (UUID v4), `first`, `last`, `touches` (capped at 10 — the oldest *middle* touches drop, first and most recent always survive), `createdAt`, `updatedAt`. The whole store expires 90 days after its **first** touch. |

A touch holds a timestamp, source, medium, the utm fields, `gclid`/`fbclid`, the
referrer **host** and the landing **path**. Never the full URL, never a name,
a number or anything typed into the form.

Every read and write is wrapped in `try`/`catch`: private mode throws on write,
blocked storage throws on read, and quota throws whenever it likes. The site
does not break because analytics did.

Choosing **Decline** later deletes `berelax_attr` immediately. The server's
`brx_vid` cookie is `httpOnly` and cannot be deleted from the page — clearing
that visitor server-side is the API's job, not this script's.

---

## 4. What is sent

Exactly one request per page load, and only with consent:

```
POST <API>/public/attribution/touch      Content-Type: application/json
```

sent with `navigator.sendBeacon` (a `fetch(keepalive)` fallback if the beacon is
refused). **The body is the whole store**, because that is what the server's
`attributionSchema` validates — `v`, `visitorId`, `first`, `last`, `touches`,
`createdAt`, `updatedAt`. Field lengths are clipped to the schema's caps so an
over-long `utm_campaign` costs one field rather than 422-ing the whole beacon.
The server answers `204` and nothing else.

Nothing else is sent. These two files do **not** wire up:

- **the booking form (§10.3).** It still opens WhatsApp with the details
  pre-filled. When the API is live, post `window.__berelaxAttr` as the
  `attribution` field of `POST /public/booking-requests` — the blob is left on
  `window` ready for exactly that, and it validates against
  `publicBookingRequestSchema` as-is.
- **the WhatsApp click-outs (§10.4).** The `wa.me` hrefs are unchanged, so those
  clicks are still invisible. Swapping them for `<API>/r/wa?ctx=…` is a separate
  edit to `index.html`.

The script also strips `utm_*`, `gclid`, `fbclid`, `msclkid`, `ttclid` and
`igshid` from the address bar, keeping any parameter that is not ours, so a link
copied from the address bar is clean.

---

## 5. The cookie mirror needs a subdomain

`POST /public/attribution/touch` responds with a `brx_vid` cookie set by the
server, `httpOnly`, `secure`, `sameSite=lax`, 90 days.

This exists because **a 90-day `localStorage` window is not achievable on
Safari or on any iOS browser** — ITP caps script-written storage at seven days
of no interaction, and most of this spa's traffic is iPhone. ITP's cap applies
to storage written by script; a cookie written by the server in a response
header, on a first-party domain, is not subject to it. `localStorage` is the
fast path, the cookie is the durable one.

**It only works while the API is a subdomain of the site's own domain** —
`api.berelax.ae` beside `berelax.ae`. On `*.netlify.app`, or on any separate
API domain, the cookie is third-party and is blocked outright. Buying the `.ae`
domain is a prerequisite for attribution working properly, not a nice-to-have.

Before enabling, the API also needs `PUBLIC_SITE_ORIGIN` set to this site's
origin (CORS, with credentials) and `COOKIE_DOMAIN` set to `.berelax.ae`.

---

## 6. Before you uncomment the line

1. The API is deployed at the subdomain and `/v1/public/attribution/touch` answers `204`.
2. `COOKIE_DOMAIN` and `PUBLIC_SITE_ORIGIN` are set for that domain.
3. **A privacy notice exists** at `BERELAX_PRIVACY_URL` (default `privacy.html`)
   and says what §3 above lists, including that financial records survive an
   erasure request (§11.4). The banner links to it; a banner linking to a 404 is
   not informed consent.
4. UAE counsel has reviewed the notice and the banner wording (§11 preamble).

Sizes: `attribution.js` 5,874 bytes, `consent.js` 8,047 bytes unminified —
13,921 for the pair, of which 2,244 is the injected CSS and 3,322 is comments.
Over the wire, gzipped as Netlify serves them, the pair is 5,812 bytes.
