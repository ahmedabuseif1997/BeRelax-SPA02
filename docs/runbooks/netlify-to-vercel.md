# Runbook — moving the public site from Netlify to Vercel

**Do it in the 03:00–09:00 Dubai window, like every other deploy (spec §12.2).**
There is a short gap between DNS resolving to Vercel and Vercel issuing the TLS
certificate. In that gap `https://berelax.ae` fails. At 04:00 nobody is looking;
at 20:00 on a Thursday it is the booking page.

This moves **only the public marketing site** — `index.html`, `privacy.html` and
`assets/`. It does not touch the API or the CRM dashboard, which are their own
Vercel projects. Those have their own domains and their own configs.

---

## The one thing that must not go wrong

The repository root holds more than the website:

| At the root | What it is | If it were published |
|---|---|---|
| `platform/` | The CRM backend source, the Prisma schema, the docker-compose file | The backend's source and its data model, on the public internet |
| `docs/` | The architecture spec and **all of `docs/compliance/`** | The processing register, the breach runbook, the known-gaps table — read by anyone |
| `scripts/` | `backup-verify.sh` | Internal operational detail |
| `.github/` | The deploy workflows and the secret names | The shape of the release pipeline |

Neither host is told "serve the repo". Both are told to **assemble a publish
directory containing three things and nothing else**, and to serve that. This is
an allowlist: something new added at the root is excluded by default, because it
was never copied in. Keep it that way. Do not replace it with rules that block
`platform/` and `docs/` by name — that is a denylist, and a denylist fails open
the day someone adds a fourth directory.

> `vercel.json` is strict JSON. It cannot carry comments, and Vercel rejects
> unknown keys, so there is nowhere in that file to write any of this down.
> **This runbook is where the reasoning lives.** If you change `vercel.json`,
> change this document in the same commit.

---

## 0. Before you touch anything

- [ ] **0.1** You can log in to Vercel with an account that owns, or can create,
      the project. `[TO BE COMPLETED: Vercel team / scope]`
- [ ] **0.2** You can edit DNS for `berelax.ae`.
      `[TO BE COMPLETED: DNS provider and who holds the login]`
- [ ] **0.3** You can log in to Netlify and see the existing site.
      `[TO BE COMPLETED: Netlify team and site name]`
- [ ] **0.4** You know **every hostname the site answers on today** — the apex
      and almost certainly `www`. Read them off the Netlify site's Domain
      management page and write them here; if you miss one it will break at
      cutover and nobody will notice until a guest calls.
      `[TO BE COMPLETED: list every hostname, e.g. berelax.ae, www.berelax.ae]`
- [ ] **0.5** `vercel.json` is committed and on the branch Vercel will deploy.
      It is inert until a Vercel project exists, and **Netlify ignores it
      entirely**, so committing it changes nothing about the live site.

Nothing in steps 0–5 is visible to a guest. The site stays on Netlify until
step 6.

---

## 1. Create the Vercel project

Vercel → **Add New** → **Project** → import `ahmedabuseif1997/BeRelax-SPA02`.

Then, on the configuration screen, before you deploy:

- [ ] **1.1 Framework Preset: `Other`.**
      Not "Vite", not "Astro", not anything auto-suggested. `Other` means no
      framework build is inferred.
- [ ] **1.2 Root Directory: `./`** — the repository root, left as-is.

      This looks alarming and is correct. The root directory is where the build
      *runs*, not what gets served. The build assembles `_site/` and Vercel
      publishes `_site/` alone. Setting the root directory to something else
      would break the copy step, because `assets/` is at the root.

- [ ] **1.3 Build and Output Settings: leave every field empty / Vercel-default.**
      Do not type the build command into the dashboard. `vercel.json` already
      carries `buildCommand`, `outputDirectory`, `installCommand` and
      `framework`, and a value typed into the dashboard **overrides the file**.
      That is how the two drift apart and how someone later reads `vercel.json`,
      believes it, and is wrong.
- [ ] **1.4 No environment variables.** The site is static and reads none.
- [ ] **1.5 Production branch** — set to the branch that is live today.
      `[TO BE COMPLETED: production branch, e.g. main]`
- [ ] **1.6 Deploy.** Then confirm in the build log:
      - no install step ran (`installCommand` is `""`, and there is no root
        `package.json` to trigger one)
      - the log shows the `rm -rf _site && mkdir -p _site && cp ...` line
      - the build succeeded and uploaded from `_site`

      **If the log mentions `pnpm install`, `npm install`, or a framework build,
      stop.** Something added a root `package.json`, or a dashboard override is
      fighting `vercel.json`. Fix that before going further.

**Rollback:** none needed. Nothing is live. Delete the Vercel project and walk
away; Netlify has not been touched.

---

## 2. Prove the deployment serves the right thing — and nothing else

Do this on the `*.vercel.app` URL, **before any DNS change**. This is the step
that protects `platform/` and `docs/`, so do not skim it.

```bash
SITE="[TO BE COMPLETED: the Vercel deployment URL, e.g. https://xxxx.vercel.app]"
```

> Run these in **bash or zsh**, not `sh`. The header comparison in §2.3 uses
> process substitution (`<(...)`), which plain `sh` does not have.

### 2.1 What must be served — expect `200`

```bash
for p in \
  / \
  /index.html \
  /privacy.html \
  /assets/logo/be-relax-logo-dark.png \
  /assets/photos/hero-team.jpg \
  /assets/videos/spa-tour-01.mp4 \
  /assets/js/consent.js \
; do
  printf '%s  %s\n' "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$SITE$p")" "$p"
done
```

All seven must be `200`. `privacy.html` especially — the consent banner links to
it, and a banner pointing at a 404 is not consent.

### 2.2 What must NOT be served — expect `404` on every single line

```bash
for p in \
  /platform/ \
  /platform/package.json \
  /platform/pnpm-lock.yaml \
  /platform/docker-compose.yml \
  /platform/apps/api/package.json \
  /platform/apps/dashboard/vercel.json \
  /docs/ \
  /docs/spa-crm-architecture-spec.md \
  /docs/compliance/data-processing-register.md \
  /docs/compliance/privacy-notice.md \
  /docs/compliance/runbooks/data-breach.md \
  /docs/runbooks/go-live.md \
  /docs/runbooks/netlify-to-vercel.md \
  /scripts/backup-verify.sh \
  /.github/workflows/platform-deploy.yml \
  /.github/workflows/platform-ci.yml \
  /netlify.toml \
  /vercel.json \
  /README.md \
  /.gitignore \
; do
  printf '%s  %s\n' "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$SITE$p")" "$p"
done
```

**Every line must read `404`.**

> **A single `200` in that list is a stop-the-world event.** Do not move DNS. Do
> not "fix it after cutover". Find out why the publish directory contains
> something it should not, fix it, redeploy, and run this block again from the
> top. If a compliance document was reachable on a URL that anyone could have
> requested, that is also a §11.8 question — see
> `docs/compliance/runbooks/data-breach.md`.

Then confirm the same thing from the other direction — that the deployment
contains only what it should. In the Vercel dashboard open the deployment and
look at the deployed file tree (**Deployment → Source / Output**). It must show
`index.html`, `privacy.html` and `assets/`, and nothing else.

> Vercel uploads the whole repository to the *build machine* — that is normal
> and is not the same as publishing it. What is served is `_site/` alone. The
> curl block above is what proves it; the file tree is the confirmation.

### 2.3 Headers — diff them against the site that is still live

Do not read the header list and nod. Compare it to what Netlify is serving
right now, so anything dropped shows up as a line of output:

```bash
hdrs () {
  curl -sS -D - -o /dev/null --max-time 20 "$1" \
    | grep -iE '^(x-content-type-options|x-frame-options|referrer-policy|permissions-policy|cache-control):' \
    | tr 'A-Z' 'a-z' | sed 's/: */: /' | sort
}

diff <(hdrs "https://berelax.ae/")            <(hdrs "$SITE/")            && echo "  / identical"
diff <(hdrs "https://berelax.ae/privacy.html") <(hdrs "$SITE/privacy.html") && echo "  /privacy.html identical"
diff <(hdrs "https://berelax.ae/assets/photos/hero-team.jpg") \
     <(hdrs "$SITE/assets/photos/hero-team.jpg") && echo "  /assets identical"
```

What each URL must carry:

| URL | Headers |
|---|---|
| everything | `x-content-type-options: nosniff`, `x-frame-options: SAMEORIGIN`, `referrer-policy: strict-origin-when-cross-origin`, `permissions-policy: geolocation=(), microphone=(), camera=()` |
| `/`, `/index.html`, `/privacy.html` | `cache-control: public, max-age=0, must-revalidate` |
| `/assets/*` | `cache-control: public, max-age=3600, must-revalidate` |

Two notes on the `diff` above:

- `/` may legitimately differ. `netlify.toml` sets its no-cache rule on the path
  `/index.html`; `vercel.json` sets it on `/`, `/index.html`, `/privacy` **and**
  `/privacy.html`. That is deliberate — `/` is the URL every guest actually
  uses, and it should not be inheriting a platform default. More revalidation,
  never less.
- Everything else must come back identical. A difference on `/privacy.html` is
  the serious one: that page carries the version string consent records are
  filed against, and a cached copy showing a guest the wrong version is a
  consent problem, not a performance one.

### 2.4 Look at it

- [ ] Open the `*.vercel.app` URL in a browser. Photos, team grid and both
      videos load. No 404s in the network tab.
- [ ] `privacy.html` renders, and its "back to the site" link works.

**Rollback:** still nothing to roll back. The site is on Netlify. If any of §2
fails, you simply do not proceed.

---

## 3. Lower the DNS TTL — the day before

TTL is how long resolvers and browsers are allowed to keep the **old** answer.
When you change a record, the time it takes to take effect everywhere is the TTL
**that was in force when the record was last cached** — not the new one. So
lowering the TTL only helps if you lower it far enough in advance.

- [ ] **3.1** Read the current TTL on every hostname from 0.4.
      `[TO BE COMPLETED: current TTL per record]`
- [ ] **3.2** Lower it to 300 seconds (or the provider's minimum).
      `[TO BE COMPLETED: new TTL]`
- [ ] **3.3** **Wait at least one full old-TTL period before cutting over.** If
      the TTL was 3600, wait an hour. If it was 86400, the low TTL is not
      effective until tomorrow — and that is the answer to "can we do it
      tonight?": no.

Leave it low until step 7 is finished, then put it back.

**Rollback:** set the TTL back. It affects nothing a guest can see.

---

## 4. Add the domain in Vercel — still before DNS

Vercel project → **Settings → Domains** → add **every** hostname from 0.4.

- [ ] **4.1** Apex added. `[TO BE COMPLETED: apex hostname]`
- [ ] **4.2** `www` (and any other host from 0.4) added, with the
      apex/`www` redirect set the way it is on Netlify today — whichever is
      canonical there stays canonical here. Changing which one redirects to
      which, during a host migration, is how you lose search rankings and
      discover it a month later.
- [ ] **4.3** Vercel now shows the exact DNS records it wants.
      **Copy them from that screen.** Do not copy them from this runbook, from
      a blog post, or from memory — Vercel's published addresses change, and
      the screen in front of you is the only authority.
      `[TO BE COMPLETED: paste the exact records Vercel shows — type, name, value]`

Vercel will report the domains as misconfigured. That is correct: DNS still
points at Netlify. **Leave Netlify exactly as it is.**

**Rollback:** remove the domains from Vercel. DNS has not moved; nothing changed
for anyone.

---

## 5. Cut over DNS — 03:00–09:00 Dubai

- [ ] **5.1** Note the current values first, so you can put them back without
      thinking at 04:00.
      `[TO BE COMPLETED: the existing Netlify DNS records, verbatim]`
- [ ] **5.2** Change the records to the values from 4.3. One hostname at a time.
- [ ] **5.3** Watch it move:

      ```bash
      dig +short berelax.ae
      dig +short www.berelax.ae
      dig +short @1.1.1.1 berelax.ae      # a resolver that is not yours
      ```

- [ ] **5.4** Wait for Vercel to issue the certificate. Settings → Domains goes
      to a valid state, usually within a few minutes of DNS resolving.

      **Until it does, HTTPS on the apex fails.** This is the one genuinely
      guest-visible moment in the whole migration, and it is why this happens at
      04:00 and not at 20:00.

- [ ] **5.5** Re-run **all of §2.2** against the real domain. The 404 list is
      the point of the exercise and the domain is what the public actually
      reaches:

      ```bash
      SITE="https://berelax.ae"   # then repeat for every hostname in 0.4
      ```

- [ ] **5.6** Re-run §2.1 and §2.3 against the real domain too.
- [ ] **5.7** Open the site on a phone on mobile data — not office wifi, whose
      resolver you have already warmed up.

**Rollback — this is the step with a real one.** Put the records from 5.1 back.
Netlify is still running, still connected to the repository, still building from
`netlify.toml`, and still serving the identical site. Recovery is one DNS edit
and one TTL period — which is 5 minutes, because of step 3. **This rollback only
exists because you have not yet done steps 7 and 8. That is the entire reason
they come last.**

---

## 6. Let it sit

- [ ] **6.1** Leave both hosts up for at least
      **`[TO BE COMPLETED: overlap period — 24-48 hours is the usual call]`**.

      Both hosts serve the same commit, from the same repository, with the same
      assembled publish directory. A visitor on a stale DNS answer lands on
      Netlify and gets the correct site. Double-hosting for a day costs a rounding
      error. Deleting Netlify early costs you the rollback in step 5.

- [ ] **6.2** Check Vercel's traffic — requests arriving means DNS has moved.
- [ ] **6.3** Check Netlify's bandwidth/analytics falling to roughly zero.
      **That number reaching zero, and staying there, is the signal to proceed.**
      Until it does, somebody is still being served by Netlify.
- [ ] **6.4** Confirm no 404 spike in Vercel's logs — that would mean a path
      that worked on Netlify does not work here.

**Rollback:** still the DNS edit from step 5.

---

## 7. Delete the Netlify site — first

Only when 6.3 has been true for the full overlap period.

- [ ] **7.1** Screenshot or export anything you still need from Netlify —
      access logs, analytics, the deploy history, the domain settings. `docs/compliance/data-processing-register.md`
      treats Netlify access logs as a processing record; once the site is gone
      they are gone. `[TO BE COMPLETED: confirm what was exported and where it was filed]`
- [ ] **7.2** Netlify → the site → **Site settings → Danger zone** →
      **Unlink the repository** (or delete the site outright).
- [ ] **7.3** Confirm Netlify no longer builds on a push to this repository.

**This step comes before step 8, and the order is not cosmetic.**
`netlify.toml` is the only thing standing between a Netlify build and the
repository root. While the site is connected, that file is load-bearing. Once
the site is deleted the file is inert — it is a text file nothing reads. So:
**delete the site first, then remove the file.** Doing it the other way round
means that between the two actions, any push to this repository triggers a
Netlify build with no configuration, Netlify falls back to its default publish
directory — the repository root — and `platform/` and every document in
`docs/compliance/` is published on `berelax.ae`. Automatically. With no warning
and nobody watching, at 05:00.

**Rollback:** this is the first step that is not cheaply reversible. Netlify
sites can be restored for a short window, but re-linking and re-deploying takes
real minutes. Do not reach this step with any doubt left over from §2 or §6.

---

## 8. Remove `netlify.toml` — last

- [ ] **8.1** Confirm step 7 is done: the Netlify site is gone.
- [ ] **8.2** Delete `netlify.toml`, and delete the retention notice at the top
      of it along with the file.
- [ ] **8.3** In the same commit, update the references so the repository stops
      describing a host it no longer uses:
      - `platform/README.md` — the "Public site | Netlify" row
      - `docs/compliance/data-processing-register.md` — the **Netlify**
        processor row, and every processor list that names Netlify (§3 and the
        per-activity tables). **This is a compliance record, not a comment.**
        The register names the processors that handle guest data; if it names a
        processor that no longer serves the site, and omits the one that does,
        it is wrong on the exact point it exists to be right about.
      - `docs/compliance/runbooks/data-breach.md` — the Netlify contact row, the
        deploy-key row, and the access-log row
      - `docs/runbooks/go-live.md` §4.1 — the apex now points at Vercel
      - `docs/spa-crm-architecture-spec.md` — the architecture diagram and §11
      - `assets/js/README.md` — the "the Netlify build copies named files"
        sentence; it is still true of Vercel, it is just no longer Netlify
- [ ] **8.4** A Data Processing Addendum with Vercel is already required for the
      dashboard (`go-live.md` 0.3). Confirm it covers the public site too, and
      that the Netlify DPA can be closed out.
      `[TO BE COMPLETED: DPA status]`

**Rollback:** `git revert`. But restoring the file does not restore the Netlify
site — by this point the file does nothing. The real rollback is "re-create a
Netlify site", which is a new task, not a rollback.

---

## 9. Afterwards

- [ ] **9.1** Put the DNS TTL back up (step 3.2).
- [ ] **9.2** `docs/compliance/data-processing-register.md` records the hosting
      region as `[TO BE COMPLETED: Netlify edge — global]`. Vercel serves static
      files from a global CDN in the same way. `vercel.json` deliberately sets
      **no** `regions` key: `regions` applies to serverless functions, and this
      site has none, so setting it would put a number in the config that means
      nothing and imply a residency guarantee to the next person who reads it.
      Record what is actually true. `[TO BE COMPLETED: Vercel hosting region for the static site]`
- [ ] **9.3** Gap **G12** in the register — no HSTS header on the public site —
      is still open. `vercel.json` reproduces `netlify.toml` exactly and
      therefore still sets none. **Do not close G12 during this migration.**
      `go-live.md` 4.4 wants `includeSubDomains; preload` on the apex, preload is
      hard to undo, and adding it while rollback to Netlify is still a live
      option mixes two changes with different blast radii. Close it as its own
      change, after the dust settles.
- [ ] **9.4** `assets/README.md`, `assets/js/README.md` and the other per-folder
      READMEs are inside `assets/` and are therefore published — as they are on
      Netlify today. Nothing changes here at cutover. If they should not be
      public, that is a separate decision and a separate change; make it
      deliberately rather than as a side effect of a host migration.

---

## 10. The domain decision reaches further than this page

The hostname chosen here is not only a marketing decision.

> **`api.berelax.ae` must be a subdomain of the public site's own domain.**
>
> The attribution cookie mirror (spec §10.5, `assets/js/attribution.js`) depends
> on the API setting a **first-party** cookie. A 90-day attribution window is not
> achievable in `localStorage` on Safari or any iOS browser — ITP caps
> script-written storage at seven days of inactivity, and most of this spa's
> traffic is iPhone. A cookie written by the server in a response header, on a
> first-party domain, is not subject to that cap. That is the whole mechanism.
>
> It only holds while the API is a subdomain of the site: `api.berelax.ae`
> beside `berelax.ae`. On a `*.vercel.app` host, a `*.netlify.app` host, or any
> separately-registered API domain, the cookie is third-party and Safari drops
> it **silently**. Nothing errors. Nothing logs. The iOS half of the channel ROI
> report is simply and permanently wrong.

So: if this migration ever tempts anyone to leave the site on a `*.vercel.app`
URL, or to move it to a different registrable domain, that decision quietly
breaks attribution and the API's `COOKIE_DOMAIN=.berelax.ae` along with it. See
`go-live.md` 4.2 and `assets/js/README.md` §5.

---

## 11. Rollback at a glance

| After step | Live site is on | To undo | Cost |
|---|---|---|---|
| 1 — Vercel project created | Netlify | Delete the Vercel project | Nothing |
| 2 — deployment verified | Netlify | Nothing to undo | Nothing |
| 3 — TTL lowered | Netlify | Raise the TTL | Nothing |
| 4 — domains added in Vercel | Netlify | Remove the domains in Vercel | Nothing |
| 5 — **DNS moved** | Vercel | **Restore the records from 5.1** | One TTL — ~5 min, because of step 3 |
| 6 — overlap | Vercel | Restore the records from 5.1 | One TTL |
| 7 — Netlify site deleted | Vercel | Re-create and re-link the site | Real minutes, under pressure |
| 8 — `netlify.toml` removed | Vercel | `git revert` — but this does not bring Netlify back | The file is inert by now |

Steps 1–6 are reversible in minutes. Step 7 is where that stops being true,
which is why it is step 7 and not step 3.

---

## 12. Related

- `vercel.json` — the config this runbook deploys (and the only place the build
  is defined; it cannot hold comments, so the reasoning is here)
- `netlify.toml` — retained until step 8, with a notice at the top saying why
- `platform/apps/dashboard/vercel.json` — the CRM dashboard, a different project
  on a different domain; unaffected by any of this
- `docs/runbooks/go-live.md` §4 — DNS for `api.` and `crm.`, and the deploy window
- `assets/js/README.md` §5 — the cookie mirror and the subdomain requirement
- `docs/compliance/data-processing-register.md` — the processor rows that step
  8.3 updates, and gap G12
