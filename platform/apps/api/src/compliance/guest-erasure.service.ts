import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Guest } from '@prisma/client';
import { ErrorCode } from '@berelax/contracts';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction, AuditService } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import { apiError } from '../reservations/reservations.service';

/* ───────────────────────── the anonymised shell ───────────────────────── */

/** What the name column holds afterwards. Constant, so the shell is recognisable. */
export const ERASED_NAME = 'Erased guest';

/**
 * The visitor identifier a severed attribution snapshot gets. Not NULL, because
 * the column is NOT NULL and reporting still groups by it; the all-zero UUID is
 * the agreed "no one" value, and `prune_attribution()` in §5.6 writes the same.
 */
export const NULL_UUID = '00000000-0000-0000-0000-000000000000';

/** Prefix on the phone column of an erased guest. Matched with `startsWith`. */
export const ERASED_PHONE_PREFIX = 'erased:';

/**
 * Past Prisma's five-second default. This is one transaction across seven
 * tables, and a guest of ten years has a long tail in every one of them. Timing
 * out half way rolls back — correct, but it would also mean an erasure request
 * that cannot be honoured on a busy evening.
 */
const ERASURE_TRANSACTION = { timeout: 20_000 } as const;

/**
 * The phone number, replaced by something that can be recognised but not read.
 *
 * `sha256(phone + salt)`, truncated to 24 hex characters — 96 bits, which is far
 * past any collision worth worrying about across a guest book of a few thousand
 * numbers, and short enough to read in a console. The number itself is gone; what
 * survives is the ability to ask "is THIS number the one that was erased", which
 * is what keeps a blocked guest blocked and duplicate detection working. §11.4.
 *
 * The salt is what stops the hash being a rainbow-table lookup: UAE mobile
 * numbers are +9715 followed by eight digits, a keyspace of a hundred million,
 * which an unsalted SHA-256 exhausts in seconds.
 *
 * ERASURE_SALT MUST NEVER BE ROTATED. Every already-erased record was hashed
 * with the salt in force at the time and there is no number left to re-hash with
 * a new one, so a rotation orphans every one of them: the blocked guest walks
 * back in, the duplicate is created again, and nothing in the system can tell you
 * it happened. Rotate JWT_SECRET freely; leave this one alone for ever. §12.5.
 */
export function erasedPhoneToken(phone: string, salt: string): string {
  return `${ERASED_PHONE_PREFIX}${createHash('sha256').update(`${phone}${salt}`).digest('hex').slice(0, 24)}`;
}

/* ───────────────────────── presentation ───────────────────────── */

export interface GuestErasureView {
  guestId: string;
  anonymisedAt: string;
  /** Stable for this number for ever. The only trace of it that remains. */
  phoneToken: string;
  /** Cleared, not merely flagged: name, phone, email, notes. */
  identityFieldsCleared: readonly string[];
  consentsDeleted: number;
  attributionSnapshotsSevered: number;
  outboundClicksDeleted: number;
  bookingRequestsAnonymised: number;
  reservationNotesCleared: number;
  /**
   * NOT deleted, and not deletable through any endpoint. The right to erasure
   * yields where the controller must retain data under another legal obligation,
   * and UAE tax law requires five years of accounting records. §11.4, §11.6.
   */
  financialRecordsRetained: {
    reservations: number;
    payments: number;
    tips: number;
    ledgerEntries: number;
  };
}

/* ───────────────────────── the service ───────────────────────── */

/**
 * PDPL Article 15, implemented the only way it can be implemented in a business
 * that also has to keep books.
 *
 * **An erasure here is an anonymisation, not a `DELETE`.** Somebody will
 * eventually open this file because a guest asked to be deleted and the rows are
 * still there, so the reasoning is written down rather than assumed:
 *
 *   The right to erasure is not absolute. It yields where the controller must
 *   retain the data to comply with another legal obligation, and UAE tax law
 *   requires accounting records to be kept for five years. The reconciliation is
 *   that the TRANSACTION is retained while the PERSON is severed from it — the
 *   reservation keeps its amounts, its dates, its therapist and its audit trail,
 *   and its `guest_id` now points at a shell with no name, no number, no email
 *   and no notes. The books still balance; the guest is no longer identifiable
 *   from them. The privacy notice has to say this in plain language, because a
 *   guest who asks to be deleted and later learns that records remain will not
 *   be reassured by Article 15. §11.4.
 *
 * Everything below happens in ONE transaction with the audit write on the same
 * `tx`: a half-erased guest — name gone, consents still standing — is a worse
 * state than either end of the operation.
 *
 * This is also the ONLY path by which a guest is anonymised. The retention job
 * (§11.6) calls this same method rather than writing its own update, because two
 * ways to anonymise a guest is two definitions of what "erased" means, and the
 * one that drifts is always the one nobody is reading.
 */
@Injectable()
export class GuestErasureService {
  private readonly salt: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    // Read once at construction. `validateEnv` has already refused to boot if it
    // is missing, or if production is still carrying the development default.
    this.salt = config.getOrThrow<string>('ERASURE_SALT');
  }

  async erase(
    guestId: string,
    reason: string,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<GuestErasureView> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.loadForErasure(tx, guestId, actor.branchId);
      const now = new Date();
      const phoneToken = await this.uniquePhoneToken(tx, before, actor.branchId);

      await tx.guest.update({
        where: { id: before.id },
        data: {
          fullName: ERASED_NAME,
          phone: phoneToken,
          email: null,
          notes: null,
          anonymisedAt: now,
          // Soft-deleted as well as anonymised, so the shell leaves reception's
          // guest book entirely — `findMany` and `findOne` both filter on it.
          deletedAt: now,
        },
      });

      // Consent records are DELETED rather than kept. §11.6 retains proof of
      // consent for three years after withdrawal because the proof protects the
      // business against a marketing complaint — but an erasure request is the
      // guest asking for the relationship itself to end, and a consent row holds
      // their IP address. There is no complaint left to defend once the person is
      // gone from the guest book, so the row goes with them. §11.4.
      const { count: consentsDeleted } = await tx.guestConsent.deleteMany({
        where: { guestId: before.id },
      });

      const severed = await this.severAttribution(tx, before.id, now);
      const bookingRequestsAnonymised = await this.anonymiseBookingRequests(
        tx,
        before,
        phoneToken,
        actor.branchId,
      );

      // A reservation's free text is neither an amount nor a date, so the
      // five-year obligation does not reach it — and free text is exactly where
      // a person hides ("call Amira on the other number"). The row stays; the
      // prose on it does not.
      const { count: reservationNotesCleared } = await tx.reservation.updateMany({
        where: { guestId: before.id, branchId: actor.branchId, notes: { not: null } },
        data: { notes: null },
      });

      const financialRecordsRetained = await this.countRetained(tx, before.id, actor.branchId);

      await this.audit.write(tx, ctx, {
        action: AuditAction.GUEST_ERASED,
        entityType: 'Guest',
        entityId: before.id,
        // Never the values themselves: the audit log is not the place to keep a
        // copy of the thing we were asked to destroy. §9.6.
        beforeState: {
          hadEmail: before.email !== null,
          hadNotes: before.notes !== null,
          wasBlocked: before.isBlocked,
          createdAt: before.createdAt.toISOString(),
        },
        afterState: {
          anonymised: true,
          reason,
          consentsDeleted,
          attributionSnapshotsSevered: severed.snapshots,
          outboundClicksDeleted: severed.clicks,
          bookingRequestsAnonymised,
          reservationNotesCleared,
          financialRecordsRetained,
        },
      });

      return {
        guestId: before.id,
        anonymisedAt: now.toISOString(),
        phoneToken,
        identityFieldsCleared: ['fullName', 'phone', 'email', 'notes'],
        consentsDeleted,
        attributionSnapshotsSevered: severed.snapshots,
        outboundClicksDeleted: severed.clicks,
        bookingRequestsAnonymised,
        reservationNotesCleared,
        financialRecordsRetained,
      };
    }, ERASURE_TRANSACTION);
  }

  /**
   * Branch in the `where`, so a guest from another branch is indistinguishable
   * from one that never existed — and `deletedAt` deliberately NOT in it, because
   * an already-erased guest must be found in order to be refused.
   */
  private async loadForErasure(
    tx: Prisma.TransactionClient,
    guestId: string,
    branchId: string,
  ): Promise<Guest> {
    const guest = await tx.guest.findFirst({ where: { id: guestId, branchId } });
    if (!guest) {
      throw new NotFoundException(apiError(ErrorCode.NOT_FOUND, 'No such guest in this branch.'));
    }
    // Idempotent by refusal, not by silence. Erasing twice would hash the token
    // AGAIN — `erased:sha256("erased:abc..." + salt)` — and that second token
    // matches nothing, so the blocked guest quietly becomes unblockable and the
    // first erasure's audit entry becomes unverifiable.
    if (guest.anonymisedAt) {
      throw new ConflictException(
        apiError(
          ErrorCode.GUEST_ALREADY_ERASED,
          'This guest was already erased. There is nothing left to remove.',
          { anonymisedAt: guest.anonymisedAt.toISOString() },
        ),
      );
    }
    return guest;
  }

  /**
   * The token, disambiguated if it is somehow already taken.
   *
   * `(branch_id, phone)` is unique, and the token is a pure function of the
   * number — so a number erased, given again by a new walk-in, and erased a
   * second time would collide. Rejecting the second erasure over a uniqueness
   * artefact would be refusing a lawful request for an internal reason, so the
   * second one takes a suffix instead. The prefix is unchanged, which is what
   * every lookup matches on: `phone LIKE erasedPhoneToken(number) || '%'`.
   */
  private async uniquePhoneToken(
    tx: Prisma.TransactionClient,
    guest: Guest,
    branchId: string,
  ): Promise<string> {
    const token = erasedPhoneToken(guest.phone, this.salt);
    const taken = await tx.guest.findFirst({
      where: { branchId, phone: { startsWith: token }, NOT: { id: guest.id } },
      select: { id: true },
    });
    return taken ? `${token}.${guest.id.slice(0, 8)}` : token;
  }

  /**
   * Attribution is severed from the person IMMEDIATELY, even inside the 90-day
   * window §11.6 otherwise allows. A `visitorId` is a unique identifier tied to
   * behaviour — personal data with no name attached (§11.2) — so it cannot
   * outlive the person by three months just because the retention job has not
   * come round yet.
   *
   * What survives is what the channel report reads: the source, medium and
   * campaign of the first and last touch. That is the same reduction
   * `prune_attribution()` performs at 90 days, so the two paths leave a snapshot
   * in exactly one shape rather than two. The individual touches, the landing
   * path and the visitor id all go.
   */
  private async severAttribution(
    tx: Prisma.TransactionClient,
    guestId: string,
    now: Date,
  ): Promise<{ snapshots: number; clicks: number }> {
    const linked = await tx.attributionSnapshot.findMany({
      where: {
        OR: [
          { reservations: { some: { guestId } } },
          { bookingRequest: { is: { guestId } } },
        ],
      },
      select: { id: true, visitorId: true, firstTouch: true, lastTouch: true },
    });
    if (linked.length === 0) return { snapshots: 0, clicks: 0 };

    for (const snapshot of linked) {
      await tx.attributionSnapshot.update({
        where: { id: snapshot.id },
        data: {
          visitorId: NULL_UUID,
          touches: [],
          firstTouch: channelOnly(snapshot.firstTouch),
          lastTouch: channelOnly(snapshot.lastTouch),
          landingPath: null,
          prunedAt: now,
        },
      });
    }

    // The click log is keyed on the same visitor id and is not linked to the
    // guest by anything else, so severing the snapshot alone would leave a
    // behavioural trail that used to be reachable. It is deleted rather than
    // blanked: a click row with no visitor is not worth keeping.
    const visitorIds = [...new Set(linked.map((s) => s.visitorId))].filter((v) => v !== NULL_UUID);
    const clicks = visitorIds.length
      ? (await tx.outboundClick.deleteMany({ where: { visitorId: { in: visitorIds } } })).count
      : 0;

    return { snapshots: linked.length, clicks };
  }

  /**
   * `booking_requests` keeps the guest's name, number, email and message as
   * COLUMNS OF ITS OWN — the website form has no guest row to point at when it
   * arrives. Severing `guests` alone would leave the erased guest's phone number
   * sitting in plain text in the enquiry inbox, which is not an erasure by any
   * reading of Article 15.
   *
   * An enquiry is not an accounting record, so nothing here is retained for tax:
   * the row stays only so the inbox and the channel report still count it.
   *
   * Requests are matched by `guestId` AND by the phone number, because a request
   * that came off the public form before reception linked it to a guest record
   * carries the number without carrying the link.
   */
  private async anonymiseBookingRequests(
    tx: Prisma.TransactionClient,
    guest: Guest,
    phoneToken: string,
    branchId: string,
  ): Promise<number> {
    const { count } = await tx.bookingRequest.updateMany({
      where: {
        branchId,
        OR: [{ guestId: guest.id }, { guestPhone: guest.phone }],
      },
      data: {
        guestName: ERASED_NAME,
        guestPhone: phoneToken,
        guestEmail: null,
        message: null,
      },
    });
    return count;
  }

  /** What stayed, and is reported back so the manager can see that it stayed. */
  private async countRetained(
    tx: Prisma.TransactionClient,
    guestId: string,
    branchId: string,
  ): Promise<GuestErasureView['financialRecordsRetained']> {
    const reservationIds = (
      await tx.reservation.findMany({ where: { guestId, branchId }, select: { id: true } })
    ).map((r) => r.id);

    if (reservationIds.length === 0) {
      return { reservations: 0, payments: 0, tips: 0, ledgerEntries: 0 };
    }

    const [payments, tips, ledgerEntries] = await Promise.all([
      tx.payment.count({ where: { reservationId: { in: reservationIds } } }),
      tx.tip.count({ where: { reservationId: { in: reservationIds } } }),
      tx.therapistPayoutLedger.count({ where: { reservationId: { in: reservationIds } } }),
    ]);
    return { reservations: reservationIds.length, payments, tips, ledgerEntries };
  }
}

/**
 * A touch reduced to its channel. Source, medium and campaign are what the ROI
 * report groups on; the term, the referrer and the landing URL are where a
 * query string carries an identifier, so they do not survive.
 */
function channelOnly(touch: Prisma.JsonValue): Prisma.InputJsonValue {
  const t = (touch ?? {}) as Record<string, unknown>;
  return {
    source: typeof t.source === 'string' ? t.source : null,
    medium: typeof t.medium === 'string' ? t.medium : null,
    campaign: typeof t.campaign === 'string' ? t.campaign : null,
  } as Prisma.InputJsonValue;
}
