import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BookingRequest, Prisma, SourceChannel } from '@prisma/client';
import { createHmac } from 'node:crypto';
import {
  BookingRequestStatus,
  ConvertBookingRequestDto,
  ErrorCode,
  ListBookingRequestsQuery,
  businessDay,
} from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { screenPublicText } from '../common/medical-screen';
import { AuditAction, AuditService, pickAuditFields } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import type { Env } from '../config/env';
import {
  ReservationView,
  apiError,
  presentReservation,
} from '../reservations/reservations.service';

/*
 * The unconfirmed half of the dual intake pipeline. §1.1.
 *
 * A booking request HOLDS NO RESOURCE. There is no therapist, no room and no
 * time window attached to it, so two requests for 19:00 with the same therapist
 * are not a conflict — they are two people who both want the same thing, which
 * is a good evening, not an error. Nothing in this file can raise 23P01 and
 * nothing in it needs to guard against one.
 *
 * The conflict appears exactly once, at `convert`, when the enquiry becomes a
 * `reservation` and a therapist is actually committed. That insert is not
 * pre-checked either: it goes in, and the exclusion constraints arbitrate. §5.5.
 */

/** The statuses an enquiry can still be acted on from. Everything else is closed. */
const OPEN_STATUSES: readonly BookingRequestStatus[] = [
  BookingRequestStatus.NEW,
  BookingRequestStatus.CONTACTED,
];

/**
 * Crockford's base32 — no I, L, O or U, so a reference read down a phone line
 * cannot come back as a different one.
 */
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The reference the guest is given, and the one reception sees beside the same
 * row in the inbox.
 *
 * It is derived rather than stored because the table has no column for it, and
 * it is derived rather than being the id itself because the id is a UUID v7:
 * it is a database key and its first 48 bits are the creation timestamp. A
 * public form has no business handing either of those back.
 *
 * Keyed with `ERASURE_SALT` — the one secret this deployment is told never to
 * rotate (§12.5). A rotation here would be cosmetic rather than destructive,
 * every reference simply reprinting differently, but a reference that changes
 * under a guest who wrote it down is still a reference nobody trusts.
 *
 * 40 bits of output: roughly a trillion values, against an inbox that will see
 * a few thousand enquiries a year.
 */
export function publicReference(id: string, salt: string): string {
  const digest = createHmac('sha256', salt).update(id).digest();
  let token = '';
  // 256 is an exact multiple of 32, so the modulo carries no bias.
  for (let i = 0; i < 8; i += 1) token += REFERENCE_ALPHABET[digest[i]! % 32];
  return `BRX-${token.slice(0, 4)}-${token.slice(4)}`;
}

/* ───────────────────────── presentation ───────────────────────── */

const REQUEST_INCLUDE = {
  service: { select: { id: true, name: true, durationMinutes: true, priceFils: true } },
} satisfies Prisma.BookingRequestInclude;

/**
 * Mirrors the relations `POST /reservations` returns, so the screen reception
 * lands on after converting shows the same booking in the same shape.
 */
const RESERVATION_INCLUDE = {
  guest: { select: { id: true, fullName: true, phone: true } },
  employee: { select: { id: true, displayName: true } },
  service: { select: { id: true, name: true, durationMinutes: true } },
  room: { select: { id: true, name: true } },
} satisfies Prisma.ReservationInclude;

type PresentableRequest = BookingRequest & {
  service?: { id: string; name: string; durationMinutes: number; priceFils: number } | null;
};

export interface BookingRequestView {
  id: string;
  /** What the guest was told to quote. Stable, and not the primary key. */
  reference: string;
  status: BookingRequestStatus;
  guestId: string | null;
  guestName: string;
  guestPhone: string;
  guestEmail: string | null;
  message: string | null;
  requestedAt: string | null;
  sourceChannel: SourceChannel;
  service: { id: string; name: string; durationMinutes: number; priceFils: number } | null;
  /** The join key for the channel ROI report. §10.6. */
  attributionId: string | null;
  convertedReservationId: string | null;
  handledByUserId: string | null;
  handledAt: string | null;
  createdAt: string;
}

export interface ConvertedBookingRequestView {
  request: BookingRequestView;
  reservation: ReservationView;
}

/* ───────────────────────── the service ───────────────────────── */

@Injectable()
export class BookingRequestsService {
  private readonly erasureSalt: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.erasureSalt = String(config.get('ERASURE_SALT', { infer: true }));
  }

  /**
   * The reception inbox. Newest first, because an enquiry that came in four
   * minutes ago is the one worth calling back — the `(branch_id, status,
   * created_at)` index is laid out for exactly this read.
   */
  async findMany(
    query: ListBookingRequestsQuery,
    actor: AuthUser,
  ): Promise<BookingRequestView[]> {
    const where: Prisma.BookingRequestWhereInput = { branchId: actor.branchId };
    if (query.status) where.status = query.status;

    const rows = await this.prisma.bookingRequest.findMany({
      where,
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });
    return rows.map((row) => this.present(row));
  }

  async findOne(id: string, actor: AuthUser): Promise<BookingRequestView> {
    const row = await this.prisma.bookingRequest.findFirst({
      where: { id, branchId: actor.branchId },
      include: REQUEST_INCLUDE,
    });
    if (!row) throw notFound();
    return this.present(row);
  }

  /**
   * Turn an enquiry into a held slot.
   *
   * ONE transaction, for one reason: the reservation and the request's own
   * `CONVERTED` marker have to become true together. Two transactions would
   * eventually leave a booking whose enquiry still sits in the inbox as NEW —
   * and reception would ring the guest to offer them a slot they already have.
   *
   * There is deliberately no conflict query before the insert. If the therapist
   * has been taken since the grid was drawn, `reservations_no_therapist_overlap`
   * rejects the insert, the whole transaction rolls back, this request is left
   * exactly as it was — still NEW, still in the inbox — and `PrismaErrorFilter`
   * turns 23P01 into a 409 the receptionist can act on. §5.5.
   */
  async convert(
    id: string,
    dto: ConvertBookingRequestDto,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<ConvertedBookingRequestView> {
    return this.prisma.$transaction(async (tx) => {
      const request = await lockBookingRequest(tx, id, actor.branchId);
      assertOpen(request);

      // Reception's choice wins over the website's: guests change their mind on
      // the phone far more often than they change it on the form.
      const serviceId = dto.serviceId ?? request.requestedServiceId;
      if (!serviceId) {
        throw new UnprocessableEntityException(
          apiError(
            ErrorCode.VALIDATION_FAILED,
            'This enquiry did not name a treatment, so one has to be chosen to convert it.',
          ),
        );
      }

      const service = await tx.service.findFirst({
        where: { id: serviceId, branchId: actor.branchId, isActive: true },
      });
      if (!service) {
        throw new NotFoundException(
          apiError(ErrorCode.NOT_FOUND, 'That service is not on this branch’s menu.'),
        );
      }

      const employee = await tx.employee.findFirst({
        where: { id: dto.employeeId, branchId: actor.branchId, deletedAt: null },
      });
      if (!employee) {
        throw new NotFoundException(
          apiError(ErrorCode.NOT_FOUND, 'No such therapist in this branch.'),
        );
      }

      const guestId = await this.resolveGuest(tx, request, actor.branchId);
      const startsAt = new Date(dto.startsAt);
      const ref = await nextReservationRef(tx, startsAt);

      const reservation = await tx.reservation.create({
        data: {
          ref,
          // From the TOKEN. A branch never arrives from a request body. §6.6.
          branchId: actor.branchId,
          guestId,
          employeeId: employee.id,
          roomId: dto.roomId ?? null,
          serviceId: service.id,
          startsAt,
          durationMinutes: dto.durationMinutes ?? service.durationMinutes,
          // Placeholders. trg_reservations_derive overwrites all three before
          // the row lands, and RETURNING hands back what it wrote. §5.3.
          endsAt: startsAt,
          blockedUntil: startsAt,
          businessDay: startsAt,
          // A price snapshot: tonight is charged at tonight's price.
          baseCostFils: service.priceFils,
          // The channel the ENQUIRY arrived on, not the desk that typed it in —
          // otherwise every website booking would report as a phone booking.
          sourceChannel: request.sourceChannel,
          // THE POINT OF THIS METHOD. Carrying the snapshot across is what keeps
          // touch → request → reservation → payment a join instead of a guess. §10.3.
          attributionId: request.attributionId,
          // The enquiry's own message was screened on the way in (§11.5), so
          // only reception's addition needs checking here.
          notes: screenPublicText(dto.notes ?? request.message).text,
          createdByUserId: actor.id,
        },
        include: RESERVATION_INCLUDE,
      });

      const updated = await tx.bookingRequest.update({
        where: { id: request.id },
        data: {
          status: BookingRequestStatus.CONVERTED,
          convertedReservationId: reservation.id,
          // If the enquiry was anonymous until now, it is not any more.
          guestId,
          handledByUserId: actor.id,
          handledAt: new Date(),
        },
        include: REQUEST_INCLUDE,
      });

      // Audited as the creation of a reservation, because that is the thing that
      // will later take money. The request row's own trail is `handledByUserId`
      // and `handledAt`, which is all `financial_audit_log` could honestly say
      // about an enquiry that moved no money.
      await this.audit.write(tx, ctx, {
        action: AuditAction.RESERVATION_CREATED,
        entityType: 'Reservation',
        entityId: reservation.id,
        afterState: pickAuditFields(reservation),
        amountFils: reservation.baseCostFils,
      });

      return { request: this.present(updated), reservation: presentReservation(reservation) };
    });
  }

  /** The guest was called and there is nothing to book. */
  async decline(id: string, actor: AuthUser): Promise<BookingRequestView> {
    return this.close(id, BookingRequestStatus.DECLINED, actor);
  }

  /**
   * A public form on the open internet collects junk. SPAM rather than DECLINED
   * keeps the inbox's conversion rate honest: a bot submission was never a lead,
   * and counting it as a lost one would understate how the website is doing.
   */
  async markSpam(id: string, actor: AuthUser): Promise<BookingRequestView> {
    return this.close(id, BookingRequestStatus.SPAM, actor);
  }

  /**
   * Closing an enquiry. No transaction and no audit entry: nothing here holds a
   * resource and nothing here moves money, so the row's own `status`,
   * `handledByUserId` and `handledAt` are the complete record of what happened.
   */
  private async close(
    id: string,
    status: BookingRequestStatus,
    actor: AuthUser,
  ): Promise<BookingRequestView> {
    return this.prisma.$transaction(async (tx) => {
      const request = await lockBookingRequest(tx, id, actor.branchId);
      assertOpen(request);

      const updated = await tx.bookingRequest.update({
        where: { id: request.id },
        data: { status, handledByUserId: actor.id, handledAt: new Date() },
        include: REQUEST_INCLUDE,
      });
      return this.present(updated);
    });
  }

  /**
   * The same (branch, phone) unique index reception relies on at the desk: a
   * guest who enquired last month is found, not duplicated. An enquiry with no
   * phone we can key on converts to a booking with no guest row, exactly as an
   * anonymous walk-in does.
   */
  private async resolveGuest(
    tx: Prisma.TransactionClient,
    request: BookingRequest,
    branchId: string,
  ): Promise<string | null> {
    if (request.guestId) return request.guestId;
    if (!request.guestPhone) return null;

    const guest = await tx.guest.upsert({
      where: { branchId_phone: { branchId, phone: request.guestPhone } },
      create: {
        branchId,
        fullName: request.guestName,
        phone: request.guestPhone,
        email: request.guestEmail,
      },
      // Never overwrite a known guest's name from a web form; fill in an email
      // only if we did not already hold one.
      update: { email: request.guestEmail ?? undefined },
    });
    return guest.id;
  }

  private present(row: PresentableRequest): BookingRequestView {
    return {
      id: row.id,
      reference: publicReference(row.id, this.erasureSalt),
      status: row.status as BookingRequestStatus,
      guestId: row.guestId,
      guestName: row.guestName,
      guestPhone: row.guestPhone,
      guestEmail: row.guestEmail,
      message: row.message,
      requestedAt: row.requestedAt?.toISOString() ?? null,
      sourceChannel: row.sourceChannel,
      service: row.service ?? null,
      attributionId: row.attributionId,
      convertedReservationId: row.convertedReservationId,
      handledByUserId: row.handledByUserId,
      handledAt: row.handledAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/* ───────────────────────── shared helpers ───────────────────────── */

function notFound(): NotFoundException {
  return new NotFoundException(
    apiError(ErrorCode.BOOKING_REQUEST_NOT_FOUND, 'No enquiry with that reference in this branch.'),
  );
}

/**
 * Take the row lock first, then read the row through Prisma — the same shape as
 * `lockReservation`, for a different reason.
 *
 * A request holds nothing, so this is not protecting a slot. It is protecting
 * against two receptionists picking up the same enquiry in the same second and
 * both converting it: without the lock that is two reservations for one guest,
 * and the guest exclusion constraint would only catch it if the two happened to
 * overlap in time.
 */
async function lockBookingRequest(
  tx: Prisma.TransactionClient,
  id: string,
  branchId: string,
): Promise<BookingRequest> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM booking_requests
     WHERE id = ${id}::uuid AND branch_id = ${branchId}::uuid
     FOR UPDATE`;

  if (locked.length === 0) throw notFound();
  return tx.bookingRequest.findUniqueOrThrow({ where: { id } });
}

function assertOpen(request: BookingRequest): void {
  const status = request.status as BookingRequestStatus;
  if (OPEN_STATUSES.includes(status)) return;

  throw new ConflictException(
    apiError(
      ErrorCode.BOOKING_REQUEST_ALREADY_HANDLED,
      status === BookingRequestStatus.CONVERTED
        ? 'This enquiry has already been turned into a booking.'
        : 'Somebody has already dealt with this enquiry.',
      { status, handledAt: request.handledAt?.toISOString() ?? null },
    ),
  );
}

/**
 * `BR-2026-0417`, off the same `reservation_ref_seq` that `ReservationsService`
 * draws from — the sequence, not this function, is where the two are kept in
 * step, and `nextval` is atomic and lock-free so a conversion and a walk-in
 * booked in the same second cannot collide.
 *
 * It is repeated here rather than shared so that the whole conversion stays in
 * ONE transaction. Reaching across to the reservations service would mean its
 * `$transaction` nested inside this one, and Prisma does not nest: the inner
 * writes would land on a different connection and commit on their own.
 */
async function nextReservationRef(tx: Prisma.TransactionClient, startsAt: Date): Promise<string> {
  const [row] = await tx.$queryRaw<{ seq: bigint | number | string }[]>`
    SELECT nextval('reservation_ref_seq') AS seq`;
  if (!row) throw new Error('reservation_ref_seq returned no value');

  // The year comes off the trading day: a 01:30 booking on 1 January carries the
  // year its revenue reports under. §3.3.
  const year = businessDay(startsAt).slice(0, 4);
  return `BR-${year}-${String(Number(row.seq)).padStart(4, '0')}`;
}
