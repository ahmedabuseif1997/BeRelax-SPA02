# BE RELAX — Privacy Notice / إشعار الخصوصية

| | |
|---|---|
| **Version** | `1.0-draft` |
| **Date** | 17 September 2026 |
| **Status** | **DRAFT — not yet in force.** Not to be published until UAE counsel has reviewed it and the `[TO BE COMPLETED]` blanks are filled. |
| **Applies to** | The BE RELAX CRM and booking platform, and the berelax.ae website |

> **The version string matters.** Every consent the system records stores the exact
> version of the notice the guest was shown, in `guest_consents.policy_version`.
> While this notice is a draft, that string is `1.0-draft`, and **no consent from a
> real guest may be captured against a draft version.** On sign-off the string
> becomes `1.0` and the date is updated. Test data captured against `1.0-draft`
> must be deleted before launch.
>
> **Three places must carry the same string**, or the proof of consent is
> worthless: this document, `window.BERELAX_PRIVACY_VERSION` in `index.html`
> (which `assets/js/consent.js` writes into the browser alongside the visitor's
> choice — it currently falls back to `"2026-01"` if the global is not set), and
> the `policyVersion` sent to `POST /v1/guests/:id/consents` from the desk. Bump
> them together, in one commit, and never reuse a number.

> **This document is not legal advice.** It was written by the engineering team to
> describe, accurately, what the system does. It must be reviewed by UAE counsel
> before publication. See [What counsel must review](#what-counsel-must-review-before-this-goes-live).

---

# English

## Who we are

BE RELAX Massage Center and Spa is the **controller** of the personal data
described here. That means we decide what is collected and why, and we are the
ones answerable for it.

| | |
|---|---|
| **Name** | BE RELAX Massage Center and Spa |
| **Address** | 250 Al Meena Street, Tower Block A/B, M-Floor, Al Zahiyah (Al Mina), E14, Abu Dhabi, United Arab Emirates |
| **Mobile / WhatsApp** | 052 510 8633 (+971 52 510 8633) |
| **Mobile** | 056 342 9399 (+971 56 342 9399) |
| **Landline** | 02 557 6533 (+971 2 557 6533) |
| **Open** | Every day, 11:00 am – 2:00 am |
| **Trade licence** | `[TO BE COMPLETED: Abu Dhabi DED trade licence number]` |
| **Legal entity name** | `[TO BE COMPLETED: the registered name on the trade licence, if different from the trading name]` |
| **Privacy contact** | `[TO BE COMPLETED: name of the person responsible for privacy questions]`, reachable on `[TO BE COMPLETED: direct phone number]` |
| **Email for privacy requests** | `[TO BE COMPLETED: e.g. privacy@berelax.ae — this address must exist and be monitored before launch]` |

## What we collect

Everything in this list is a real field in our system. There is nothing collected
that is not named here.

### When you book, or when you visit

| What | Required? | Why we have it |
|---|---|---|
| Your name | Yes | To know whose booking it is and to greet you |
| Your mobile number | Yes | To confirm the booking, to call you if the therapist runs late, and to find your record when you return |
| Your email address | **Optional** | Only if you give it. We do not ask for it at the desk. |
| Preference notes | No | Short operational notes: *"prefers firm pressure"*, *"no jasmine oil"*, *"requests Maya"*. Capped at 500 characters by the system. |
| Your booking history | Automatic | Dates, treatments, durations, which therapist, whether you attended, cancelled or did not arrive |
| What you paid | Automatic | Amount, method (cash, card, bank transfer, voucher, complimentary), the date, and which member of staff took it |
| Tips you leave | Automatic | The amount, and whether it went to the therapist directly or through us |
| Card terminal slip number | If you pay by card | A reference number typed in by reception so a payment can be matched to a terminal slip |
| Whether you are blocked | Rarely | If a guest is not welcome back, we mark the record. It is not a deletion and it can be reversed. |

### When you send an enquiry through the website

The website form creates an **enquiry**, not a booking. It holds your name, your
mobile number, an optional email, the treatment and date you asked about, and
anything you typed in the message box. Someone calls you back to turn it into a
real booking.

### When you use the website

| What | Only if you consent? | Notes |
|---|---|---|
| A visitor ID (a random number stored in your browser and in a cookie called `brx_vid`) | **Yes** | Lets us tell one visit from another and see which adverts and search results bring people to us |
| Where you came from | **Yes** | Google, Instagram, a referral, a campaign name, an advert click ID (`gclid`, `fbclid`) |
| Which page you landed on | **Yes** | The path only — `/` or `/services` — never the full web address with its query string |
| When you tapped WhatsApp or Call | **Yes** | We log the click, the page it happened on and the campaign. **We do not read your WhatsApp conversation and we never will.** |

Your visitor ID is a unique identifier tied to your behaviour, so we treat it as
personal data even though your name is not attached to it.

### If we photograph you

We ask separately, in person, and record the answer. We do not photograph guests
without asking.

### If you have a staff login

Staff accounts hold an email address, a name, a role, a hashed password, when the
account last signed in, and — for each active session — the browser type and the
IP address the session was started from. This is how a lost phone is dealt with.

## What we do **not** collect

This is a deliberate design decision, and it is worth being plain about.

- **No health or medical information.** Not pregnancy, not injuries, not blood
  pressure, not medication, not allergies, not surgery history. There is no
  column for it, and the system actively rejects notes containing medical terms.
  If a health question ever matters for a treatment, it is asked verbally or kept
  on paper in a locked cabinet on site — it never enters this system. See
  [Why we refuse to store health information](#why-we-refuse-to-store-health-information).
- **No Emirates ID number, no passport number, no visa details.**
- **No date of birth, no nationality, no gender, no home address.**
- **No card numbers.** We do not process payments. Card payments go through the
  terminal from the bank; we only record the amount and the slip number.
- **No location tracking.** The website does not ask for your location, and the
  browser permission is switched off at the server.
- **No advertising trackers from other companies.** No Google Analytics, no
  Facebook pixel, no third-party advertising cookies. The only measurement is our
  own, first-party, and consent-based.

> **One thing to be careful about.** The website's message box currently invites
> you to mention injuries. If you write health information there it will be
> stored in that message until reception handles the enquiry. **We are changing
> that prompt** — see [Known issues](#known-issues-being-fixed-before-launch) —
> but until it is changed, please tell us about injuries on the phone or when you
> arrive rather than typing them into the form.

## Why we are allowed to hold it

Under the UAE Personal Data Protection Law, every category of data needs a lawful
basis. Ours are:

| What | Lawful basis | In plain terms |
|---|---|---|
| Name, phone, booking history, preference notes | **Performance of a contract** | We cannot give you a massage at 9pm on Thursday without knowing who you are and how to reach you. No consent is needed for this, and you cannot decline it and still book. |
| Payment and tip records | **Legal obligation** (tax and accounting) **and contract** | UAE tax law requires a business to keep its accounting records. See [If you ask us to delete your data](#if-you-ask-us-to-delete-your-data). |
| Marketing messages | **Consent** | Separate, opt-in, and withdrawable at any time. It is never bundled into the booking form's submit button. Declining costs you nothing. |
| Analytics and attribution identifiers | **Consent** | You are asked before anything is stored. Declining is one click and the website works exactly the same. |
| Photographs of guests | **Consent** | Asked separately, in person, recorded against your record. |
| Staff records, payroll and payouts | **Employment contract and legal obligation** | |

## Cookies and analytics — and the fact that declining changes nothing

When you first visit berelax.ae you are asked whether we may measure where our
visitors come from.

- **Accept** and **Decline** are the same size and the same prominence. There is
  no greyed-out refusal.
- Declining is **one click**, not a settings journey.
- You can change your mind at any time from the link in the footer of every page.
  Withdrawing is as easy as giving.
- **The website works fully if you decline.** You can read the menu, see the
  prices, submit the booking form, tap WhatsApp and call us. The only thing that
  stops is our measurement of where visitors come from.
- The booking form and the WhatsApp buttons are **never** blocked behind the
  banner. Making you accept analytics before you can book would not be real
  consent anyway.

There are two cookies. `berelax_consent` remembers your answer and is set
whichever way you answer. `brx_vid` is the visitor ID and is set **only** if you
accept.

## Where your data is kept

Your data is **stored and processed outside the United Arab Emirates.**

| | |
|---|---|
| **Database** | Supabase (managed PostgreSQL), hosted on Amazon Web Services in `[TO BE COMPLETED: the region actually provisioned — Frankfurt, eu-central-1, is the intended choice]` |
| **Country** | `[TO BE COMPLETED: Germany, if Frankfurt is chosen]` |
| **Safeguard relied on** | `[TO BE COMPLETED BY COUNSEL: adequacy determination, or a data processing addendum containing appropriate contractual undertakings under PDPL Arts. 22–23, or your express consent]` |

**Why we cannot simply answer this today, honestly:** the PDPL permits transfers
abroad where the destination has been recognised by the UAE Data Office as
offering adequate protection, or — where it has not — under an appropriate
contractual undertaking or with your express consent. Whether a given country or
a given Supabase region carries a published adequacy determination is a question
of the current state of UAE regulatory practice, and the PDPL's Executive
Regulations, which set the procedural detail, must be checked at the time this
notice is published. We would rather leave this blank and have counsel fill it in
than print a comfortable answer that is wrong.

What we can say now: the choice of region is deliberate and recorded, we hold
signed data processing agreements with every provider, and the database is
ordinary PostgreSQL with no vendor-specific features — so if UAE law ever
requires the data to be held inside the country, it moves without a rebuild.

Our other providers are listed in full, with what each can see, in our
[data processing register](./data-processing-register.md).

## How long we keep it

| What | How long | What happens then |
|---|---|---|
| Your name, phone and email | **3 years** after your last visit | Replaced with an anonymous placeholder. Your phone number is replaced with a one-way code so that, if you were blocked, you stay blocked — but the number itself is gone. |
| Your booking records | **5 years** | Your name is already removed by then; the booking itself stays, without a person attached |
| Payments, tips and the payout ledger | **5 years minimum** (tax law) | Reviewed and archived. Never deleted while any dispute is open. |
| The financial audit trail | **7 years** | Moved to cold storage |
| Website analytics (visitor ID, where you came from) | **90 days** | The identifiers are stripped. Only the channel — "Google", "Instagram" — is kept, with no way back to a person. |
| WhatsApp and call button clicks | **90 days** | Deleted |
| Marketing consent records | Until you withdraw, then **3 years** | Being able to prove that you did consent, and when you stopped, is itself a legal requirement |
| Staff login sessions | **30 days** after they expire | Deleted |
| System logs containing IP addresses | **90 days** | Deleted |

## If you ask us to delete your data

**Read this part before you ask, because the honest answer has two halves.**

**The half you would expect.** We remove your name, your email and your
preference notes. We replace your phone number with a one-way code that cannot be
turned back into a number. We delete your consent records. We clear the free-text
notes on your bookings. We go back through the website enquiry inbox and blank
out your name, number, email and anything you typed in the message box — even for
enquiries that never became a booking. We cut the link between you and everything
the website recorded about how you found us, and delete your WhatsApp and call
button clicks, even if that data is younger than 90 days. Your record leaves
reception's guest book entirely.

When a manager does this, the system hands them an itemised receipt of exactly
what was removed and what was kept. If you want to see it, ask — it is yours.

**The half you should know about before you ask.** *We keep the financial
records.* The booking stays — the date, the treatment, the amount paid, the tip,
which therapist, and the audit trail behind it. What we delete is **you**: the
row that once held your name now holds a placeholder, and the payment record
points at that placeholder instead of at a person.

**Why.** UAE tax and accounting law requires a business to keep its books for
five years. The right to erasure is not absolute — it gives way where the law
requires records to be kept. If we deleted the payment line, the books would no
longer balance, and a tax audit would find a hole.

So the trade we make is this: **the transaction survives, the person does not.**
After an erasure request, our records still show that a 60-minute massage was
paid for at 22:15 on a Tuesday in March. They no longer show that it was you.

If that is not what you wanted to hear, we would rather you heard it now than
discovered it afterwards.

## Your rights

Under the UAE Personal Data Protection Law you have the right to:

- **Be told** what we hold about you and what we do with it — this notice
- **Get a copy** of it, including your bookings, payments, tips and consents
- **Take it with you** in a machine-readable file
- **Correct** anything that is wrong
- **Have it erased**, subject to the financial records explained above
- **Restrict** or **object to** how we use it
- **Withdraw consent** at any time, for marketing and for analytics, without
  giving a reason and without it affecting anything else

### How to actually exercise them

Not "contact us". Here are the real routes:

| Route | Detail |
|---|---|
| **In person** | Come to the front desk at 250 Al Meena Street, Tower Block A/B, M-Floor, Al Zahiyah, any day between 11:00 am and 2:00 am. Ask for the manager on duty and say you have a data request. Bring the mobile number you booked with. |
| **By phone** | Call **052 510 8633** or **02 557 6533** during opening hours and ask for the manager on duty. |
| **By WhatsApp** | Message **052 510 8633**. Write "data request" and we will call you back. |
| **In writing** | `[TO BE COMPLETED: the monitored email address for privacy requests]` |
| **Responsible person** | `[TO BE COMPLETED: name]`, `[TO BE COMPLETED: direct phone number]` |

**What happens next.** We will confirm your identity — usually by calling the
mobile number on the booking — because handing someone else's booking history to
a stranger who knows their name would be the worse failure. Only a manager or the
owner can action an access or erasure request; reception cannot. We aim to
respond within **30 days**, and we will tell you if it will take longer and why.

**Two of these are quicker than the rest:**

- **Withdrawing consent** — for marketing, for analytics, or for photographs — is
  done at the front desk on the spot, by whoever is there. It takes one action,
  no manager, no form, no reason needed. Withdrawing is as easy as giving,
  because the law requires that and because anything else is a dark pattern. The
  record that you once consented is kept, so that if you ever ask why you
  received a message last March we can show you the answer.
- **Asking for a copy** produces a single machine-readable file containing your
  guest record, your consents, every booking, every payment, every tip, your
  website enquiries and any attribution data linked to your visits — with a list,
  inside the file, of what is *not* in it and why. It is one document that
  answers both "show me what you have" and "give it to me so I can take it
  elsewhere".

**If you are not satisfied**, you may complain to the UAE Data Office, the
federal authority responsible for personal data protection. Their current contact
route should be checked at `[TO BE COMPLETED: the UAE Data Office's published
complaint channel at the time of publication]`.

## Why we refuse to store health information

Massage intake forms routinely ask about pregnancy, injuries, blood pressure,
recent surgery and allergies. We decided not to.

Two reasons. First, health data is **sensitive personal data** under the PDPL and
carries stricter obligations. Second, and more sharply: UAE Federal Law No. 2 of
2019, on the use of information technology in the health field, requires health
data generated in the UAE to be stored and processed inside the UAE and restricts
sending it abroad. Our database is not in the UAE.

**Whether that law reaches a wellness spa that is not a licensed health facility
is genuinely arguable** — we are not asserting that it does, and it is a question
for lawyers rather than for engineers. We simply chose not to have the argument.
Storing no health data at all means the question never arises.

If a health questionnaire ever becomes genuinely necessary, it stays on paper, in
a locked cabinet on site, and never enters this system.

## Children

We do not knowingly take bookings for anyone under 18 without a parent or
guardian present, and we do not hold data about children. If you believe we hold
a child's data, tell us using any of the routes above and we will remove it.

## Security

In plain terms: the connection is encrypted, the database is encrypted, passwords
are hashed and never stored in readable form, staff only see what their role
needs, every action that touches money is recorded with who did it and from
where, and the record of those actions cannot be edited or deleted by anyone —
including us. Backups are taken daily and a restore is rehearsed every quarter,
because an untested backup is a hope rather than a plan.

## Known issues, being fixed before launch

We would rather list these than pretend they do not exist.

1. **The website's message box invites health information.** The prompt currently
   reads "Injuries, pressure preference, preferred therapist…". It is being
   changed, and the system does not yet screen that field for medical terms the
   way it screens the guest record. Until then, please do not type health
   information into the form.
2. **The consent banner is not live on the site yet.** Until it is, no analytics
   script runs at all — so nothing is collected — but the banner must be in place
   before the CRM goes live.
3. **Some of the retention schedule above is newly built and has not yet run
   against real data.** The automatic anonymisation of guest records at three
   years works and is tested, but it has never had a three-year-old record to
   act on, because there are none yet. The first real run will be deliberate and
   checked, not silent. See the [register](./data-processing-register.md) for the
   full list of what is built, what is not, and what is still open.

## Changes to this notice

If we change this notice we will publish the new version with a new version
number and date, and the footer of the website will link to it. Consent records
store which version you were shown, so we can always tell what you actually
agreed to.

| Version | Date | Change |
|---|---|---|
| `1.0-draft` | 17 September 2026 | First draft. Not in force. |

## What counsel must review before this goes live

This notice is an engineering description of a real system. It is **not legal
advice** and it has not been reviewed by a lawyer. Before publication, UAE
counsel must confirm:

1. **The current status of the PDPL's Executive Regulations**, which set the
   procedural detail for several obligations referred to here — including the
   mechanics of cross-border transfer and of data subject requests. Much of what
   this notice says about *process* depends on them.
2. **The cross-border transfer basis** — whether the chosen hosting country
   carries a UAE Data Office adequacy determination, and if not, which alternative
   safeguard is being relied on and whether the provider agreements support it.
3. **The wording of the consent requests** for marketing, analytics and
   photography, and whether they meet PDPL Art. 6.
4. **Whether Federal Law No. 2 of 2019 on ICT in the health field applies to this
   business at all.** We assume it might and design around it. Counsel should
   confirm whether that caution is necessary or merely prudent.
5. **The five-year retention claim for financial records** against the applicable
   UAE tax and commercial-companies record-keeping rules, and whether any longer
   period applies.
6. **The complaint route to the UAE Data Office** as currently published.
7. **Whether a Data Protection Officer must be appointed** for a business of this
   size and processing profile.

---
---

<div dir="rtl" lang="ar">

# العربية

> **ملاحظة على الترجمة:** النص العربي أدناه ترجمة كاملة للنص الإنجليزي وليس
> نقلاً حرفياً للحروف. ومع ذلك، فهذه وثيقة قانونية، ويجب أن يراجعها مترجم قانوني
> معتمد ومستشار قانوني إماراتي قبل النشر. المقاطع التي تحمل علامة
> `[TRANSLATION TO BE REVIEWED]` هي المواضع التي تكون فيها المصطلحات القانونية
> محل خلاف حقيقي أو التي نرى فيها أن الصياغة تحتاج إلى تدقيق متخصص. **في حال
> وجود أي اختلاف بين النصين قبل مراجعة المستشار القانوني، يُعتمد النص الإنجليزي.**

| | |
|---|---|
| **الإصدار** | `1.0-draft` |
| **التاريخ** | 17 سبتمبر 2026 |
| **الحالة** | **مسودة — غير سارية.** لا تُنشر قبل مراجعة المستشار القانوني الإماراتي واستكمال الحقول الفارغة. |

## من نحن

مركز ومنتجع «بي ريلاكس» للمساج هو **المتحكّم** في البيانات الشخصية الموضحة هنا.
أي أننا الجهة التي تقرر ما يُجمع ولماذا، ونحن المسؤولون عنه.

| | |
|---|---|
| **الاسم** | مركز ومنتجع بي ريلاكس للمساج |
| **العنوان** | 250 شارع الميناء، برج A/B، الطابق الميزانين، الزاهية (المينا)، E14، أبوظبي، الإمارات العربية المتحدة |
| **الهاتف المتحرك / واتساب** | 8633 510 052 |
| **هاتف متحرك** | 9399 342 056 |
| **الهاتف الأرضي** | 6533 557 02 |
| **ساعات العمل** | يومياً من 11:00 صباحاً حتى 2:00 فجراً |
| **الرخصة التجارية** | `[TO BE COMPLETED: رقم الرخصة التجارية]` |
| **مسؤول الخصوصية** | `[TO BE COMPLETED: الاسم]`، على الرقم `[TO BE COMPLETED: رقم هاتف مباشر]` |
| **البريد الإلكتروني لطلبات الخصوصية** | `[TO BE COMPLETED]` |

## ما الذي نجمعه

كل بند في هذه القائمة يقابله حقل فعلي في نظامنا. لا نجمع شيئاً غير مذكور هنا.

### عند الحجز أو الزيارة

| البيان | إلزامي؟ | سبب الاحتفاظ به |
|---|---|---|
| الاسم | نعم | لمعرفة صاحب الحجز ولاستقبالك باسمك |
| رقم الهاتف المتحرك | نعم | لتأكيد الحجز، وللاتصال بك إذا تأخر المعالج، وللعثور على سجلك عند عودتك |
| البريد الإلكتروني | **اختياري** | فقط إن قدّمته. لا نطلبه عند الاستقبال. |
| ملاحظات التفضيلات | لا | ملاحظات تشغيلية قصيرة: «يفضّل الضغط القوي»، «بدون زيت الياسمين»، «يطلب مايا». يحدّها النظام بـ 500 حرف. |
| سجل الحجوزات | تلقائي | التواريخ، الجلسات، المدد، المعالج، وما إذا حضرت أو ألغيت أو لم تحضر |
| المبالغ المدفوعة | تلقائي | المبلغ، وطريقة الدفع (نقداً، بطاقة، تحويل بنكي، قسيمة، مجاني)، والتاريخ، ومن استلمه من الموظفين |
| الإكراميات | تلقائي | المبلغ، وما إذا كان قد سُلّم للمعالج مباشرة أم عن طريقنا |
| رقم إيصال جهاز البطاقة | عند الدفع بالبطاقة | رقم مرجعي يُدخله الاستقبال لمطابقة الدفعة مع إيصال الجهاز |
| وضع الحظر | نادراً | إذا لم يعد الضيف مرحّباً به نضع علامة على السجل. هذا ليس حذفاً ويمكن التراجع عنه. |

### عند إرسال استفسار عبر الموقع

نموذج الموقع ينشئ **استفساراً** وليس حجزاً. يتضمن اسمك، ورقم هاتفك المتحرك،
وبريداً إلكترونياً اختيارياً، والجلسة والتاريخ اللذين سألت عنهما، وأي نص كتبته
في خانة الرسالة. يتصل بك أحد الموظفين لتحويله إلى حجز فعلي.

### عند استخدام الموقع الإلكتروني

| البيان | بموافقتك فقط؟ | ملاحظات |
|---|---|---|
| معرّف زائر (رقم عشوائي يُحفظ في متصفحك وفي ملف تعريف ارتباط اسمه `brx_vid`) | **نعم** | يتيح لنا التمييز بين الزيارات ومعرفة أي الإعلانات ونتائج البحث تقودك إلينا |
| مصدر وصولك إلينا | **نعم** | جوجل، إنستجرام، إحالة، اسم حملة إعلانية، معرّف نقرة إعلان (`gclid`، `fbclid`) |
| الصفحة التي دخلت منها | **نعم** | المسار فقط — مثل `/` أو `/services` — ولا نحفظ العنوان الكامل بمعاملاته |
| نقرك على زر واتساب أو الاتصال | **نعم** | نسجّل النقرة والصفحة والحملة. **لا نقرأ محادثتك على واتساب ولن نفعل أبداً.** |

معرّف الزائر رقم فريد مرتبط بسلوكك، ولذلك نتعامل معه كبيانات شخصية حتى وإن لم
يكن اسمك مرتبطاً به.

### التصوير الفوتوغرافي

نطلب إذنك بشكل منفصل وشخصياً، ونسجّل إجابتك. لا نصوّر الضيوف دون استئذان.

### إذا كان لديك حساب موظف

حسابات الموظفين تتضمن بريداً إلكترونياً واسماً ودوراً وكلمة مرور مُجزّأة
(مشفّرة باتجاه واحد)، وتاريخ آخر دخول، ولكل جلسة نشطة نوع المتصفح وعنوان
بروتوكول الإنترنت الذي بدأت منه الجلسة. هذا ما يتيح التصرف عند فقدان هاتف.

## ما الذي **لا** نجمعه

هذا قرار تصميمي مقصود، ويستحق التوضيح الصريح.

- **لا نجمع أي معلومات صحية أو طبية.** لا عن الحمل، ولا الإصابات، ولا ضغط الدم،
  ولا الأدوية، ولا الحساسية، ولا العمليات الجراحية السابقة. لا يوجد حقل لذلك في
  النظام، والنظام يرفض فعلياً أي ملاحظة تتضمن مصطلحات طبية. وإذا كان هناك سؤال
  صحي مهم لجلسة ما، فإنه يُطرح شفهياً أو يُحفظ على ورق في خزانة مغلقة في المركز
  — ولا يدخل هذا النظام أبداً.
- **لا نجمع رقم الهوية الإماراتية، ولا رقم جواز السفر، ولا بيانات التأشيرة.**
- **لا نجمع تاريخ الميلاد، ولا الجنسية، ولا النوع، ولا عنوان السكن.**
- **لا نجمع أرقام البطاقات.** نحن لا نعالج المدفوعات. الدفع بالبطاقة يتم عبر
  جهاز البنك؛ ونحن نسجّل المبلغ ورقم الإيصال فقط.
- **لا نتتبع موقعك الجغرافي.** الموقع الإلكتروني لا يطلب موقعك، وإذن المتصفح
  معطّل من الخادم.
- **لا نستخدم أدوات تتبع إعلانية من شركات أخرى.** لا جوجل أناليتكس، ولا بكسل
  فيسبوك، ولا ملفات تعريف ارتباط إعلانية تابعة لجهات خارجية. القياس الوحيد قياسنا
  نحن، من الطرف الأول، وقائم على موافقتك.

> **نقطة تستدعي الانتباه.** خانة الرسالة في الموقع تدعوك حالياً إلى ذكر الإصابات.
> إذا كتبت معلومات صحية هناك فستُحفظ في تلك الرسالة حتى يعالج الاستقبال الاستفسار.
> **نحن بصدد تغيير هذه الصياغة**، لكن إلى أن يتم ذلك، نرجو إخبارنا بالإصابات
> هاتفياً أو عند وصولك بدلاً من كتابتها في النموذج.

## الأساس القانوني للاحتفاظ بالبيانات

`[TRANSLATION TO BE REVIEWED — مصطلحات الأسس القانونية أدناه تحتاج تدقيق مترجم
قانوني معتمد لضمان مطابقتها لصياغة المرسوم بقانون اتحادي رقم 45 لسنة 2021]`

| البيان | الأساس القانوني | بعبارة بسيطة |
|---|---|---|
| الاسم والهاتف وسجل الحجوزات وملاحظات التفضيلات | **تنفيذ عقد** | لا يمكننا تقديم جلسة في التاسعة مساء الخميس دون معرفة من أنت وكيف نصل إليك. لا تلزم موافقة لذلك، ولا يمكن رفضه مع إتمام الحجز. |
| سجلات المدفوعات والإكراميات | **التزام قانوني** (ضريبي ومحاسبي) **وعقد** | يلزم القانون الضريبي في الدولة المنشأة بالاحتفاظ بسجلاتها المحاسبية. |
| الرسائل التسويقية | **موافقة** | منفصلة، اختيارية، ويمكن سحبها في أي وقت. ولا تُدمج أبداً في زر إرسال نموذج الحجز. رفضها لا يكلفك شيئاً. |
| معرّفات التحليلات ومصادر الزيارات | **موافقة** | نسألك قبل حفظ أي شيء. الرفض بنقرة واحدة والموقع يعمل كما هو تماماً. |
| صور الضيوف | **موافقة** | تُطلب منفصلة وشخصياً وتُسجّل في سجلك. |
| سجلات الموظفين والرواتب والمستحقات | **عقد العمل والتزام قانوني** | |

## ملفات تعريف الارتباط والتحليلات — والرفض لا يغيّر شيئاً

عند زيارتك الأولى لموقع berelax.ae نسألك ما إذا كان يمكننا قياس مصادر زيارات
موقعنا.

- زرّا **الموافقة** و**الرفض** بالحجم نفسه والبروز نفسه. لا يوجد زر رفض باهت.
- الرفض بـ **نقرة واحدة**، لا عبر سلسلة إعدادات.
- يمكنك تغيير رأيك في أي وقت من الرابط في أسفل كل صفحة. سحب الموافقة سهل بقدر
  منحها.
- **الموقع يعمل بالكامل إن رفضت.** يمكنك قراءة قائمة الجلسات والأسعار، وإرسال
  نموذج الحجز، والنقر على واتساب، والاتصال بنا. الشيء الوحيد الذي يتوقف هو قياسنا
  لمصادر الزيارات.
- نموذج الحجز وأزرار واتساب **لا تُحجب أبداً** خلف الإشعار. إجبارك على قبول
  التحليلات قبل الحجز لن يكون موافقة حقيقية أصلاً.

هناك ملفا تعريف ارتباط: `berelax_consent` يحفظ إجابتك ويُضبط مهما كانت، و
`brx_vid` هو معرّف الزائر ولا يُضبط **إلا** إذا وافقت.

## أين تُحفظ بياناتك

تُحفظ بياناتك وتُعالج **خارج دولة الإمارات العربية المتحدة.**

| | |
|---|---|
| **قاعدة البيانات** | Supabase (قاعدة بيانات PostgreSQL مُدارة) مستضافة على Amazon Web Services في `[TO BE COMPLETED: المنطقة المستخدمة فعلياً — فرانكفورت eu-central-1 هي الخيار المقصود]` |
| **الدولة** | `[TO BE COMPLETED: ألمانيا، في حال اختيار فرانكفورت]` |
| **الضمانة المعتمدة** | `[TO BE COMPLETED BY COUNSEL: قرار كفاية، أو ملحق معالجة بيانات يتضمن تعهدات تعاقدية مناسبة بموجب المادتين 22 و23 من المرسوم بقانون، أو موافقتك الصريحة]` |

**لماذا لا نستطيع الإجابة اليوم بصدق:** يسمح القانون بنقل البيانات إلى الخارج
متى اعترف مكتب الإمارات لحماية البيانات بأن الدولة المستقبِلة توفّر حماية كافية،
أو — في حال عدم وجود هذا الاعتراف — بموجب تعهد تعاقدي مناسب أو بموافقتك الصريحة.
وما إذا كانت دولة بعينها أو منطقة استضافة بعينها مشمولة بقرار كفاية منشور هو
مسألة تتعلق بالوضع الراهن للممارسة التنظيمية في الدولة، ويجب التحقق من اللائحة
التنفيذية للمرسوم بقانون عند نشر هذا الإشعار. ونفضّل ترك هذا الحقل فارغاً ليملأه
المستشار القانوني على أن نطبع إجابة مريحة وخاطئة.

ما يمكننا قوله الآن: اختيار المنطقة مقصود وموثّق، ولدينا اتفاقيات معالجة بيانات
موقّعة مع كل مزوّد، وقاعدة البيانات هي PostgreSQL قياسية دون أي خصائص خاصة
بمزوّد بعينه — فإذا اقتضى القانون الإماراتي يوماً حفظ البيانات داخل الدولة،
فبالإمكان نقلها دون إعادة بناء النظام.

## مدة الاحتفاظ

| البيان | المدة | ثم ماذا |
|---|---|---|
| الاسم والهاتف والبريد الإلكتروني | **3 سنوات** من آخر زيارة | يُستبدل بعنصر نائب مجهول. ويُستبدل رقم هاتفك برمز أحادي الاتجاه حتى يبقى المحظور محظوراً — أما الرقم نفسه فيختفي. |
| سجلات الحجوزات | **5 سنوات** | يكون اسمك قد أُزيل قبلها؛ ويبقى الحجز دون شخص مرتبط به |
| المدفوعات والإكراميات وسجل المستحقات | **5 سنوات على الأقل** (القانون الضريبي) | تُراجع وتُؤرشف. ولا تُحذف أبداً ما دام هناك نزاع قائم. |
| سجل التدقيق المالي | **7 سنوات** | يُنقل إلى تخزين بارد |
| تحليلات الموقع (معرّف الزائر ومصدر الزيارة) | **90 يوماً** | تُجرَّد المعرّفات ويبقى اسم القناة فقط — «جوجل»، «إنستجرام» — دون أي طريق للعودة إلى شخص |
| نقرات أزرار واتساب والاتصال | **90 يوماً** | تُحذف |
| سجلات الموافقة التسويقية | حتى سحبها، ثم **3 سنوات** | القدرة على إثبات أنك وافقت ومتى توقفت هي بذاتها متطلب قانوني |
| جلسات دخول الموظفين | **30 يوماً** بعد انتهائها | تُحذف |
| سجلات النظام التي تتضمن عناوين IP | **90 يوماً** | تُحذف |

## إذا طلبت حذف بياناتك

**اقرأ هذا الجزء قبل أن تطلب، لأن الإجابة الصادقة لها شقّان.**

**الشق المتوقَّع.** نحذف اسمك وبريدك الإلكتروني وملاحظات تفضيلاتك. ونستبدل رقم
هاتفك برمز أحادي الاتجاه لا يمكن إعادته إلى رقم. ونحذف سجلات موافقتك. ونمسح
النصوص الحرة المدوّنة على حجوزاتك. ونعود إلى صندوق استفسارات الموقع فنمحو اسمك
ورقمك وبريدك وكل ما كتبته في خانة الرسالة — حتى للاستفسارات التي لم تتحول إلى
حجز. ونقطع الصلة بينك وبين كل ما سجّله الموقع عن كيفية وصولك إلينا، ونحذف نقراتك
على أزرار واتساب والاتصال، حتى لو كانت تلك البيانات أحدث من 90 يوماً. ويخرج سجلك
من دفتر ضيوف الاستقبال تماماً.

وعند تنفيذ ذلك، يسلّم النظام المدير بياناً مفصّلاً بما أُزيل بالضبط وما بقي. وإن
أردت الاطلاع عليه فاطلبه — فهو حقك.

**الشق الذي ينبغي أن تعرفه قبل أن تطلب.** *نحتفظ بالسجلات المالية.* يبقى الحجز —
التاريخ والجلسة والمبلغ المدفوع والإكرامية والمعالج وسجل التدقيق المرتبط به.
الذي نحذفه هو **أنت**: السجل الذي كان يحمل اسمك يصبح عنصراً نائباً، ويشير سجل
الدفع إلى ذلك العنصر النائب بدلاً من شخص.

**لماذا.** يُلزم القانون الضريبي والمحاسبي في الدولة المنشآت بحفظ دفاترها خمس
سنوات. والحق في المحو ليس مطلقاً — فهو يتراجع حيث يوجب القانون حفظ السجلات. ولو
حذفنا بند الدفع لاختلّت الدفاتر ولوجد التدقيق الضريبي ثغرة.

فالمقايضة التي نجريها هي: **تبقى المعاملة، ويختفي الشخص.** بعد طلب المحو، تُظهر
سجلاتنا أن جلسة مدتها 60 دقيقة دُفع ثمنها في الساعة 22:15 من يوم ثلاثاء في مارس.
ولم تعد تُظهر أن ذلك كان أنت.

وإن لم يكن هذا ما تودّ سماعه، فنحن نفضّل أن تسمعه الآن لا أن تكتشفه لاحقاً.

## حقوقك

`[TRANSLATION TO BE REVIEWED — أسماء الحقوق أدناه يجب أن تطابق صياغة المواد
13–17 من المرسوم بقانون بالضبط]`

بموجب قانون حماية البيانات الشخصية في دولة الإمارات، لك الحق في:

- **أن تُعلَم** بما نحتفظ به عنك وبما نفعله به — وهذا الإشعار
- **الحصول على نسخة** منه، تشمل حجوزاتك ومدفوعاتك وإكرامياتك وموافقاتك
- **نقلها** في ملف قابل للقراءة آلياً
- **تصحيح** أي معلومة خاطئة
- **محوها**، مع مراعاة السجلات المالية الموضحة أعلاه
- **تقييد** استخدامها أو **الاعتراض** عليه
- **سحب الموافقة** في أي وقت، للتسويق وللتحليلات، دون إبداء سبب ودون أن يؤثر ذلك
  على أي شيء آخر

### كيف تمارس حقوقك فعلياً

لا نقول «تواصل معنا». هذه هي الطرق الحقيقية:

| الطريقة | التفاصيل |
|---|---|
| **شخصياً** | تفضّل إلى مكتب الاستقبال في 250 شارع الميناء، برج A/B، الطابق الميزانين، الزاهية، أي يوم بين 11:00 صباحاً و2:00 فجراً. اطلب المدير المناوب وأخبره بأن لديك طلباً يتعلق ببياناتك. أحضر رقم الهاتف الذي حجزت به. |
| **هاتفياً** | اتصل على **8633 510 052** أو **6533 557 02** خلال ساعات العمل واطلب المدير المناوب. |
| **عبر واتساب** | راسلنا على **8633 510 052** واكتب «طلب بيانات» وسنعاود الاتصال بك. |
| **كتابياً** | `[TO BE COMPLETED: البريد الإلكتروني المخصص لطلبات الخصوصية]` |
| **الشخص المسؤول** | `[TO BE COMPLETED: الاسم]`، `[TO BE COMPLETED: رقم هاتف مباشر]` |

**ماذا يحدث بعد ذلك.** سنتحقق من هويتك — عادةً بالاتصال برقم الهاتف المسجّل في
الحجز — لأن تسليم سجل حجوزات شخص ما إلى غريب يعرف اسمه سيكون الخطأ الأفدح. ولا
يستطيع تنفيذ طلب الاطلاع أو المحو إلا المدير أو المالك؛ الاستقبال لا يستطيع.
ونهدف إلى الرد خلال **30 يوماً**، وسنخبرك إن كان الأمر سيستغرق أطول ولماذا.

**طلبان من هذه أسرع من غيرهما:**

- **سحب الموافقة** — للتسويق أو للتحليلات أو للتصوير — يتم عند مكتب الاستقبال في
  حينه، على يد من هو موجود. إجراء واحد، بلا مدير، وبلا نموذج، وبلا إبداء سبب.
  فسحب الموافقة سهل بقدر منحها، لأن القانون يوجب ذلك ولأن ما عداه تضليل. ويبقى
  سجل أنك وافقت سابقاً، حتى إذا سألت يوماً لماذا وصلتك رسالة في مارس الماضي
  استطعنا أن نريك الجواب.
- **طلب نسخة من بياناتك** يُنتج ملفاً واحداً قابلاً للقراءة آلياً يتضمن سجلك
  كضيف، وموافقاتك، وكل حجز، وكل دفعة، وكل إكرامية، واستفساراتك عبر الموقع، وأي
  بيانات عن مصدر وصولك مرتبطة بزياراتك — ويتضمن الملف نفسه قائمة بما **ليس** فيه
  وسبب ذلك. وهو مستند واحد يجيب على «أرني ما لديكم» و«سلّموني إياه لآخذه إلى جهة
  أخرى» معاً.

**وإذا لم تكن راضياً**، يمكنك تقديم شكوى إلى مكتب الإمارات لحماية البيانات، وهي
الجهة الاتحادية المعنية بحماية البيانات الشخصية. ينبغي التحقق من قناة التواصل
المعتمدة لديهم على `[TO BE COMPLETED: قناة الشكاوى المنشورة لمكتب الإمارات لحماية
البيانات وقت النشر]`.

## لماذا نرفض حفظ المعلومات الصحية

نماذج استقبال المساج تسأل عادةً عن الحمل والإصابات وضغط الدم والعمليات الجراحية
الحديثة والحساسية. ونحن قررنا ألا نفعل.

لسببين. الأول أن البيانات الصحية **بيانات شخصية حساسة** بموجب قانون حماية
البيانات الشخصية وتخضع لالتزامات أشد. والثاني، وهو الأهم: يوجب القانون الاتحادي
رقم 2 لسنة 2019 في شأن استخدام تكنولوجيا المعلومات والاتصالات في المجالات الصحية
حفظ ومعالجة البيانات الصحية المتولدة داخل الدولة داخلها، ويقيّد إرسالها إلى
الخارج. وقاعدة بياناتنا ليست داخل الدولة.

**وما إذا كان ذلك القانون يشمل منتجعاً صحياً غير مرخص كمنشأة صحية فمسألة قابلة
للجدل فعلاً** — ونحن لا نؤكد أنه يشملنا، وهي مسألة للمحامين لا للمهندسين. وقد
اخترنا ببساطة ألا ندخل في ذلك الجدل. فعدم حفظ أي بيانات صحية على الإطلاق يعني أن
السؤال لا يُطرح أصلاً.

وإذا أصبح استبيان صحي ضرورياً فعلاً يوماً ما، فسيبقى على ورق، في خزانة مغلقة في
المركز، ولن يدخل هذا النظام.

## الأطفال

لا نقبل عن علم حجوزات لمن هم دون 18 عاماً دون حضور ولي أمر، ولا نحتفظ ببيانات عن
الأطفال. وإذا كنت تعتقد أننا نحتفظ ببيانات طفل، فأخبرنا عبر أي من الطرق أعلاه
وسنزيلها.

## الأمن

بعبارة بسيطة: الاتصال مشفّر، وقاعدة البيانات مشفّرة، وكلمات المرور مُجزّأة ولا
تُحفظ أبداً بصيغة قابلة للقراءة، ولا يرى الموظفون إلا ما يقتضيه دورهم، وكل إجراء
يمسّ المال يُسجَّل مع بيان من قام به ومن أين، وسجل تلك الإجراءات لا يمكن لأحد
تعديله أو حذفه — بما في ذلك نحن. وتُؤخذ نسخ احتياطية يومياً ويُختبر الاسترجاع كل
ثلاثة أشهر، لأن نسخة احتياطية غير مُختبَرة أمنية لا خطة.

## مسائل معروفة، قيد المعالجة قبل الإطلاق

نفضّل ذكرها على التظاهر بعدم وجودها.

1. **خانة الرسالة في الموقع تدعو إلى ذكر معلومات صحية.** الصياغة الحالية «إصابات،
   تفضيل الضغط، المعالج المفضّل…». وهي قيد التغيير، والنظام لا يفحص هذا الحقل بعد
   بحثاً عن المصطلحات الطبية كما يفحص سجل الضيف. وإلى أن يتغير، نرجو عدم كتابة
   معلومات صحية في النموذج.
2. **إشعار الموافقة غير مفعّل على الموقع بعد.** وإلى أن يُفعَّل، لا يعمل أي برنامج
   تحليلات إطلاقاً — فلا يُجمع شيء — لكن يجب تفعيله قبل إطلاق نظام إدارة العلاقات.
3. **جزء من جدول الاحتفاظ أعلاه حديث البناء ولم يُطبَّق بعد على بيانات حقيقية.**
   فالإخفاء التلقائي لهوية الضيف بعد ثلاث سنوات يعمل وتم اختباره، لكنه لم يصادف
   بعد سجلاً عمره ثلاث سنوات لأنه لا يوجد أي سجل كذلك حتى الآن. وأول تطبيق فعلي
   سيكون بقرار ومراجعة، لا بصمت.

## تعديلات هذا الإشعار

إذا عدّلنا هذا الإشعار سننشر النسخة الجديدة برقم إصدار وتاريخ جديدين، وسيشير
رابط في أسفل الموقع إليها. وتحفظ سجلات الموافقة رقم النسخة التي عُرضت عليك، حتى
نعرف دائماً ما وافقت عليه فعلاً.

| الإصدار | التاريخ | التعديل |
|---|---|---|
| `1.0-draft` | 17 سبتمبر 2026 | المسودة الأولى. غير سارية. |

## إخلاء مسؤولية

**هذه الوثيقة ليست استشارة قانونية.** كتبها فريق الهندسة لوصف ما يفعله النظام
فعلاً، ويجب أن يراجعها مستشار قانوني إماراتي قبل النشر — بما في ذلك التحقق من
الوضع الراهن للائحة التنفيذية للمرسوم بقانون اتحادي رقم 45 لسنة 2021.

</div>
