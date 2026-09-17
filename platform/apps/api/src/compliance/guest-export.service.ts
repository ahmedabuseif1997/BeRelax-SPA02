import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AttributionSnapshot,
  BookingRequest,
  Guest,
  GuestConsent,
  Payment,
  Tip,
} from '@prisma/client';
import {
  BookingRequestStatus,
  ConsentType,
  ErrorCode,
  PaymentKind,
  PaymentMethod,
  ReservationStatus,
  SourceChannel,
  TipType,
} from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction, AuditService } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import { apiError } from '../reservations/reservations.service';

/* ───────────────────────── the bundle ───────────────────────── */

/**
 * Version the SHAPE, not the data. A guest who exercises portability twice a
 * year and diffs the two files needs to know whether a missing key means the
 * business stopped holding something or the exporter changed its mind.
 */
export const EXPORT_FORMAT_VERSION = '1';

/**
 * Past Prisma's five-second default: this reads seven tables for a guest who may
 * have been coming here for years, and a subject access request that times out
 * is a subject access request that was not answered.
 */
const EXPORT_TRANSACTION = { timeout: 20_000 } as const;

export interface ExportedGuest {
  id: string;
  branchId: string;
  fullName: string;
  phone: string;
  email: string | null;
  notes: string | null;
  isBlocked: boolean;
  anonymisedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ExportedConsent {
  id: string;
  type: ConsentType;
  granted: boolean;
  grantedAt: string;
  withdrawnAt: string | null;
  source: string;
  /** Which privacy notice they actually saw. A bare boolean proves nothing. */
  policyVersion: string;
  ipAddress: string | null;
}

export interface ExportedReservation {
  id: string;
  ref: string;
  status: ReservationStatus;
  serviceId: string;
  serviceName: string;
  /** The name the guest was given at the desk, never `legalName`. §6.4. */
  therapist: string;
  room: string | null;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  businessDay: string;
  baseCostFils: number;
  sourceChannel: SourceChannel;
  attributionId: string | null;
  actualArrivalAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  notes: string | null;
  createdAt: string;
}

export interface ExportedPayment {
  id: string;
  reservationId: string;
  reservationRef: string;
  kind: PaymentKind;
  method: PaymentMethod;
  /** Signed integer fils, exactly as stored. Negative on a refund. §3.1. */
  amountFils: number;
  businessDay: string;
  collectedAt: string;
  createdAt: string;
  externalRef: string | null;
  reversesPaymentId: string | null;
  note: string | null;
}

export interface ExportedTip {
  id: string;
  reservationId: string;
  reservationRef: string;
  type: TipType;
  amountFils: number;
  method: PaymentMethod | null;
  paymentId: string | null;
  businessDay: string;
  recordedAt: string;
  reversedByTipId: string | null;
  note: string | null;
}

export interface ExportedBookingRequest {
  id: string;
  guestName: string;
  guestPhone: string;
  guestEmail: string | null;
  requestedServiceId: string | null;
  requestedAt: string | null;
  message: string | null;
  status: BookingRequestStatus;
  sourceChannel: SourceChannel;
  attributionId: string | null;
  convertedReservationId: string | null;
  createdAt: string;
  /** True when it was matched by phone number rather than by a stored link. */
  matchedByPhone: boolean;
}

export interface ExportedAttribution {
  id: string;
  visitorId: string;
  firstTouch: Prisma.JsonValue;
  lastTouch: Prisma.JsonValue;
  touches: Prisma.JsonValue;
  touchCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  landingPath: string | null;
  capturedAt: string;
  /** Set once the 90-day window has passed and the identifiers were stripped. */
  prunedAt: string | null;
  /** The bookings this snapshot is attached to. */
  linkedReservationIds: string[];
  linkedBookingRequestIds: string[];
}

export interface GuestExportBundle {
  meta: {
    formatVersion: string;
    exportedAt: string;
    exportedByUserId: string;
    requestId: string;
    branchId: string;
    /** PDPL Articles 13-15: access and portability, answered by one document. */
    basis: string;
    /** What is NOT in here, said out loud rather than left to be discovered. */
    notIncluded: readonly string[];
  };
  guest: ExportedGuest;
  consents: ExportedConsent[];
  reservations: ExportedReservation[];
  payments: ExportedPayment[];
  tips: ExportedTip[];
  bookingRequests: ExportedBookingRequest[];
  attributionSnapshots: ExportedAttribution[];
  counts: {
    consents: number;
    reservations: number;
    payments: number;
    tips: number;
    bookingRequests: number;
    attributionSnapshots: number;
  };
}

/* ───────────────────────── the service ───────────────────────── */

/**
 * PDPL Articles 13-15 — the right to be informed, the right of access and the
 * right to portability — answered by a single machine-readable document.
 *
 * **A partial export is a failed request.** Every table in the schema that holds
 * a row reachable from this guest is read here, and the day someone adds a table
 * that holds guest-linked data, this file is the one that has to change with it.
 * Nothing summarises: the amounts are the stored integers, the timestamps are
 * ISO-8601 with offsets, the JSON is the JSON. A guest who takes this to another
 * spa should be able to load it without asking us what a fil is.
 *
 * The whole read runs in ONE transaction. Not for locking — nothing here writes
 * to the business tables — but so that a booking taken while the export is
 * running cannot land in `reservations` and miss `payments`, producing a bundle
 * that is internally inconsistent and impossible to explain.
 */
@Injectable()
export class GuestExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async export(
    guestId: string,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<GuestExportBundle> {
    return this.prisma.$transaction(async (tx) => {
      // `deletedAt` is deliberately NOT filtered: the honest answer to "what do
      // you hold about this id" for an erased guest is the shell, not a 404.
      const guest = await tx.guest.findFirst({ where: { id: guestId, branchId: actor.branchId } });
      if (!guest) {
        throw new NotFoundException(apiError(ErrorCode.NOT_FOUND, 'No such guest in this branch.'));
      }

      const consents = await tx.guestConsent.findMany({
        where: { guestId: guest.id },
        orderBy: { grantedAt: 'asc' },
      });

      const reservations = await tx.reservation.findMany({
        where: { guestId: guest.id, branchId: actor.branchId },
        orderBy: { startsAt: 'asc' },
        include: {
          service: { select: { id: true, name: true } },
          employee: { select: { displayName: true } },
          room: { select: { name: true } },
        },
      });
      const refById = new Map(reservations.map((r) => [r.id, r.ref]));
      const reservationIds = [...refById.keys()];

      const [payments, tips] = await Promise.all([
        reservationIds.length
          ? tx.payment.findMany({
              where: { reservationId: { in: reservationIds } },
              orderBy: { createdAt: 'asc' },
            })
          : Promise.resolve<Payment[]>([]),
        reservationIds.length
          ? tx.tip.findMany({
              where: { reservationId: { in: reservationIds } },
              orderBy: { recordedAt: 'asc' },
            })
          : Promise.resolve<Tip[]>([]),
      ]);

      // Matched by the stored link OR by the phone number. A request that came
      // off the public form before reception attached it to a guest record still
      // carries this person's name and number, and "we never linked it" is not a
      // reason to withhold their own data from them.
      const bookingRequests = await tx.bookingRequest.findMany({
        where: {
          branchId: actor.branchId,
          OR: [{ guestId: guest.id }, { guestPhone: guest.phone }],
        },
        orderBy: { createdAt: 'asc' },
      });

      const attributionSnapshots = await this.loadAttribution(tx, guest.id);

      const bundle = this.assemble({
        actor,
        ctx,
        guest,
        consents,
        reservations,
        refById,
        payments,
        tips,
        bookingRequests,
        attributionSnapshots,
      });

      // Exporting someone's whole life with the business is itself an act worth
      // recording — and the only record that a manager pulled it. §9.6.
      await this.audit.write(tx, ctx, {
        action: AuditAction.GUEST_DATA_EXPORTED,
        entityType: 'Guest',
        entityId: guest.id,
        // Counts, never contents. The audit log is not a second copy of the
        // guest database, and least of all a copy of an export of it.
        afterState: { formatVersion: EXPORT_FORMAT_VERSION, ...bundle.counts },
      });

      return bundle;
    }, EXPORT_TRANSACTION);
  }

  /**
   * Every snapshot reachable from this guest: through a booking, and through an
   * enquiry that was never converted. Both directions matter — a request that
   * was declined still carries how that person found the spa.
   */
  private async loadAttribution(
    tx: Prisma.TransactionClient,
    guestId: string,
  ): Promise<Array<AttributionSnapshot & { linkedReservationIds: string[]; linkedBookingRequestIds: string[] }>> {
    const snapshots = await tx.attributionSnapshot.findMany({
      where: {
        OR: [{ reservations: { some: { guestId } } }, { bookingRequest: { is: { guestId } } }],
      },
      orderBy: { capturedAt: 'asc' },
      include: {
        reservations: { where: { guestId }, select: { id: true } },
        bookingRequest: { select: { id: true, guestId: true } },
      },
    });

    return snapshots.map(({ reservations, bookingRequest, ...snapshot }) => ({
      ...snapshot,
      linkedReservationIds: reservations.map((r) => r.id),
      linkedBookingRequestIds:
        bookingRequest && bookingRequest.guestId === guestId ? [bookingRequest.id] : [],
    }));
  }

  private assemble(input: {
    actor: AuthUser;
    ctx: RequestContext;
    guest: Guest;
    consents: GuestConsent[];
    reservations: Array<
      Prisma.ReservationGetPayload<{
        include: {
          service: { select: { id: true; name: true } };
          employee: { select: { displayName: true } };
          room: { select: { name: true } };
        };
      }>
    >;
    refById: Map<string, string>;
    payments: Payment[];
    tips: Tip[];
    bookingRequests: BookingRequest[];
    attributionSnapshots: Array<
      AttributionSnapshot & { linkedReservationIds: string[]; linkedBookingRequestIds: string[] }
    >;
  }): GuestExportBundle {
    const { guest, refById } = input;

    const bundle: Omit<GuestExportBundle, 'counts'> = {
      meta: {
        formatVersion: EXPORT_FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        exportedByUserId: input.actor.id,
        requestId: input.ctx.requestId,
        branchId: guest.branchId,
        basis: 'UAE PDPL Arts. 13-15 — access and portability',
        notIncluded: [
          // Said out loud, because an export that silently omits something is
          // how a subject access request becomes a complaint.
          'Health or medical information — this system stores none at all (§11.5).',
          'The financial audit log, which records what changed about the money and carries no guest identity (§9.6).',
          'Staff rosters, therapist earnings and payout batches, which are employee data rather than guest data.',
        ],
      },
      guest: {
        id: guest.id,
        branchId: guest.branchId,
        fullName: guest.fullName,
        phone: guest.phone,
        email: guest.email,
        notes: guest.notes,
        isBlocked: guest.isBlocked,
        anonymisedAt: guest.anonymisedAt?.toISOString() ?? null,
        createdAt: guest.createdAt.toISOString(),
        updatedAt: guest.updatedAt.toISOString(),
        deletedAt: guest.deletedAt?.toISOString() ?? null,
      },
      consents: input.consents.map((c) => ({
        id: c.id,
        type: c.type as ConsentType,
        granted: c.granted,
        grantedAt: c.grantedAt.toISOString(),
        withdrawnAt: c.withdrawnAt?.toISOString() ?? null,
        source: c.source,
        policyVersion: c.policyVersion,
        ipAddress: c.ipAddress,
      })),
      reservations: input.reservations.map((r) => ({
        id: r.id,
        ref: r.ref,
        status: r.status as ReservationStatus,
        serviceId: r.serviceId,
        serviceName: r.service.name,
        therapist: r.employee.displayName,
        room: r.room?.name ?? null,
        startsAt: r.startsAt.toISOString(),
        endsAt: r.endsAt.toISOString(),
        durationMinutes: r.durationMinutes,
        businessDay: r.businessDay.toISOString().slice(0, 10),
        baseCostFils: r.baseCostFils,
        sourceChannel: r.sourceChannel as SourceChannel,
        attributionId: r.attributionId,
        actualArrivalAt: r.actualArrivalAt?.toISOString() ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
        cancelledAt: r.cancelledAt?.toISOString() ?? null,
        cancellationReason: r.cancellationReason,
        notes: r.notes,
        createdAt: r.createdAt.toISOString(),
      })),
      payments: input.payments.map((p) => ({
        id: p.id,
        reservationId: p.reservationId,
        reservationRef: refById.get(p.reservationId) ?? '',
        kind: p.kind as PaymentKind,
        method: p.method as PaymentMethod,
        amountFils: p.amountFils,
        businessDay: p.businessDay.toISOString().slice(0, 10),
        collectedAt: p.collectedAt.toISOString(),
        createdAt: p.createdAt.toISOString(),
        externalRef: p.externalRef,
        reversesPaymentId: p.reversesPaymentId,
        note: p.note,
      })),
      tips: input.tips.map((t) => ({
        id: t.id,
        reservationId: t.reservationId,
        reservationRef: refById.get(t.reservationId) ?? '',
        type: t.type as TipType,
        amountFils: t.amountFils,
        method: (t.method as PaymentMethod | null) ?? null,
        paymentId: t.paymentId,
        businessDay: t.businessDay.toISOString().slice(0, 10),
        recordedAt: t.recordedAt.toISOString(),
        reversedByTipId: t.reversedByTipId,
        note: t.note,
      })),
      bookingRequests: input.bookingRequests.map((b) => ({
        id: b.id,
        guestName: b.guestName,
        guestPhone: b.guestPhone,
        guestEmail: b.guestEmail,
        requestedServiceId: b.requestedServiceId,
        requestedAt: b.requestedAt?.toISOString() ?? null,
        message: b.message,
        status: b.status as BookingRequestStatus,
        sourceChannel: b.sourceChannel as SourceChannel,
        attributionId: b.attributionId,
        convertedReservationId: b.convertedReservationId,
        createdAt: b.createdAt.toISOString(),
        matchedByPhone: b.guestId !== guest.id,
      })),
      attributionSnapshots: input.attributionSnapshots.map((a) => ({
        id: a.id,
        visitorId: a.visitorId,
        firstTouch: a.firstTouch,
        lastTouch: a.lastTouch,
        touches: a.touches,
        touchCount: a.touchCount,
        firstSeenAt: a.firstSeenAt.toISOString(),
        lastSeenAt: a.lastSeenAt.toISOString(),
        landingPath: a.landingPath,
        capturedAt: a.capturedAt.toISOString(),
        prunedAt: a.prunedAt?.toISOString() ?? null,
        linkedReservationIds: a.linkedReservationIds,
        linkedBookingRequestIds: a.linkedBookingRequestIds,
      })),
    };

    return {
      ...bundle,
      counts: {
        consents: bundle.consents.length,
        reservations: bundle.reservations.length,
        payments: bundle.payments.length,
        tips: bundle.tips.length,
        bookingRequests: bundle.bookingRequests.length,
        attributionSnapshots: bundle.attributionSnapshots.length,
      },
    };
  }
}
