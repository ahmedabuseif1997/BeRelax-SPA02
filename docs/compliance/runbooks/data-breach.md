# Runbook — Personal Data Breach

**BE RELAX Massage Center and Spa**

| | |
|---|---|
| **Version** | `1.0-draft` |
| **Date** | 17 September 2026 |
| **Implements** | Architecture spec [§11.8](../../spa-crm-architecture-spec.md) · PDPL Art. 9 |
| **Read this when** | You think guest or staff data has been reached by someone who should not have reached it |

> **This runbook is not legal advice.** Steps 3 and 4 have legal consequences and
> must be reviewed by UAE counsel before launch, including confirmation of what
> the PDPL's **Executive Regulations** require procedurally — notification
> deadlines, the required particulars, and the form of notice.

---

## ⛔ BEFORE LAUNCH — these blanks must be filled

**This runbook is not usable until the table below is complete.** A breach at
02:00 is not the moment to find out that "the breach contact" is a shared inbox
nobody is reading. Every row needs a **person** and a **phone number**.

| Role | Name | Mobile | Notes |
|---|---|---|---|
| **Breach lead** (decides, owns the clock) | `[TO BE COMPLETED: NAME]` | `[TO BE COMPLETED: MOBILE]` | Wake this person first, whatever the hour |
| **Deputy breach lead** (if the lead does not answer in 15 min) | `[TO BE COMPLETED: NAME]` | `[TO BE COMPLETED: MOBILE]` | |
| **Business owner** | `[TO BE COMPLETED: NAME]` | `[TO BE COMPLETED: MOBILE]` | Must be told, even if not leading |
| **Technical responder** (has Supabase + Railway access) | `[TO BE COMPLETED: NAME]` | `[TO BE COMPLETED: MOBILE]` | Runs [Step 1](#step-1--contain) |
| **UAE counsel** | `[TO BE COMPLETED: FIRM AND LAWYER NAME]` | `[TO BE COMPLETED: MOBILE]` | Engage before [Step 3](#step-3--notify-the-uae-data-office) |
| **Manager on duty** (tonight) | On the shift roster | 052 510 8633 / 02 557 6533 | The spa is open 11:00–02:00 daily |

**Credentials and accounts** — who holds the keys:

| System | Account holder | Where the credential lives |
|---|---|---|
| Supabase (database) | `[TO BE COMPLETED]` | `[TO BE COMPLETED: password manager location]` |
| Railway (API) | `[TO BE COMPLETED]` | `[TO BE COMPLETED]` |
| Vercel (dashboard) | `[TO BE COMPLETED]` | `[TO BE COMPLETED]` |
| Netlify (public site) | `[TO BE COMPLETED]` | `[TO BE COMPLETED]` |
| Domain registrar | `[TO BE COMPLETED]` | `[TO BE COMPLETED]` |

---

## Step 0 — The first five minutes

Do these in order. Do not investigate first.

1. **Write down the time.** Use UTC and Dubai time. Everything after this is
   measured from here.
   ```bash
   date -u +"%Y-%m-%dT%H:%M:%SZ" && TZ=Asia/Dubai date +"%Y-%m-%d %H:%M %Z"
   ```
2. **Call the breach lead.** If no answer in 15 minutes, call the deputy. If no
   answer, call the owner.
3. **Start an incident log.** A text file, a notebook, anything. Every action,
   with its timestamp and who did it. You will need this for [Step 5](#step-5--record).
4. **Do not delete anything.** Not a log, not a row, not a container. Evidence
   first. The financial audit log cannot be deleted even deliberately — that is
   the point of it — but platform logs can, and they rotate.
5. **Do not tell guests yet.** [Step 4](#step-4--notify-affected-guests) has a
   process. A premature message that turns out to be wrong is its own incident.

---

## Step 1 — Contain

**Goal: make any stolen credential worthless in the next ten minutes.**

Work through 1.1 → 1.4 in order. 1.1 and 1.2 together end every active session.

### 1.1 Revoke every refresh token

This signs out every staff member on every device, everywhere.

```bash
# Use DIRECT_URL (port 5432), not the pooler. Admin work goes on the direct connection.
psql "$DIRECT_URL" -c \
  "UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL;"
```

Confirm it took:

```bash
psql "$DIRECT_URL" -c \
  "SELECT count(*) AS still_live FROM refresh_tokens
    WHERE revoked_at IS NULL AND expires_at > now();"
# Expect: still_live = 0
```

**Before you run it, capture who was signed in** — this is evidence and the
`UPDATE` will not destroy it, but take the snapshot anyway:

```bash
psql "$DIRECT_URL" -c \
  "SELECT rt.user_id, u.email, u.role, rt.ip_address, rt.user_agent,
          rt.created_at, rt.expires_at, rt.family_id
     FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
    WHERE rt.revoked_at IS NULL AND rt.expires_at > now()
    ORDER BY rt.created_at DESC;" > ~/incident-sessions-before.txt
```

> **If you only need to cut off one person** (a lost phone, a dismissed
> employee), there is an endpoint for it and it writes an audit row:
> `POST /v1/users/:id/revoke-sessions`, available to `OWNER` and `MANAGER`.
> In a breach, use the SQL above instead — it covers everyone at once.

### 1.2 Rotate `JWT_SECRET`

Revoking refresh tokens does **not** kill access tokens. Those are signed JWTs
with a 15-minute life (`JWT_ACCESS_TTL=15m`) and are valid until they expire.
Rotating the secret kills them immediately.

```bash
# Generate a new secret — 32 random bytes, base64. The API refuses to boot with anything shorter.
openssl rand -base64 32
```

Set it on the API service (Railway):

- **Dashboard route (use this one):** Railway → the API service → **Variables** →
  set `JWT_SECRET` to the new value → **redeploy**.
- **CLI route** (verify your CLI version's syntax first):
  ```bash
  railway variables --set "JWT_SECRET=<new-value>"
  ```

> **Critical: leave `JWT_SECRET_PREVIOUS` EMPTY.**
>
> `TokenService.verifyAccess()` tries the current secret and then the previous
> one. `JWT_SECRET_PREVIOUS` exists for a *planned* rotation, so tokens signed a
> minute before the swap keep working for a 24-hour overlap. **In a breach that
> overlap is the attacker's window.** If `JWT_SECRET_PREVIOUS` is currently set
> from an earlier planned rotation, **clear it in the same change.**

Then verify the old token is dead:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer <a token issued before the rotation>" \
  https://api.berelax.ae/v1/auth/me
# Expect: 401
```

### 1.3 Rotate the database credentials

1. **Supabase Dashboard → Project Settings → Database → Reset database password.**
   Copy the new password.
2. Rebuild **both** connection strings. They are different and using the wrong
   one costs an afternoon:
   - `DATABASE_URL` — transaction pooler, **port 6543**, with
     `?pgbouncer=true&connection_limit=1`
   - `DIRECT_URL` — session connection, **port 5432**, no pooler parameters
   ```
   DATABASE_URL="postgresql://postgres.PROJECT:NEWPASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1"
   DIRECT_URL="postgresql://postgres.PROJECT:NEWPASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres"
   ```
3. Update both on Railway and redeploy.
4. Confirm the API is alive:
   ```bash
   curl -s https://api.berelax.ae/health/ready
   ```

### 1.4 Rotate every other key

| Key | Where | Note |
|---|---|---|
| Supabase API keys (`service_role`, `anon`/publishable) | Supabase → Project Settings → API | Rotate if any client or script held them |
| Netlify deploy keys / build hooks | Netlify → Site settings | The public site is static, but a deploy hook lets someone publish to your domain |
| Vercel tokens | Vercel → Account → Tokens | |
| Domain registrar and DNS | Registrar account | If DNS could have been touched, this is more urgent than the database |
| GitHub tokens / deploy keys | GitHub → Settings | |

> ## 🚫 NEVER rotate `ERASURE_SALT`
>
> Not during a breach, not ever. Every already-erased guest's phone number is
> stored as `erased:sha256(phone + ERASURE_SALT)`. Rotating the salt orphans
> every one of those records — a previously blocked guest silently stops being
> blocked, and duplicate detection breaks for everyone who was erased. If the
> salt itself is what leaked, stop and call counsel: that is a different problem
> and rotating is not the answer.

### 1.5 If the attack is still live

- Take the API offline rather than leave it reachable: Railway → the API service
  → **Remove/scale to zero**, or set the service to sleep. The public website
  (Netlify) stays up, so guests can still call 052 510 8633 and book.
- Reception falls back to paper. The spa is open until 02:00 and the evening does
  not stop because the CRM did.

---

## Step 2 — Assess

**Goal: establish what was reached, by whom, and when — with evidence.**

The `financial_audit_log` is append-only and enforced by database triggers. Even
a compromised database role cannot rewrite it. **During a breach it is the only
record you can still trust.** Start there.

### What actions has a suspect account taken?

```sql
SELECT created_at, action, entity_type, entity_id, amount_fils,
       ip_address, user_agent, request_id
  FROM financial_audit_log
 WHERE actor_user_id = '<user-uuid>'
 ORDER BY created_at DESC;
```

### Authentication events across the window

```sql
SELECT created_at, action, actor_user_id, actor_role, ip_address, user_agent, after_state
  FROM financial_audit_log
 WHERE action IN ('AUTH_LOGIN_SUCCEEDED', 'AUTH_LOGIN_FAILED',
                  'AUTH_REFRESH_REUSE_DETECTED', 'PASSWORD_RESET',
                  'USER_SESSIONS_REVOKED', 'USER_CREATED', 'USER_ROLE_CHANGED')
   AND created_at >= now() - interval '30 days'
 ORDER BY created_at DESC;
```

`AUTH_REFRESH_REUSE_DETECTED` is the signature of a **stolen session cookie** —
someone presented a refresh token that had already been spent. If you see one,
treat the whole token family as compromised; the system already revoked it.

### Which IP addresses has each account used?

An address that has never appeared before is the thing to look for.

```sql
SELECT actor_user_id, ip_address, count(*) AS events,
       min(created_at) AS first_seen, max(created_at) AS last_seen
  FROM financial_audit_log
 WHERE created_at >= now() - interval '90 days'
 GROUP BY 1, 2
 ORDER BY actor_user_id, first_seen;
```

### Did anyone export or erase guest data?

```sql
SELECT created_at, actor_user_id, actor_role, action, entity_id, ip_address, request_id
  FROM financial_audit_log
 WHERE action IN ('GUEST_DATA_EXPORTED', 'GUEST_ERASED')
 ORDER BY created_at DESC;
```

A `GUEST_DATA_EXPORTED` row is a **bulk read of one guest's entire history** —
record, consents, bookings, payments, tips, enquiries and attribution, in one
file. If an attacker reached a `MANAGER` or `OWNER` account, this is the row that
tells you what left the building, and the `entity_id` names the guest.

> **Caveat, stated honestly:** an empty result does **not** mean no guest data was
> read. **Ordinary reads of the guest book are not audited at all** — the audit
> log records what changed about the *money*, not who browsed the customer list.
> A stolen `RECEPTIONIST` session paging through `GET /v1/guests` leaves nothing
> here. To establish whether guest records were read, you need the platform
> request logs ([below](#what-the-audit-log-will-not-tell-you)), not this table.

Also check whether retention or the register was touched, since both are `OWNER`
endpoints and a run against real data is destructive:

```sql
SELECT created_at, actor_user_id, action, entity_type, entity_id, after_state
  FROM financial_audit_log
 WHERE action = 'GUEST_ERASED'
   AND created_at >= now() - interval '30 days'
 ORDER BY created_at DESC;
-- Many GUEST_ERASED rows in a short window with the same request_id is a
-- retention run. Many with DIFFERENT request ids is somebody destroying records.
```

### How big is the exposure?

```sql
-- Live guest records
SELECT count(*) AS guests_live
  FROM guests WHERE deleted_at IS NULL AND anonymised_at IS NULL;

-- How many carry an email address as well as a phone number
SELECT count(*) FILTER (WHERE email IS NOT NULL) AS with_email,
       count(*)                                  AS total
  FROM guests WHERE deleted_at IS NULL AND anonymised_at IS NULL;

-- Unconverted enquiries (name, phone, free-text message)
SELECT status, count(*) FROM booking_requests GROUP BY 1;

-- Attribution rows still carrying identifiers
SELECT count(*) FROM attribution_snapshots WHERE pruned_at IS NULL;
```

### Money movements in the window

```sql
SELECT action, count(*), sum(amount_fils) AS total_fils
  FROM financial_audit_log
 WHERE created_at BETWEEN '<start>' AND '<end>'
   AND amount_fils IS NOT NULL
 GROUP BY 1 ORDER BY 3 DESC;
```

### What the audit log will **not** tell you

Be clear about this when writing the assessment, because it changes what you can
honestly claim:

- **Reads are not audited.** Someone who logged in as reception and paged through
  the guest list leaves no row in `financial_audit_log`. Only writes that touch
  money do.
- **The audit log holds no PII.** `pickAuditFields()` strips names, phone numbers,
  emails, notes and legal names before writing. That is good for privacy and it
  means the log cannot tell you *which guest's name* was exposed — only which
  entity IDs were touched.
- **Application-level logging is thin.** The pino structured logging and Sentry
  described in §12.3 are **not implemented**. Your request-level evidence is
  whatever Railway, Vercel and Netlify retain by default.

So also pull:

| Source | What to pull | Where |
|---|---|---|
| Railway | API request and error logs for the window | Railway → the API service → Logs (export before they rotate) |
| Supabase | Postgres logs, connection history, auth logs | Supabase → Logs Explorer |
| Vercel | Dashboard access logs | Vercel → the project → Logs |
| Netlify | Public site access logs | Netlify → the site → Analytics / Logs |

**Export every one of these to a file immediately.** Platform log retention is
finite and the clock is already running.

### Write the assessment

By the end of Step 2 you must be able to answer, in writing:

1. **What happened?** (credential theft, misconfiguration, insider, lost device…)
2. **When did it start and when did it stop?** (UTC and Dubai)
3. **What categories of data were reachable?** Name and phone? Email? Booking
   history? Payment amounts? Staff records?
4. **How many people are affected**, and are they guests, staff, or both?
5. **Was any of it sensitive data?** The system stores **no health data by
   design**, which is the single most useful sentence you will write in the
   notification — say it plainly and say why.
6. **What is the actual risk to those people?** A phone number and a massage
   booking is not nothing: it is a real privacy harm in a conservative social
   context and it should not be minimised.
7. **What have you already done** to contain it?

---

## Step 3 — Notify the UAE Data Office

**Trigger:** PDPL Art. 9 requires notification to the UAE Data Office **without
undue delay** on becoming aware of a breach that would prejudice the privacy,
confidentiality or security of the personal data.

> **Do not invent a deadline.** Whether a fixed window applies, and the exact
> particulars required, are set by the PDPL's **Executive Regulations** — whose
> status must be confirmed with counsel. **Operate to an internal 72-hour target
> from the moment of awareness**, as a working discipline, and treat it as an
> internal target and not as a stated legal deadline.

**Call counsel before filing.** `[TO BE COMPLETED: FIRM AND LAWYER NAME]`,
`[TO BE COMPLETED: MOBILE]`.

**Where to file:** `[TO BE COMPLETED: the UAE Data Office's current notification
channel — portal URL, email or form. Verify this at the time of filing; do not
rely on a URL written here months earlier.]`

### Particulars to have ready

Assemble these before you file, whatever form the filing takes:

| # | Item |
|---|---|
| 1 | Controller identity: BE RELAX Massage Center and Spa, 250 Al Meena Street, Tower Block A/B, M-Floor, Al Zahiyah (Al Mina), E14, Abu Dhabi · trade licence `[TO BE COMPLETED]` |
| 2 | Contact person: `[TO BE COMPLETED: NAME]`, `[TO BE COMPLETED: MOBILE]`, `[TO BE COMPLETED: EMAIL]` |
| 3 | Date and time the breach occurred, and the date and time you became aware — both in UTC and Dubai time |
| 4 | Nature of the breach and how it happened |
| 5 | Categories of personal data affected (from your Step 2 assessment) |
| 6 | Approximate number of data subjects affected, and whether guests, staff, or both |
| 7 | Likely consequences for those people |
| 8 | Measures taken to contain it (Step 1), with timestamps |
| 9 | Measures proposed to prevent recurrence |
| 10 | Whether data subjects have been notified, and if not, why not and when they will be |
| 11 | Whether the data was encrypted or otherwise unintelligible to the person who obtained it |
| 12 | Cross-border dimension: the data is hosted in `[TO BE COMPLETED: region/country]` |

### Also notify

- **The processor whose platform was involved** — Supabase, Railway, Vercel,
  Netlify or Cloudflare — through their security contact. They may have logs you
  cannot see.
- **Abu Dhabi Police / UAE Cybercrime**, if a crime was committed:
  `[TO BE COMPLETED: reporting route confirmed with counsel]`
- **Your insurer**, if there is cyber cover: `[TO BE COMPLETED]`

---

## Step 4 — Notify affected guests

**Trigger:** notify data subjects where the breach poses a risk to their privacy,
confidentiality or security. **Counsel decides.** If in doubt, notify — a guest
who hears it from you is in a different relationship with you than one who hears
it elsewhere.

**Language:** Arabic and English, both. Not one with the other as an
afterthought.

**Channel:** WhatsApp or SMS to the mobile on the booking, because that is the
number we hold and the only contact route most guests have given us. Email only
where we hold one. A notice at the front desk for walk-in guests we cannot reach.

**Who sends it:** the breach lead or the owner — not reception. Reception must be
briefed on what to say if a guest asks, and given the same text.

### Template — English

> **Subject / first line: An important notice about your information at BE RELAX**
>
> Dear `[GUEST NAME]`,
>
> We are writing to tell you about a problem with the security of information we
> hold about you. We would rather tell you directly than have you hear it
> elsewhere.
>
> **What happened.** On `[DATE]`, `[PLAIN DESCRIPTION OF WHAT HAPPENED — one or
> two sentences, no jargon]`. We discovered this on `[DATE]` and stopped it on
> `[DATE AND TIME]`.
>
> **What information was involved.** `[LIST ONLY WHAT WAS ACTUALLY AFFECTED — for
> example: your name, your mobile number, and the dates and treatments of your
> visits]`.
>
> **What was not involved.** We do not hold health or medical information about
> any guest — we never have, by design. We do not hold your Emirates ID number,
> your passport number, your date of birth or your home address. We do not hold
> card numbers; card payments go through the bank's terminal and we only record
> the amount. `[ADJUST THIS LIST TO THE FACTS — do not claim anything you have
> not verified.]`
>
> **What we have done.** `[WHAT YOU DID — e.g. we ended every staff login
> session, changed every password and security key, and reported the incident to
> the UAE Data Office.]`
>
> **What you can do.** `[ONLY IF THERE IS SOMETHING USEFUL — e.g. be cautious
> about unexpected calls or messages claiming to be from us. We will never ask
> you for a payment or an ID number by message.]`
>
> **If you have questions.** Call `[NAME]` on `[DIRECT MOBILE]`, or call the spa
> on 052 510 8633 or 02 557 6533 any day between 11:00 am and 2:00 am. You can
> also come and speak to us at 250 Al Meena Street, Tower Block A/B, M-Floor, Al
> Zahiyah.
>
> We are sorry. You trusted us with your information and we did not protect it as
> we should have.
>
> `[NAME]`
> `[ROLE]`, BE RELAX Massage Center and Spa
> `[DATE]`

### Template — Arabic / النص العربي

> `[TRANSLATION TO BE REVIEWED — this template must be reviewed by a certified
> legal translator before use. Do not send it unreviewed. Fill the blanks in
> Arabic, not in English.]`
>
> <div dir="rtl" lang="ar">
>
> **إشعار مهم بشأن معلوماتك لدى «بي ريلاكس»**
>
> عزيزي/عزيزتي `[اسم الضيف]`،
>
> نكتب إليك لإبلاغك بمشكلة تتعلق بأمن المعلومات التي نحتفظ بها عنك. ونفضّل أن
> نخبرك مباشرة بدلاً من أن تعرف بالأمر من مصدر آخر.
>
> **ما الذي حدث.** بتاريخ `[التاريخ]`، `[وصف مبسّط لما حدث — جملة أو جملتان، بلا
> مصطلحات تقنية]`. اكتشفنا الأمر بتاريخ `[التاريخ]` وأوقفناه بتاريخ `[التاريخ
> والوقت]`.
>
> **ما المعلومات التي شملها الأمر.** `[اذكر فقط ما تأثر فعلاً — مثلاً: اسمك، ورقم
> هاتفك المتحرك، وتواريخ زياراتك والجلسات التي تلقيتها]`.
>
> **ما لم يشمله الأمر.** نحن لا نحتفظ بأي معلومات صحية أو طبية عن أي ضيف — ولم
> نفعل ذلك قط، وهذا قرار مقصود في تصميم نظامنا. ولا نحتفظ برقم هويتك الإماراتية،
> ولا برقم جواز سفرك، ولا بتاريخ ميلادك، ولا بعنوان سكنك. ولا نحتفظ بأرقام
> البطاقات؛ فالدفع بالبطاقة يتم عبر جهاز البنك ونحن نسجّل المبلغ فقط. `[عدّل هذه
> القائمة بما يطابق الوقائع — لا تدّعِ شيئاً لم تتحقق منه.]`
>
> **ما الذي فعلناه.** `[الإجراءات المتخذة — مثلاً: أنهينا جميع جلسات دخول
> الموظفين، وغيّرنا جميع كلمات المرور ومفاتيح الأمان، وأبلغنا مكتب الإمارات
> لحماية البيانات.]`
>
> **ما الذي يمكنك فعله.** `[فقط إن كان هناك إجراء مفيد — مثلاً: كن حذراً من أي
> اتصالات أو رسائل غير متوقعة تدّعي أنها منّا. لن نطلب منك أبداً دفعة مالية أو
> رقم هوية عبر رسالة.]`
>
> **إذا كانت لديك أسئلة.** اتصل بـ `[الاسم]` على الرقم `[رقم الهاتف المباشر]`، أو
> اتصل بالمركز على 8633 510 052 أو 6533 557 02 أي يوم بين الساعة 11:00 صباحاً
> و2:00 فجراً. ويمكنك أيضاً زيارتنا في 250 شارع الميناء، برج A/B، الطابق
> الميزانين، الزاهية.
>
> نعتذر إليك. لقد ائتمنتنا على معلوماتك ولم نحمها كما كان ينبغي.
>
> `[الاسم]`
> `[الصفة]`، مركز ومنتجع بي ريلاكس للمساج
> `[التاريخ]`
>
> </div>

### Rules for the notification

- **Do not minimise.** "A limited technical incident" tells a guest nothing and
  reads as evasion.
- **Do not overclaim.** If you do not know whether a particular record was read,
  say you do not know. A later correction is worse than initial uncertainty.
- **Say what was not involved** — especially that no health data exists in this
  system at all. It is true, it is unusual, and it is the most reassuring
  sentence available.
- **Give a person and a phone number**, not a form.
- **Apologise properly.** Once, plainly, without conditionals.

---

## Step 5 — Record

An incident that is not written down happened twice: once to your guests, and
again the next time, because nobody learned anything.

Create `docs/compliance/incidents/YYYY-MM-DD-<short-name>.md` containing:

| Section | Content |
|---|---|
| **Summary** | Three sentences. What happened, who was affected, what you did. |
| **Timeline** | Every event with a UTC timestamp and the Dubai time beside it: when it started, when you became aware, each containment step, each notification. |
| **Root cause** | Not "human error". What made the error possible? |
| **Data affected** | Categories, counts, and how you established them |
| **Containment actions** | Each step from [Step 1](#step-1--contain), with who ran it and when |
| **Notifications** | Data Office: date, time, reference number. Guests: how many, by what channel, when. Processors and police, if applicable. |
| **Evidence** | Where the exported logs and SQL output are stored |
| **Remediation** | What changes, with an owner and a date for each |
| **What this runbook got wrong** | Update this file. If a step was unclear at 02:00, it will be unclear again. |

Keep the incident record for **7 years**, alongside the financial audit log.

---

## Post-incident

Within two weeks of closing the incident:

- [ ] Force a password change for every staff account (`must_change_password = true`)
- [ ] Review the role matrix — did anyone have access they did not need?
- [ ] Confirm the retention job is scheduled and running — it reduces the blast
      radius of the next incident:
      ```sql
      SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'prune-attribution';
      SELECT count(*) AS unpruned FROM attribution_snapshots
       WHERE pruned_at IS NULL AND captured_at < now() - interval '90 days';
      -- unpruned should be 0
      ```
- [ ] Rehearse a database restore, and record the result
- [ ] Update the [data processing register](../data-processing-register.md) if
      anything about the processing changed
- [ ] Re-version the [privacy notice](../privacy-notice.md) if what you tell
      guests changed
- [ ] Review this runbook against what actually happened, and fix it

---

## Quick reference card

**Print this. Tape it inside the reception cupboard.**

```
BE RELAX — SUSPECTED DATA BREACH

1. Note the time (UTC and Dubai). Start a log.
2. Call the breach lead: [NAME] — [MOBILE]
   No answer in 15 min → deputy: [NAME] — [MOBILE]
   No answer → owner: [NAME] — [MOBILE]
3. Do NOT delete anything. Do NOT message guests.
4. Technical responder runs:
     psql "$DIRECT_URL" -c "UPDATE refresh_tokens SET revoked_at = now()
                             WHERE revoked_at IS NULL;"
     openssl rand -base64 32        → new JWT_SECRET on Railway
                                    → clear JWT_SECRET_PREVIOUS
     Supabase → reset DB password   → update DATABASE_URL (6543)
                                       and DIRECT_URL (5432)
   NEVER rotate ERASURE_SALT.
5. Call counsel before notifying anyone: [FIRM] — [MOBILE]
6. Internal target: UAE Data Office notified within 72 hours of awareness.

Spa: 052 510 8633 · 056 342 9399 · 02 557 6533 · open 11:00–02:00 daily
```
