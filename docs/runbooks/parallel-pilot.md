# The parallel pilot — running the CRM beside the paper, for two weeks

**Who this is for:** the manager on duty, and the owner.
**How long it lasts:** two weeks of trading, minimum.
**What ends it:** five consecutive nights where the numbers match.

For two weeks, BE RELAX runs the new system **and** the existing paper process at the same time.
Reception writes the sheet exactly as they do now. Everything also goes into the system. Every
night, before anybody goes home, the two are compared.

This is not a formality and it is not a training exercise. It is the only thing that catches the
class of mistake that only appears when real staff move at real speed on a full Friday. A booking
system that loses a Friday night's takings destroys more trust than it will earn back in a year.

Nothing is switched off until the numbers agree five nights running.

---

## 1. Before the first night

- [ ] Reception keeps using the paper sheet. Nothing about their evening changes.
- [ ] Every booking, payment and tip also goes into the system, **as it happens** — not typed up
      from the sheet at 01:00. A batch of bookings entered at the end of the night proves nothing
      except that somebody can copy.
- [ ] Every therapist working has a shift in the system for that night.
- [ ] The duty manager knows their login and can open **Reports → Reconciliation**
      (the page is at `/reconciliation`). Reception cannot open it, and that is deliberate:
      the person who counted the drawer all evening is not the person who signs it off.
- [ ] Put a stapler by the till. Every Z-report slip gets stapled to that night's paper sheet.

---

## 2. Every night, at close

Roughly fifteen minutes. In this order, and the order matters.

### Reception — before the manager touches a screen

1. **Check out every guest.** Nobody may still be "in a room" on the grid. A treatment left open
   is a tip nobody has recorded, which means the night's figures are still moving. The system will
   refuse to certify a night with an open session, and it is right to.
2. **Count the drawer.** Notes and coins, on paper, written on the sheet.
3. **Print the Z-report** from the card terminal. Staple the slip to the sheet.
4. **Count the treatments on the paper sheet.** Treatments that actually happened. Not
   cancellations. Not no-shows. This is the single most common reason a night reads one or two out.
5. **Total the cash tips handed straight to therapists**, if the sheet records them. This is money
   that never went into the till — do not add it to the drawer count.
6. Hand the sheet, the slip and the drawer count to the manager.

### The duty manager

7. Open **Reconciliation** and pick last night.
8. **Type in the paper figures first**, from the sheet in your hand. The close-out sheet with the
   system's own figures is further down the page — do not read it first and do not copy from it. A
   figure copied off the screen is not a check, and a fortnight of nights checked that way proves
   nothing.
9. Add a note if the night was unusual: *"one walk-in paid half cash half card"*. A note does not
   excuse a difference — if every figure agrees, the night is still recorded as **matched**.
10. Press **Compare with the system**.

You get one of three answers.

| Verdict | What it means | Does it count towards the five? |
|---|---|---|
| **Matched** | Every figure agreed. | Yes |
| **Matched, with a note** | Every figure agreed, and you explained something about the night. | Yes |
| **Did not match** | At least one figure is out. | **No — the run goes back to zero.** |

---

## 3. What each line means

| Line | Paper side | How exact it has to be |
|---|---|---|
| **Cash in the drawer** | The counted notes and coins | Exact, unless a cash tolerance has been set in writing (see §6) |
| **Card terminal total** | The Z-report total | **Exact, always.** The bank printed it; there is no counting error to forgive |
| **Sessions that took place** | Treatments on the paper sheet | Exact |
| **Cash tips handed to therapists** | Tips put straight into a therapist's hand | Optional. Compared only if you enter it |
| **Sessions left open** | Nothing to write | Must be zero |

Two things worth holding on to:

- **A tip handed straight to a therapist is not in the drawer.** The guest gave that money to the
  therapist; it never entered the till and BE RELAX never owed it. It has its own line. Adding it
  to the drawer count will make the cash line wrong by exactly that amount.
- **A tip added to the bill is in the drawer or on the terminal.** BE RELAX is holding that money
  and owes it to the therapist at the end of the month. That is a different thing, and keeping the
  two apart is the difference between paying a tip once and paying it twice.

---

## 4. A night that does not match

**Investigate it tonight. Not tomorrow.**

A difference you carry forward is a difference you will never find. By tomorrow there is another
night of bookings on top of it, and what was a ten-minute hunt for one slip becomes an
unanswerable question about two nights at once.

The screen tells you which line is out and by how much. Work down this list:

**If the card line is out** — it is almost never the terminal.
- A card payment typed into the system as cash, or the other way round.
- A payment entered against the wrong booking, or on the wrong night. Remember the trading night
  runs 11:00 to 02:00: **a booking at 01:30 belongs to the night before**, and so does its payment.
  Check the night before as well as this one.
- A refund put through the terminal but never recorded in the system.
- A slip from a different day stapled to this sheet.

**If the cash line is out**
- Recount the drawer. Do it once, properly, with somebody else present.
- Check the float: was it taken out of the drawer before counting?
- A tip handed straight to a therapist that got counted into the drawer total by mistake, or a tip
  added to the bill that was recorded as handed over.
- Money paid out of the till during the evening — a refund, petty cash — that was not recorded.
- The system names **who was taking cash at the desk** that night on the close-out sheet. Talk to
  them. A one-off is a mistake; the same name against four variances in a fortnight is a different
  conversation, and that is exactly what a fortnight of records is for.

**If the session count is out**
- Cancellations or no-shows counted on the paper sheet as treatments.
- A walk-in treated but never entered into the system.
- A booking after midnight filed to the wrong night. Check the night before.

**If a session was left open**
- Check the guest out on the grid, then reconcile the night again.

### Recording the outcome

When you have found it, reconcile the night **again** with the corrected figures. This writes a new
record beside the first — nothing is overwritten, and both attempts stay visible in the history.
That is deliberate: *"Friday took three attempts to match"* is exactly the kind of thing the pilot
exists to surface.

If you genuinely cannot find it, reconcile it again anyway with the true counted figures and a note
saying what you checked. An unexplained variance that is written down is a finding. One that is
quietly rounded away is a hole in the accounts that nobody will ever be able to close.

**A variance is never fixed by changing the figure you typed in.**

---

## 5. The streak — "can we switch over yet?"

At the top of the Reconciliation page: a number out of five, and a plain sentence.

Underneath it, the last fortnight as one cell per night:

- **teal** — matched
- **pale teal** — matched, with a note (still a match)
- **terracotta** — did not match
- **oat** — nobody reconciled that night

**What resets the streak to zero**

- A night that did not match.

**What stops the streak growing**

- A night nobody reconciled. A skipped night is not a pass — nobody can say it matched. The count
  stops there even if every night either side of it agreed, and the skipped nights tend to be the
  busy ones, which are the whole point. **If you skip a night, the run starts again from the next
  night you reconcile.**

**What does *not* reset it**

- A night that failed and was then investigated, corrected and reconciled again. That night matched
  in the end, and that is what the pilot is measuring. The failed attempt stays in the history.
- A note. A note is context, not a caveat.

**Ready to switch** means five consecutive trading nights matched. Not five matched nights spread
across a fortnight — five in a row.

---

## 6. The cash tolerance

Out of the box the drawer must agree **exactly**. That is the right default and it should stay
there for the pilot.

A tolerance can be set — `RECONCILIATION_CASH_TOLERANCE_FILS`, a whole number of fils — but treat
it as a decision the owner makes in writing, not a setting someone quietly widens at 02:00 because
a night will not balance. Two dirhams a night, forgiven silently, is over seven hundred dirhams a
year that nobody will ever be able to find. The tolerance in force is stored on every night that
was signed off under it, so widening it later cannot retroactively turn an old variance into a
match.

**The card line has no tolerance and never will.**

---

## 7. Switchover day

Do this when the streak reads five out of five, and not before.

- [ ] The **owner** agrees, on the day, looking at the streak. This is not the manager's call alone.
- [ ] Read back the whole fortnight in the history: how many nights needed a second attempt, and
      what they were. Five clean nights after nine messy ones is a different conversation from five
      clean nights after nine clean ones.
- [ ] Check every variance recorded during the pilot was explained. An open one is an open question.
- [ ] Tell reception the date, the day before. Nobody finds out at 23:00 that the paper stopped.
- [ ] **Keep writing the paper sheet for one more week** after switchover. It costs a few minutes a
      night and it is the only thing you will have if something surfaces in week three. Keep
      reconciling those nights too.
- [ ] After that week: file the paper sheets, keep the Z-report slips with the accounts, and stop.
- [ ] Keep reconciling **weekly** afterwards, on a Sunday, for as long as the business takes cash.
      §15.4 of the specification is honest about this: the system records that cash was collected,
      it cannot prove the cash reached the drawer. The drawer count is the control, and a control
      you stop performing is a control you do not have.

## 8. If the pilot is not converging

If two full weeks pass without a run of five, **do not extend it quietly and do not lower the bar.**
Stop, and read the history: the same line failing every night is a system problem or a training
problem, and it has a name. Different lines failing at random is usually a process problem — most
often things being entered at the end of the night instead of as they happen.

Fix the cause, then start the count again. The five nights exist to be earned.

---

## What is kept, and where

Every submission is stored permanently and **cannot be edited or deleted by anyone** — a correction
is always a new record beside the old one. Each one holds what the paper said, what the system said
at that moment, the difference, who signed it off, when, and who was taking cash at the desk that
night. The figures are frozen as they stood: a refund processed next week against an old payment
cannot silently un-match a night you have already signed off.

That record is the evidence for the switchover decision. Treat it as part of the accounts.
