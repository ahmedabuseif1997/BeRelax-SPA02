import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, SourceChannel } from '@prisma/client';
import {
  AttributionPayload,
  ErrorCode,
  PublicBookingRequestDto,
  formatAed,
} from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { screenPublicText } from '../common/medical-screen';
import type { Env } from '../config/env';
import { apiError } from '../reservations/reservations.service';
import { publicReference } from '../booking-requests/booking-requests.service';

/*
 * Everything the website talks to. No token, no session, no staff.
 *
 * Two rules run through the whole file:
 *
 *  1. NOTHING HERE HOLDS A RESOURCE. A website enquiry lands in
 *     `booking_requests`, which has no therapist, no room and no time window on
 *     it, so nobody's evening is committed by a form submission and no public
 *     caller can create a booking conflict. Reception converts it later, and
 *     THAT insert is the one the exclusion constraints arbitrate. §1.1, §5.5.
 *
 *  2. THE REPLY TELLS AN ANONYMOUS CALLER NOTHING. No database ids, no guest
 *     lookup result, no "welcome back" — a form that answers differently for a
 *     known number is a phone-number oracle for anyone who wants to know who
 *     the spa's customers are.
 */

/** §10.5. The mirror cookie, set server-side so Safari's ITP cannot cap it at 7 days. */
export const VISITOR_COOKIE = 'brx_vid';

/** §10.1. The attribution window the whole model is built around. */
export const ATTRIBUTION_WINDOW_DAYS = 90;

export interface PublicServiceView {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  /** Integer fils, always. §3.1. */
  priceFils: number;
  /** "AED 250.00" — rendered once, here, so every surface agrees. */
  priceFormatted: string;
}

export interface PublicMenuCategory {
  id: string;
  name: string;
  services: PublicServiceView[];
}

export interface PublicMenuView {
  categories: PublicMenuCategory[];
}

/**
 * Everything the website is told about an enquiry it just filed. `ok` so the
 * form can branch without parsing, `reference` so the guest has something to
 * quote — and nothing else, ever.
 */
export interface PublicBookingReceipt {
  ok: true;
  reference: string;
}

@Injectable()
export class PublicService {
  private readonly logger = new Logger(PublicService.name);
  private readonly configuredBranchId: string | undefined;
  private readonly erasureSalt: string;
  /** Resolved at most once per process; see `resolveBranchId`. */
  private discoveredBranchId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.configuredBranchId = config.get('DEFAULT_BRANCH_ID', { infer: true });
    this.erasureSalt = String(config.get('ERASURE_SALT', { infer: true }));
  }

  /**
   * The live menu, exactly as the website's pricing section renders it.
   *
   * One query: categories with their services attached. A category whose
   * services are all withdrawn drops out entirely rather than rendering an
   * empty heading, which is why the filter is on the relation and not applied
   * afterwards in JavaScript.
   */
  async menu(): Promise<PublicMenuView> {
    const branchId = await this.resolveBranchId();

    const categories = await this.prisma.serviceCategory.findMany({
      where: { isActive: true, services: { some: { branchId, isActive: true } } },
      select: {
        id: true,
        name: true,
        services: {
          where: { branchId, isActive: true },
          select: {
            id: true,
            name: true,
            description: true,
            durationMinutes: true,
            priceFils: true,
          },
          orderBy: [{ sortOrder: 'asc' }, { durationMinutes: 'asc' }],
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    return {
      categories: categories.map((category) => ({
        id: category.id,
        name: category.name,
        services: category.services.map((service) => ({
          ...service,
          priceFormatted: formatAed(service.priceFils),
        })),
      })),
    };
  }

  /**
   * The website booking form.
   *
   * The attribution blob and the enquiry are written in one transaction: a
   * snapshot with no enquiry hanging off it is a row nobody will ever join to,
   * and an enquiry whose attribution was lost is a booking the channel report
   * will silently credit to "direct".
   */
  async createBookingRequest(dto: PublicBookingRequestDto): Promise<PublicBookingReceipt> {
    const branchId = await this.resolveBranchId();

    const id = await this.prisma.$transaction(async (tx) => {
      // A fresh snapshot per enquiry, not a reuse of the beacon's row: the
      // `attribution_id` on `booking_requests` is UNIQUE, and the snapshot that
      // is attached to a conversion is evidence — it must stop moving the moment
      // it is linked, while the beacon keeps updating as the visitor browses.
      const attributionId = dto.attribution
        ? (await tx.attributionSnapshot.create({ data: snapshotData(dto.attribution) })).id
        : null;

      // A service id the caller made up, or one from another branch, is dropped
      // rather than refused. Answering "no such service" to an anonymous caller
      // turns this form into a way to enumerate the catalogue, and the enquiry
      // is still worth having: reception rings back and asks what they wanted.
      const requestedServiceId = dto.requestedServiceId
        ? ((
            await tx.service.findFirst({
              where: { id: dto.requestedServiceId, branchId, isActive: true },
              select: { id: true },
            })
          )?.id ?? null)
        : null;

      const created = await tx.bookingRequest.create({
        data: {
          branchId,
          // Deliberately NOT linked to a guest, and deliberately not creating
          // one. A guest record is made when reception converts the enquiry,
          // which keeps a spam run out of the guest table and keeps this
          // endpoint from reading anybody's personal data to answer a stranger.
          guestId: null,
          guestName: dto.guestName,
          guestPhone: dto.guestPhone,
          guestEmail: dto.guestEmail ?? null,
          requestedServiceId,
          requestedAt: dto.requestedAt ? new Date(dto.requestedAt) : null,
          // The guest is not staff and cannot be taught a rule: refusing the
          // enquiry because they mentioned a shoulder would lose the booking
          // and teach them nothing. Accept it, keep the preference text only,
          // and let them tell the therapist in person. §11.5.
          message: screenPublicText(dto.message).text,
          sourceChannel: SourceChannel.WEBSITE_FORM,
          attributionId,
        },
        select: { id: true },
      });
      return created.id;
    });

    return { ok: true, reference: publicReference(id, this.erasureSalt) };
  }

  /**
   * The beacon `attribution.js` fires on every new touch.
   *
   * This reads before it writes, which everywhere else in this codebase would
   * be the bug (§5.5) — here it is not, and the difference is worth being
   * precise about. A check-then-insert is only dangerous when it decides
   * whether a scarce thing may be taken. Nothing is scarce here: the worst a
   * lost race can do is leave two snapshot rows for one visitor, and the
   * channel report already groups by visitor. There is no constraint to lean on
   * because there is nothing to protect.
   *
   * `visitor_id` is indexed but not unique, so this cannot be a real upsert.
   * Snapshots already attached to an enquiry or a booking are skipped: those
   * are the evidence behind a conversion and must never be rewritten by a later
   * visit.
   */
  async recordTouch(payload: AttributionPayload): Promise<void> {
    const data = snapshotData(payload);

    const open = await this.prisma.attributionSnapshot.findFirst({
      where: {
        visitorId: payload.visitorId,
        bookingRequest: { is: null },
        reservations: { none: {} },
        // A pruned row has had its identifiers stripped at 90 days (§11.6);
        // refilling it would undo the retention job.
        prunedAt: null,
      },
      orderBy: { capturedAt: 'desc' },
      select: { id: true },
    });

    if (open) {
      await this.prisma.attributionSnapshot.update({ where: { id: open.id }, data });
      return;
    }
    await this.prisma.attributionSnapshot.create({ data });
  }

  /**
   * Which branch an anonymous caller is talking to.
   *
   * Authenticated routes take the branch from the token and never from a body
   * (§6.6). A public caller has no token, so the answer has to come from
   * configuration: `DEFAULT_BRANCH_ID`.
   *
   * The fallback exists because v1 is one branch in practice (§15.6) and
   * failing the website's pricing section until somebody pastes a UUID into an
   * env file buys no safety at all when there is only one possible answer. It
   * is a fallback and not a default: the moment a second branch row exists this
   * throws instead of guessing which one the guest meant, because guessing
   * would file an Abu Dhabi enquiry against a Dubai inbox.
   *
   * Cached for the life of the process — it is deployment configuration, not
   * data, and a count() on every public request to re-learn a constant is a
   * query the busiest endpoints do not need. Opening a second branch therefore
   * needs `DEFAULT_BRANCH_ID` set and a restart, which is the correct amount of
   * ceremony for opening a second branch.
   */
  private async resolveBranchId(): Promise<string> {
    if (this.configuredBranchId) return this.configuredBranchId;
    if (this.discoveredBranchId) return this.discoveredBranchId;

    const branches = await this.prisma.branch.findMany({ select: { id: true }, take: 2 });
    const only = branches.length === 1 ? branches[0]! : null;

    if (!only) {
      this.logger.error(
        { branchCount: branches.length },
        'DEFAULT_BRANCH_ID is unset and the branch cannot be inferred',
      );
      throw new InternalServerErrorException(
        apiError(
          ErrorCode.BRANCH_NOT_CONFIGURED,
          'This site is not fully configured yet. Please call us instead.',
        ),
      );
    }

    this.discoveredBranchId = only.id;
    return only.id;
  }
}

/**
 * The client's `AttributionStore` (§10.1) as the columns hold it.
 *
 * `touchCount` is the number of touches RETAINED, not the number that ever
 * happened: the script caps the list at ten and drops the oldest middle touches
 * first. That is the honest figure, because it is the only one the row can
 * still support.
 */
function snapshotData(payload: AttributionPayload): Prisma.AttributionSnapshotCreateInput {
  return {
    visitorId: payload.visitorId,
    firstTouch: payload.first as unknown as Prisma.InputJsonValue,
    lastTouch: payload.last as unknown as Prisma.InputJsonValue,
    touches: payload.touches as unknown as Prisma.InputJsonValue,
    touchCount: payload.touches.length,
    firstSeenAt: new Date(payload.createdAt),
    lastSeenAt: new Date(payload.updatedAt),
    // Path only. The full URL would carry the query string, and the query string
    // is where somebody's email address ends up. §10.1.
    landingPath: payload.last.landing ?? payload.first.landing ?? null,
  };
}
