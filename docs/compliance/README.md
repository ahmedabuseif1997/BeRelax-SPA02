# Compliance

The documents BE RELAX must have in place **before real guest data enters the
CRM**. They describe what this system actually does — not what a template says a
system might do — and every claim in them is traceable to a column in
`platform/apps/api/prisma/schema.prisma` or a line in
`platform/apps/api/src/`.

> **None of this is legal advice.** No document in this folder is legal advice,
> each one says so on its own face, and each one names what UAE counsel must
> review before launch. The governing instrument is
> **Federal Decree-Law No. 45 of 2021 (the PDPL)** — the spa is onshore in Abu
> Dhabi, so the DIFC and ADGM regimes do not apply. The PDPL's **Executive
> Regulations** set the procedural detail for several obligations referenced
> throughout, and **their current status must be confirmed with counsel before
> launch.** Where the law's application is genuinely arguable, these documents say
> so rather than asserting a comfortable answer.

---

## What is in here

| Document | What it is | Audience | Owner | Review |
|---|---|---|---|---|
| [`privacy-notice.md`](./privacy-notice.md) | The notice guests actually read, in English and Arabic. Currently **version `1.0-draft`, not in force.** | Guests, on the website and at the desk | `[TO BE COMPLETED: business owner]` | On any change to what is collected or why; at minimum annually |
| [`data-processing-register.md`](./data-processing-register.md) | The record of processing activities required by PDPL Art. 7 — thirteen activities, each mapped to real tables, with lawful basis, recipients, processors, storage, transfer safeguard, retention and security | Counsel, the UAE Data Office, auditors | `[TO BE COMPLETED: name]` | **Quarterly**, and on any migration that adds or removes a column holding personal data |
| [`runbooks/data-breach.md`](./runbooks/data-breach.md) | What to do at 02:00 when guest data has been reached. Contain, assess, notify, record — with the exact commands. | Whoever is awake | `[TO BE COMPLETED: breach lead]` | Annually, after any incident, and whenever the hosting or auth setup changes |

There is also a **living, machine-readable register** served by the API at
`GET /v1/compliance/processing-register` (`OWNER` only). It is generated from the
schema and reflects the system as deployed. This folder is the narrative version
that a human — or a regulator — reads. **If the two disagree, the code is right
and this folder is stale.**

---

## The version string is load-bearing

`guest_consents.policy_version` stores the exact version of the privacy notice a
guest was shown. That is what proves, later, what they actually agreed to.

- While the notice is a draft, the string is **`1.0-draft`**.
- **No consent from a real guest may be captured against a `-draft` version.**
- Any test consent recorded against `1.0-draft` must be deleted before launch.
- When the notice changes materially, bump the version and the date **in the same
  commit** as the wording change, and never reuse a version number.

---

## Before real guest data enters the system

Nothing below is optional. Items marked **BLOCKER** stop the launch.

### Legal

- [ ] **BLOCKER** — UAE counsel has reviewed the privacy notice, the consent
      wording and the cross-border transfer basis
- [ ] **BLOCKER** — Counsel has confirmed the **current status of the PDPL's
      Executive Regulations** and what they require for transfer, breach
      notification and data subject requests
- [ ] **BLOCKER** — The transfer safeguard is chosen, written into the register
      and named in the privacy notice: adequacy, contractual undertaking, or
      express consent
- [ ] **BLOCKER** — Signed Data Processing Addenda on file for **Supabase,
      Railway, Vercel, Netlify** and, if it is wired up, **Cloudflare**
- [ ] Counsel has answered the ten open questions in the register, including
      whether Federal Law 2/2019 on health data reaches this business and whether
      a DPO must be appointed
- [ ] Trade licence number and legal entity name filled into both documents

### Blanks filled

- [ ] **BLOCKER** — The breach runbook's contact table is complete: **a named
      person and a mobile number** for the breach lead, the deputy, the owner, the
      technical responder and counsel. A shared inbox is not a breach contact.
- [ ] **BLOCKER** — A monitored email address for privacy requests exists and is
      published in the notice
- [ ] Every `[TO BE COMPLETED: …]` in all three documents is resolved or has a
      named owner and a date

### Code

- [ ] **BLOCKER** — `consent.js` and `attribution.js` are wired into
      `index.html`, `BERELAX_ATTRIBUTION_API` is set, and the gate is verified
      live: `attribution.js` does not load before consent, Accept and Decline are
      equally prominent, one click declines, and the choice is re-openable from
      the footer *(register gap G5)*
- [ ] **BLOCKER** — `window.BERELAX_PRIVACY_VERSION` in `index.html` matches the
      privacy notice's version string exactly, and the desk sends the same string
      in `policyVersion`. The script's `"2026-01"` fallback must never be what a
      real consent is recorded against. *(G13)*
- [ ] **BLOCKER** — The booking form's message placeholder no longer invites
      injuries, and `assertNotMedical()` is applied to `booking_requests.message`
      and `reservations.notes`, not only `guests.notes` *(G1)*
- [ ] **BLOCKER** — A time-based retention rule exists for `booking_requests`;
      declined and spam enquiries do not sit indefinitely *(G4)*
- [ ] A named owner and a date exist for the **annual manual review of financial
      records** at five years — `FINANCIAL_RETENTION_YEARS` is read by nothing
      and should stay that way, but the review must be real *(G3)*
- [ ] Structured logging with PII redaction, and error reporting that strips PII,
      are in place — or §12.3 is amended to describe what actually runs *(G7)*
- [ ] §11.2 is updated to cover `PHOTO` consent *(G2)*; §11.6 lists
      `idempotency_records` *(G6)*; §11.9 describes the append-only triggers
      rather than `REVOKE` grants *(G10)*

### Operations

- [ ] **BLOCKER** — `ERASURE_SALT` is set to 32 real random bytes in production,
      is backed up somewhere it cannot be lost, and is recorded as **never to be
      rotated**
- [ ] **BLOCKER** — The Supabase region is provisioned deliberately, and the
      choice and its reasoning are recorded in the register
- [ ] The retention job is scheduled and verified on the production database:
      `SELECT jobname, schedule, active FROM cron.job;`
- [ ] A retention **dry run** has been executed against production
      (`POST /v1/compliance/retention/run` with `dryRun: true`) and the report
      read by a human
- [ ] An export and an erasure have been rehearsed end to end on seed data, and
      the erasure receipt has been read
- [ ] A database restore has been rehearsed and the result recorded in the
      register's review log
- [ ] HSTS is explicitly configured on both the API and the static site *(G12)*
- [ ] Rate limiting survives more than one API instance, or there is only ever
      one *(G11)*
- [ ] The breach runbook's quick-reference card is printed and taped inside the
      reception cupboard

---

## Things worth knowing before you read further

Four design decisions run through all three documents. They are unusual enough to
be worth stating once, here:

1. **This system stores no health or medical information at all.** Not a
   restricted field, not an encrypted one — no field. `guests.notes` is capped at
   500 characters by a database constraint and rejected at the API if it contains
   any of nine medical terms. The reasoning is in privacy-notice §"Why we refuse
   to store health information": it avoids a genuinely arguable question about
   UAE Federal Law 2/2019 rather than pretending to have answered it.

2. **Erasure keeps the transaction and destroys the person.** Financial records
   survive an erasure request because tax law requires them; the guest is severed
   from them. The privacy notice says this **up front, in ordinary words**, rather
   than burying a statute number — a guest who asks to be deleted and later learns
   records remain will not be reassured by Article 15.

3. **Reception can take money all evening and never see a total.** The role matrix
   is a privacy control as much as a financial one, and it is why the data subject
   rights endpoints sit at `MANAGER+` and retention sits at `OWNER`.

4. **The financial audit log cannot be edited or deleted by anyone**, including
   the application's own database role, because database triggers refuse. During a
   breach it is the only record still worth trusting — which is exactly why the
   breach runbook starts there.

---

## Keeping this folder honest

The register was written by reading the schema and the service code, not the
specification. Twice during that reading the code and spec §11 disagreed, and the
code won. **That is the rule: when the spec and the code disagree, the code is
what the business is actually doing, and this folder must describe the code.**

Open a change to this folder whenever you:

- add or remove a column that holds personal data
- add a processor, a hosting region, or a third-party script
- change a retention period, a lawful basis, or who can see what
- change anything a guest is told

The register's [§5](./data-processing-register.md#5-known-gaps-between-the-specification-and-the-code)
tracks divergences between the specification and the code. Ten are open. Do not
close one by deleting the row — close it by fixing the thing, then say so in the
review log.
