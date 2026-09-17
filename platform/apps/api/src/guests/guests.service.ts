import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Guest, GuestConsent } from '@prisma/client';
import { z } from 'zod';
import {
  ConsentType,
  CreateGuestConsentDto,
  CreateGuestDto,
  ErrorCode,
  ReservationStatus,
  UpdateGuestDto,
  normaliseUaePhone,
} from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import { apiError } from '../reservations/reservations.service';

/* ───────────────────────── the health-data screen ───────────────────────── */

/**
 * §11.5 is a hard stop: this CRM stores no medical or health information at
 * all, because UAE Federal Law No. 2 of 2019 keeps health data generated in the
 * UAE inside the UAE and there is no UAE region under this database.
 *
 * The 500-character CHECK constraint stops `notes` growing into an intake form;
 * this list stops it *starting* as one. It is deliberately short and
 * unambiguous — a check that rejected "no jasmine oil" would teach reception to
 * route around it within a week, and then it protects nothing.
 */
// The medical screen now lives in `../common/medical-screen`, because the same
// rule has to hold for `reservations.notes` and `booking_requests.message` too —
// free text does not care which table it lands in. Re-exported here so existing
// callers and their tests keep working.
import { assertNotMedical } from '../common/medical-screen';
export { assertNotMedical };


/* ───────────────────────── presentation ───────────────────────── */

export interface GuestView {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  notes: string | null;
  isBlocked: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Counts and dates, never a lifetime spend. A per-guest total is a total, and
 * §6.4 keeps totals away from the desk — the person taking the cash is not the
 * person auditing it.
 */
export interface GuestVisitSummary {
  total: number;
  completed: number;
  cancelled: number;
  noShow: number;
  firstVisitAt: string | null;
  lastVisitAt: string | null;
  nextVisitAt: string | null;
}

export interface GuestDetailView extends GuestView {
  visits: GuestVisitSummary;
}

export interface GuestConsentView {
  id: string;
  type: ConsentType;
  granted: boolean;
  grantedAt: string;
  withdrawnAt: string | null;
  source: string;
  policyVersion: string;
}

/**
 * What is true NOW, per consent type — the single question a marketing sender
 * asks before it sends anything. Derived from the latest record of that type, so
 * a withdrawal turns it false without deleting the evidence that it was ever true.
 */
export interface ConsentStateView {
  granted: boolean;
  /** When the state last changed: granted at, or withdrawn at. */
  since: string | null;
  /** The notice version the guest actually saw, when consent stands. */
  policyVersion: string | null;
  source: string | null;
}

/**
 * The consent ledger for one guest: what stands today, and everything that ever
 * did. §11.6 keeps the history for three years past a withdrawal because proof
 * that consent EXISTED is itself a legal necessity — the day a guest says they
 * never agreed to anything, the withdrawn row is the answer.
 */
export interface GuestConsentLedgerView {
  guestId: string;
  current: Record<ConsentType, ConsentStateView>;
  /** Newest first. Nothing is ever removed from this by a withdrawal. */
  history: GuestConsentView[];
}

export function presentGuest(guest: Guest): GuestView {
  return {
    id: guest.id,
    fullName: guest.fullName,
    phone: guest.phone,
    email: guest.email,
    notes: guest.notes,
    isBlocked: guest.isBlocked,
    createdAt: guest.createdAt.toISOString(),
    updatedAt: guest.updatedAt.toISOString(),
  };
}

export function presentConsent(consent: GuestConsent): GuestConsentView {
  return {
    id: consent.id,
    type: consent.type as ConsentType,
    granted: consent.granted,
    grantedAt: consent.grantedAt.toISOString(),
    withdrawnAt: consent.withdrawnAt?.toISOString() ?? null,
    source: consent.source,
    policyVersion: consent.policyVersion,
  };
}

/* ───────────────────────── query contract ───────────────────────── */

export const listGuestsQuerySchema = z.object({
  /** Matched against the name and the phone number at once — reception has one search box. */
  search: z.string().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListGuestsQuery = z.infer<typeof listGuestsQuerySchema>;

const DEFAULT_LIMIT = 50;

/* ───────────────────────── the service ───────────────────────── */

/**
 * Nothing here writes to `financial_audit_log`. That table records what changed
 * about the MONEY (§9.6), and none of its actions is a guest edit; the two
 * guest entries it does carry — GUEST_DATA_EXPORTED and GUEST_ERASED — belong
 * to the compliance endpoints in §7.5, not to reception's daily typing.
 */
@Injectable()
export class GuestsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One search box, two columns. The phone fragment is normalised the same way
   * a stored number is, so typing "050 123" finds `+971501234567` — otherwise
   * the search misses every guest reception typed in the other format.
   */
  async findMany(query: ListGuestsQuery, actor: AuthUser): Promise<GuestView[]> {
    const where: Prisma.GuestWhereInput = { branchId: actor.branchId, deletedAt: null };

    if (query.search) {
      const term = query.search.trim();
      where.OR = [
        { fullName: { contains: term, mode: 'insensitive' } },
        { phone: { contains: normaliseUaePhone(term) } },
      ];
    }

    const rows = await this.prisma.guest.findMany({
      where,
      orderBy: { fullName: 'asc' },
      take: query.limit ?? DEFAULT_LIMIT,
    });
    return rows.map(presentGuest);
  }

  async findOne(id: string, actor: AuthUser): Promise<GuestDetailView> {
    const guest = await this.findInBranch(id, actor.branchId);

    // One range scan on (guest_id, starts_at). A guest has tens of visits over
    // the years, not thousands, so summarising in code beats five count queries.
    const visits = await this.prisma.reservation.findMany({
      where: { guestId: guest.id, branchId: actor.branchId },
      select: { status: true, startsAt: true },
      orderBy: { startsAt: 'asc' },
    });

    return { ...presentGuest(guest), visits: summariseVisits(visits) };
  }

  async create(dto: CreateGuestDto, actor: AuthUser): Promise<GuestView> {
    assertNotMedical(dto.notes);

    try {
      const guest = await this.prisma.guest.create({
        data: {
          // From the TOKEN, never the body. §6.6.
          branchId: actor.branchId,
          fullName: dto.fullName,
          // Already normalised by uaePhoneSchema, so the (branch, phone) unique
          // index sees one spelling of a number and the returning guest is found.
          phone: dto.phone,
          email: dto.email ?? null,
          notes: dto.notes ?? null,
        },
      });
      return presentGuest(guest);
    } catch (error) {
      throw this.asPhoneConflict(error, dto.phone);
    }
  }

  async update(id: string, dto: UpdateGuestDto, actor: AuthUser): Promise<GuestView> {
    assertNotMedical(dto.notes);
    const guest = await this.findInBranch(id, actor.branchId);

    try {
      const updated = await this.prisma.guest.update({
        where: { id: guest.id },
        data: {
          ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.email !== undefined ? { email: dto.email } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        },
      });
      return presentGuest(updated);
    } catch (error) {
      throw this.asPhoneConflict(error, dto.phone ?? guest.phone);
    }
  }

  /**
   * Blocking is reception's tool for a guest who is not welcome back. It is not
   * a delete: the visits, the payments and the audit trail all stay, and the
   * row can be unblocked by whoever turns out to have been wrong.
   */
  async setBlocked(id: string, isBlocked: boolean, actor: AuthUser): Promise<GuestView> {
    const guest = await this.findInBranch(id, actor.branchId);
    const updated = await this.prisma.guest.update({ where: { id: guest.id }, data: { isBlocked } });
    return presentGuest(updated);
  }

  /**
   * Proof of consent is the record plus the version of the notice they actually
   * saw plus where the request came from — a bare boolean proves nothing. §11.3.
   */
  async recordConsent(
    id: string,
    dto: CreateGuestConsentDto,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<GuestConsentView> {
    const guest = await this.findInBranch(id, actor.branchId);
    const now = new Date();

    const consent = await this.prisma.guestConsent.create({
      data: {
        guestId: guest.id,
        type: dto.type,
        granted: dto.granted,
        grantedAt: now,
        // A refusal or a withdrawal is the same row with `granted` false; stamping
        // it now is what makes "consent ended at 21:40 on the 16th" answerable.
        withdrawnAt: dto.granted ? null : now,
        source: dto.source,
        policyVersion: dto.policyVersion,
        // From the request, never the body: an address the caller nominates is
        // not evidence of anything.
        ipAddress: ctx.ipAddress ?? null,
      },
    });
    return presentConsent(consent);
  }

  /**
   * Everything recorded, and what it adds up to. §7.5.
   *
   * RECEPTIONIST+ for the same reason `recordConsent` is: the desk is where a
   * guest says "actually, stop texting me", and a consent state reception can
   * write but not read is a consent state nobody can act on.
   */
  async listConsents(id: string, actor: AuthUser): Promise<GuestConsentLedgerView> {
    const guest = await this.findInBranch(id, actor.branchId);
    return this.buildConsentLedger(this.prisma, guest.id);
  }

  /**
   * Withdrawal, PDPL Art. 6: **as easy to withdraw as it was to give**.
   *
   * Granting is one authenticated POST, so withdrawal is one authenticated POST
   * at the same role — not a manager escalation, not a form, not a reason field.
   * The moment this returns, marketing has stopped: `current.MARKETING.granted`
   * is false and that is the flag any sender reads.
   *
   * The row is UPDATED, never deleted. `withdrawnAt` is the whole point — §11.6
   * keeps consent records for three years past a withdrawal because the proof
   * that consent once existed is what answers a complaint about the messages that
   * were sent while it stood. Deleting the record to honour the withdrawal would
   * destroy the evidence that the sending was lawful.
   *
   * Nothing is written to `financial_audit_log`: that table records what changed
   * about the MONEY (§9.6), and the consent row with its own timestamps is
   * already a complete, dated record of this event.
   */
  async withdrawConsent(
    id: string,
    type: ConsentType,
    actor: AuthUser,
  ): Promise<GuestConsentLedgerView> {
    const guest = await this.findInBranch(id, actor.branchId);

    return this.prisma.$transaction(async (tx) => {
      const recorded = await tx.guestConsent.findMany({ where: { guestId: guest.id, type } });

      if (recorded.length === 0) {
        throw new NotFoundException(
          apiError(
            ErrorCode.CONSENT_NOT_FOUND,
            'No consent of that type was ever recorded for this guest, so there is nothing to withdraw.',
            { type },
          ),
        );
      }

      const standing = recorded.filter((c) => c.granted && c.withdrawnAt === null);
      if (standing.length === 0) {
        // Not a failure of the guest's wish — it is already what they asked for.
        // Said plainly so the desk knows the click did nothing rather than
        // assuming it did something.
        throw new ConflictException(
          apiError(
            ErrorCode.CONSENT_ALREADY_WITHDRAWN,
            'That consent is already withdrawn or was refused. Nothing changed.',
            { type },
          ),
        );
      }

      // updateMany, because a guest can hold more than one standing grant of the
      // same type — one taken at the desk, one off the website form. Withdrawing
      // one of them and leaving the other standing is how a guest who asked to be
      // left alone keeps receiving messages.
      await tx.guestConsent.updateMany({
        where: { guestId: guest.id, type, granted: true, withdrawnAt: null },
        data: { withdrawnAt: new Date() },
      });

      return this.buildConsentLedger(tx, guest.id);
    });
  }

  /**
   * The ledger, from the rows. `current` is derived on every read rather than
   * stored on `guests`: a cached consent flag is a second source of truth, and
   * the copy that drifts is the one that sends a message to somebody who said no.
   */
  private async buildConsentLedger(
    client: Prisma.TransactionClient | PrismaService,
    guestId: string,
  ): Promise<GuestConsentLedgerView> {
    const rows = await client.guestConsent.findMany({
      where: { guestId },
      orderBy: { grantedAt: 'desc' },
    });

    const current = {} as Record<ConsentType, ConsentStateView>;
    for (const type of Object.values(ConsentType)) {
      // Rows are newest first, so the first of each type is the state in force.
      const latest = rows.find((r) => r.type === type);
      current[type] = latest
        ? {
            granted: latest.granted && latest.withdrawnAt === null,
            since: (latest.withdrawnAt ?? latest.grantedAt).toISOString(),
            policyVersion: latest.granted && !latest.withdrawnAt ? latest.policyVersion : null,
            source: latest.source,
          }
        : // Never asked is not the same as refused, but it has the same effect:
          // no consent, so no processing that depends on one.
          { granted: false, since: null, policyVersion: null, source: null };
    }

    return { guestId, current, history: rows.map(presentConsent) };
  }

  /**
   * Branch and soft-delete live in the `where`, not in a check afterwards, so a
   * guest from another branch is indistinguishable from one that never existed.
   */
  private async findInBranch(id: string, branchId: string): Promise<Guest> {
    const guest = await this.prisma.guest.findFirst({ where: { id, branchId, deletedAt: null } });
    if (!guest) {
      throw new NotFoundException(apiError(ErrorCode.NOT_FOUND, 'No such guest in this branch.'));
    }
    return guest;
  }

  /**
   * The (branch, phone) unique index is the arbiter, not a pre-flight lookup:
   * two receptionists typing the same walk-in at once would both pass a check
   * and only one would pass the index. `guests` has no other unique column, so
   * a P2002 here is that one.
   */
  private asPhoneConflict(error: unknown, phone: string): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return new ConflictException(
        apiError(
          ErrorCode.GUEST_PHONE_TAKEN,
          'Another guest in this branch already has that phone number. Open their record instead.',
          { phone },
        ),
      );
    }
    return error;
  }
}

function summariseVisits(
  visits: ReadonlyArray<{ status: string; startsAt: Date }>,
): GuestVisitSummary {
  const completed = visits.filter((v) => v.status === ReservationStatus.COMPLETED);
  const now = Date.now();
  // Ordered by startsAt ascending, so the first future booking is the next one.
  const upcoming = visits.find(
    (v) =>
      v.startsAt.getTime() >= now &&
      (v.status === ReservationStatus.SCHEDULED || v.status === ReservationStatus.IN_PROGRESS),
  );

  return {
    total: visits.length,
    completed: completed.length,
    cancelled: visits.filter((v) => v.status === ReservationStatus.CANCELLED).length,
    noShow: visits.filter((v) => v.status === ReservationStatus.NO_SHOW).length,
    firstVisitAt: completed[0]?.startsAt.toISOString() ?? null,
    lastVisitAt: completed[completed.length - 1]?.startsAt.toISOString() ?? null,
    nextVisitAt: upcoming?.startsAt.toISOString() ?? null,
  };
}
