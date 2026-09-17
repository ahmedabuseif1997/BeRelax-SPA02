import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Reservation } from '@prisma/client';
import { z } from 'zod';
import {
  ALLOWED_STATUS_TRANSITIONS,
  ApiErrorBody,
  CancelReservationDto,
  CreateReservationDto,
  ErrorCode,
  ROLE_RANK,
  ReservationStatus,
  UserRole,
  businessDay,
  businessDayBounds,
} from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction, AuditService, pickAuditFields } from '../common/audit.service';
import { assertNotMedical } from '../common/medical-screen';
import type { AuthUser, RequestContext } from '../common/request-context';

/* ───────────────────────── shared helpers ───────────────────────── */

/** Every error this module throws carries the one body shape the dashboard parses. §3.6. */
export function apiError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ApiErrorBody {
  return { error: details ? { code, message, details } : { code, message } };
}

/** MANAGER+ gates: comping a treatment, overriding the tip limit, cancelling mid-treatment. §6.4. */
export function isManagerOrAbove(role: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[UserRole.MANAGER];
}

/**
 * The value a `date` column wants for a trading day. Prisma rejects a bare
 * `YYYY-MM-DD` on a DateTime field, and `new Date('2026-09-16')` is already
 * UTC midnight — which is what `@db.Date` stores. §3.3.
 */
export function businessDayColumn(at: Date | string): Date {
  const day = typeof at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : businessDay(at);
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * Take the row lock FIRST, then read the row through Prisma.
 *
 * The raw statement exists only for `FOR UPDATE` — two receptionists tapping
 * Check in on the same guest must serialise here, not race each other to the
 * status update. Prisma does not map raw results to camelCase, and a
 * hand-aliased SELECT of thirty columns is one migration away from being
 * silently wrong, so the typed read follows inside the same transaction, where
 * it sees the row this transaction now holds.
 */
export async function lockReservation(
  tx: Prisma.TransactionClient,
  id: string,
  branchId: string,
): Promise<Reservation> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM reservations
     WHERE id = ${id}::uuid AND branch_id = ${branchId}::uuid
     FOR UPDATE`;

  if (locked.length === 0) {
    throw new NotFoundException(
      apiError(ErrorCode.RESERVATION_NOT_FOUND, 'No booking with that reference in this branch.'),
    );
  }
  return tx.reservation.findUniqueOrThrow({ where: { id } });
}

/* ───────────────────────── presentation ───────────────────────── */

const RESERVATION_INCLUDE = {
  guest: { select: { id: true, fullName: true, phone: true } },
  employee: { select: { id: true, displayName: true } },
  service: { select: { id: true, name: true, durationMinutes: true } },
  room: { select: { id: true, name: true } },
} satisfies Prisma.ReservationInclude;

export type PresentableReservation = Reservation & {
  guest?: { id: string; fullName: string; phone: string } | null;
  employee?: { id: string; displayName: string } | null;
  service?: { id: string; name: string; durationMinutes: number } | null;
  room?: { id: string; name: string } | null;
};

export interface ReservationView {
  id: string;
  ref: string;
  status: ReservationStatus;
  startsAt: string;
  endsAt: string;
  blockedUntil: string;
  businessDay: string;
  durationMinutes: number;
  baseCostFils: number;
  sourceChannel: string;
  actualArrivalAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  notes: string | null;
  guest?: { id: string; fullName: string; phone: string } | null;
  employee?: { id: string; displayName: string } | null;
  service?: { id: string; name: string; durationMinutes: number } | null;
  room?: { id: string; name: string } | null;
}

/** Money stays an integer all the way out; formatting to AED happens in the UI. §3.1. */
export function presentReservation(r: PresentableReservation): ReservationView {
  const view: ReservationView = {
    id: r.id,
    ref: r.ref,
    status: r.status as ReservationStatus,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    blockedUntil: r.blockedUntil.toISOString(),
    businessDay: r.businessDay.toISOString().slice(0, 10),
    durationMinutes: r.durationMinutes,
    baseCostFils: r.baseCostFils,
    sourceChannel: r.sourceChannel,
    actualArrivalAt: r.actualArrivalAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancellationReason: r.cancellationReason,
    notes: r.notes,
  };
  if (r.guest !== undefined) view.guest = r.guest;
  if (r.employee !== undefined) view.employee = r.employee;
  if (r.service !== undefined) view.service = r.service;
  if (r.room !== undefined) view.room = r.room;
  return view;
}

/* ───────────────────────── query contract ───────────────────────── */

/**
 * Belongs in `@berelax/contracts` the moment the dashboard needs to build this
 * query itself; it lives here while the grid is the only caller.
 */
export const listReservationsQuerySchema = z.object({
  businessDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a trading day in YYYY-MM-DD form.')
    .optional(),
  employeeId: z.string().uuid().optional(),
  status: z.nativeEnum(ReservationStatus).optional(),
});
export type ListReservationsQuery = z.infer<typeof listReservationsQuerySchema>;

/**
 * Reschedule and reassign. Every field is optional; whatever is sent moves, the
 * rest stays. Lives here rather than in `@berelax/contracts` for the same reason
 * the query above does — the dashboard does not build it yet.
 */
export const rescheduleReservationSchema = z
  .object({
    startsAt: z.string().datetime({ offset: true }).optional(),
    employeeId: z.string().uuid().optional(),
    roomId: z.string().uuid().nullable().optional(),
    serviceId: z.string().uuid().optional(),
    notes: z.string().max(500).optional(),
    reason: z.string().min(3).max(300),
  })
  .refine(
    (v) =>
      v.startsAt !== undefined ||
      v.employeeId !== undefined ||
      v.roomId !== undefined ||
      v.serviceId !== undefined ||
      v.notes !== undefined,
    { message: 'Nothing to change.' },
  );
export type RescheduleReservationDto = z.infer<typeof rescheduleReservationSchema>;

/* ───────────────────────── the service ───────────────────────── */

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Book a treatment.
   *
   * There is deliberately NO conflict query before the insert. A check-then-insert
   * has a race window and will double-book on a busy Friday when two receptionists
   * tap Confirm in the same second. The three exclusion constraints arbitrate;
   * SQLSTATE 23P01 leaves this method untouched and `PrismaErrorFilter` turns it
   * into a `409 THERAPIST_ALREADY_BOOKED`/`ROOM_ALREADY_BOOKED`/`GUEST_ALREADY_BOOKED`.
   * The availability grid is a hint. The constraint is the truth. §5.5.
   */
  async create(
    dto: CreateReservationDto,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<ReservationView> {
    // Reception typing into the CRM gets a hard refusal — they can be taught
    // the rule, and the refusal is how they learn it. §11.5.
    assertNotMedical(dto.notes);
    return this.prisma.$transaction(async (tx) => {
      const service = await tx.service.findFirst({
        where: { id: dto.serviceId, branchId: actor.branchId, isActive: true },
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

      const guestId = await this.resolveGuest(tx, dto, actor.branchId);
      const startsAt = new Date(dto.startsAt);
      const ref = await nextReservationRef(tx, startsAt);

      // Same resolution the employee gets, for the same reason: an inactive or

      // out-of-branch room must not end up on a booking just because the

      // foreign key does not carry the branch.

      if (dto.roomId) {

        const room = await tx.room.findFirst({

          where: { id: dto.roomId, branchId: actor.branchId, isActive: true },

          select: { id: true },

        });

        if (!room) {

          throw new NotFoundException(

            apiError(ErrorCode.NOT_FOUND, 'No such room in this branch.'),

          );

        }

      }


      const created = await tx.reservation.create({
        data: {
          ref,
          // From the TOKEN, never the body. There is no code path where a branch
          // id arrives from a client. §6.6.
          branchId: actor.branchId,
          guestId,
          employeeId: employee.id,
          roomId: dto.roomId ?? null,
          serviceId: service.id,
          startsAt,
          durationMinutes: dto.durationMinutes ?? service.durationMinutes,
          // endsAt, blockedUntil and businessDay are maintained by
          // trg_reservations_derive. Prisma's types demand a value, so these
          // placeholders go in and the trigger overwrites all three before the
          // row lands; Postgres RETURNING hands back the post-trigger values.
          endsAt: startsAt,
          blockedUntil: startsAt,
          businessDay: startsAt,
          // A price snapshot. A price rise next month must not rewrite tonight.
          baseCostFils: service.priceFils,
          sourceChannel: dto.sourceChannel,
          notes: dto.notes ?? null,
          createdByUserId: actor.id,
        },
        include: RESERVATION_INCLUDE,
      });

      await this.audit.write(tx, ctx, {
        action: AuditAction.RESERVATION_CREATED,
        entityType: 'Reservation',
        entityId: created.id,
        afterState: pickAuditFields(created),
        amountFils: created.baseCostFils,
      });

      return presentReservation(created);
    });
  }

  /** The booking grid: one trading day at a time. */
  async findMany(query: ListReservationsQuery, actor: AuthUser): Promise<ReservationView[]> {
    // A THERAPIST's filter is replaced, not validated — there is no request that
    // gets them somebody else's grid. §6.4.
    const isTherapist = actor.role === UserRole.THERAPIST;
    const employeeId = isTherapist ? (actor.employeeId ?? null) : (query.employeeId ?? null);
    // A therapist login with no linked employee row has no bookings, not everyone's.
    if (isTherapist && !employeeId) return [];

    const day = query.businessDay ?? businessDay(new Date());
    const where: Prisma.ReservationWhereInput = {
      branchId: actor.branchId,
      businessDay: businessDayColumn(day),
    };
    if (employeeId) where.employeeId = employeeId;
    if (query.status) where.status = query.status;

    if (employeeId) {
      // Redundant by construction — the trigger derives business_day from
      // starts_at with this same 06:00 cutover — but it lets the query ride the
      // (employee_id, starts_at) index instead of scanning the branch's day.
      const { start, end } = businessDayBounds(day);
      where.startsAt = { gte: start, lt: end };
    }

    const rows = await this.prisma.reservation.findMany({
      where,
      include: RESERVATION_INCLUDE,
      orderBy: { startsAt: 'asc' },
    });
    return rows.map(presentReservation);
  }

  async findOne(id: string, actor: AuthUser): Promise<ReservationView> {
    const row = await this.prisma.reservation.findFirst({
      where: { id, branchId: actor.branchId },
      include: RESERVATION_INCLUDE,
    });

    // 404 rather than 403 on someone else's booking: a therapist walking ids
    // should not learn which ones exist.
    if (!row || (actor.role === UserRole.THERAPIST && row.employeeId !== actor.employeeId)) {
      throw new NotFoundException(
        apiError(ErrorCode.RESERVATION_NOT_FOUND, 'No booking with that reference in this branch.'),
      );
    }
    return presentReservation(row);
  }

  /** Cancelling releases the slot immediately: the exclusion constraints skip cancelled rows. §5.2. */
  /**
   * Move a booking: a different time, a different therapist, a different room,
   * a different treatment. Only while it is still SCHEDULED — once the guest has
   * checked in they are on the table and money has changed hands, and once it is
   * terminal it is history.
   *
   * There is NO availability check here, deliberately. The update is issued and
   * the exclusion constraints arbitrate exactly as they do for an insert (§5.5);
   * moving a booking into an occupied window raises 23P01 and the filter turns
   * it into a 409 naming the resource that clashed. Checking first would open
   * the same race the constraints exist to close.
   */
  async reschedule(
    id: string,
    dto: RescheduleReservationDto,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<ReservationView> {
    return this.prisma.$transaction(async (tx) => {
      assertNotMedical(dto.notes);

      const reservation = await lockReservation(tx, id, actor.branchId);
      const from = reservation.status as ReservationStatus;

      if (from !== ReservationStatus.SCHEDULED) {
        throw new ConflictException(
          apiError(
            ErrorCode.RESERVATION_NOT_SCHEDULED,
            from === ReservationStatus.IN_PROGRESS
              ? 'That treatment has already started. Cancel it instead, and book again.'
              : 'That booking is finished and cannot be moved.',
            { status: from },
          ),
        );
      }

      // A different treatment is a different price. Safe to re-snapshot only
      // because nothing has been collected yet — a SCHEDULED booking has taken
      // no money, by construction (§8.2 collects at check-in).
      let baseCostFils = reservation.baseCostFils;
      let durationMinutes = reservation.durationMinutes;
      if (dto.serviceId && dto.serviceId !== reservation.serviceId) {
        const service = await tx.service.findFirst({
          where: { id: dto.serviceId, branchId: actor.branchId, isActive: true },
        });
        if (!service) {
          throw new NotFoundException(
            apiError(ErrorCode.NOT_FOUND, 'That treatment is not on the menu.'),
          );
        }
        baseCostFils = service.priceFils;
        durationMinutes = service.durationMinutes;
      }

      // Both ids are resolved the way create() resolves them. Taking them
      // straight from the body is not a foreign-key problem — the constraints
      // only reference employees(id) and rooms(id), with no branch in the key —
      // it is a soft-delete problem: reassigning to a departed therapist writes
      // a COMMISSION_ACCRUAL that payout refuses to settle (it filters
      // deletedAt: null) and that both the tips and utilisation reports omit
      // for the same reason. The liability would exist in the ledger and appear
      // in nothing a manager reads.
      if (dto.employeeId && dto.employeeId !== reservation.employeeId) {
        const employee = await tx.employee.findFirst({
          where: { id: dto.employeeId, branchId: actor.branchId, deletedAt: null },
          select: { id: true },
        });
        if (!employee) {
          throw new NotFoundException(
            apiError(ErrorCode.NOT_FOUND, 'No such therapist in this branch.'),
          );
        }
      }
      if (dto.roomId) {
        const room = await tx.room.findFirst({
          where: { id: dto.roomId, branchId: actor.branchId, isActive: true },
          select: { id: true },
        });
        if (!room) {
          throw new NotFoundException(
            apiError(ErrorCode.NOT_FOUND, 'No such room in this branch.'),
          );
        }
      }

      const updated = await tx.reservation.update({
        where: { id: reservation.id },
        data: {
          // endsAt, blockedUntil and businessDay are NOT set here — the derive
          // trigger recomputes all three from startsAt and durationMinutes.
          ...(dto.startsAt ? { startsAt: new Date(dto.startsAt) } : {}),
          ...(dto.employeeId ? { employeeId: dto.employeeId } : {}),
          ...(dto.roomId !== undefined ? { roomId: dto.roomId } : {}),
          ...(dto.serviceId ? { serviceId: dto.serviceId, durationMinutes, baseCostFils } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        },
        include: RESERVATION_INCLUDE,
      });

      await this.audit.write(tx, ctx, {
        action: AuditAction.RESERVATION_RESCHEDULED,
        entityType: 'Reservation',
        entityId: reservation.id,
        beforeState: pickAuditFields(reservation),
        afterState: { ...pickAuditFields(updated), reason: dto.reason },
        amountFils: baseCostFils === reservation.baseCostFils ? undefined : baseCostFils,
      });

      return presentReservation(updated);
    });
  }

  async cancel(
    id: string,
    dto: CancelReservationDto,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<ReservationView> {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await lockReservation(tx, id, actor.branchId);
      const from = reservation.status as ReservationStatus;

      if (!ALLOWED_STATUS_TRANSITIONS[from].includes(ReservationStatus.CANCELLED)) {
        throw new ConflictException(
          apiError(
            ErrorCode.ILLEGAL_STATUS_TRANSITION,
            'That booking has already finished and cannot be cancelled.',
            { from, to: ReservationStatus.CANCELLED },
          ),
        );
      }

      // Money has already changed hands on an IN_PROGRESS booking, so walking it
      // back is a manager's decision, not a desk decision. §6.4.
      if (from === ReservationStatus.IN_PROGRESS && !isManagerOrAbove(actor.role)) {
        throw new ForbiddenException(
          apiError(
            ErrorCode.INSUFFICIENT_ROLE,
            'Cancelling a treatment that has already started needs a manager.',
          ),
        );
      }

      const updated = await tx.reservation.update({
        where: { id: reservation.id },
        data: {
          status: ReservationStatus.CANCELLED,
          cancelledAt: new Date(),
          cancellationReason: dto.reason,
        },
        include: RESERVATION_INCLUDE,
      });

      // The base payment is NOT refunded here. A refund is a new, signed REFUND
      // row raised by a manager (§9.4); quietly reversing money on a cancel is
      // exactly the untraceable write the audit log exists to prevent.
      await this.audit.write(tx, ctx, {
        action: AuditAction.RESERVATION_CANCELLED,
        entityType: 'Reservation',
        entityId: reservation.id,
        beforeState: pickAuditFields(reservation),
        afterState: pickAuditFields(updated),
      });

      return presentReservation(updated);
    });
  }

  /** The guest never came. Terminal, and the slot frees the moment it is recorded. */
  async markNoShow(id: string, actor: AuthUser, ctx: RequestContext): Promise<ReservationView> {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await lockReservation(tx, id, actor.branchId);
      const from = reservation.status as ReservationStatus;

      if (!ALLOWED_STATUS_TRANSITIONS[from].includes(ReservationStatus.NO_SHOW)) {
        throw new ConflictException(
          apiError(
            ErrorCode.ILLEGAL_STATUS_TRANSITION,
            'Only a scheduled booking can be marked a no-show.',
            { from, to: ReservationStatus.NO_SHOW },
          ),
        );
      }

      const updated = await tx.reservation.update({
        where: { id: reservation.id },
        data: { status: ReservationStatus.NO_SHOW },
        include: RESERVATION_INCLUDE,
      });

      await this.audit.write(tx, ctx, {
        action: AuditAction.RESERVATION_NO_SHOW,
        entityType: 'Reservation',
        entityId: reservation.id,
        beforeState: pickAuditFields(reservation),
        afterState: pickAuditFields(updated),
      });

      return presentReservation(updated);
    });
  }

  /**
   * Reception types a name and a number. The (branch, phone) unique index means
   * the second visit finds the first guest instead of creating a twin, and an
   * anonymous walk-in books with no guest row at all — which is also why the
   * guest exclusion constraint is partial on `guest_id IS NOT NULL`.
   */
  private async resolveGuest(
    tx: Prisma.TransactionClient,
    dto: CreateReservationDto,
    branchId: string,
  ): Promise<string | null> {
    if (dto.guestId) {
      const guest = await tx.guest.findFirst({
        where: { id: dto.guestId, branchId, deletedAt: null },
      });
      if (!guest) {
        throw new NotFoundException(apiError(ErrorCode.NOT_FOUND, 'No such guest in this branch.'));
      }
      return guest.id;
    }

    if (dto.guestName && dto.guestPhone) {
      const guest = await tx.guest.upsert({
        where: { branchId_phone: { branchId, phone: dto.guestPhone } },
        create: {
          branchId,
          fullName: dto.guestName,
          phone: dto.guestPhone,
          email: dto.guestEmail ?? null,
        },
        // Never overwrite a known guest's name from a hurried retype; fill in an
        // email only if we did not already have one.
        update: { email: dto.guestEmail ?? undefined },
      });
      return guest.id;
    }

    return null;
  }
}

/**
 * `BR-2026-0417`. Reception reads this over the phone; nobody reads a UUID aloud. §3.4.
 *
 * The counter is a Postgres sequence rather than `SELECT max(ref) + 1`: nextval
 * is atomic and takes no lock, so twenty receptionists confirming at once get
 * twenty different refs without ever waiting on each other. It is also
 * non-transactional, so a rolled-back booking burns a number — gaps in the
 * series are expected and are not a data problem.
 */
async function nextReservationRef(tx: Prisma.TransactionClient, startsAt: Date): Promise<string> {
  const [row] = await tx.$queryRaw<{ seq: bigint | number | string }[]>`
    SELECT nextval('reservation_ref_seq') AS seq`;
  if (!row) throw new Error('reservation_ref_seq returned no value');

  // The year comes off the trading day, so a 01:30 booking on 1 January carries
  // the year its revenue reports under, not the calendar year. §3.3.
  const year = businessDay(startsAt).slice(0, 4);
  return `BR-${year}-${String(Number(row.seq)).padStart(4, '0')}`;
}
