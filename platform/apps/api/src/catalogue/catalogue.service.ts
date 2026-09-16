import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Room, Service, ServiceCategory } from '@prisma/client';
import { z } from 'zod';
import {
  CreateRoomDto,
  CreateServiceCategoryDto,
  CreateServiceDto,
  ErrorCode,
  UpdateRoomDto,
  UpdateServiceCategoryDto,
  UpdateServiceDto,
} from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction, AuditService, pickAuditFields } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import { apiError } from '../reservations/reservations.service';

/* ───────────────────────── presentation ───────────────────────── */

export interface ServiceCategoryView {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface ServiceView {
  id: string;
  categoryId: string;
  name: string;
  durationMinutes: number;
  /** Integer fils, all the way out. Formatting to AED happens once, in the UI. §3.1. */
  priceFils: number;
  description: string | null;
  requiresRoom: boolean;
  isActive: boolean;
  sortOrder: number;
  category?: ServiceCategoryView;
}

export interface RoomView {
  id: string;
  name: string;
  capacity: number;
  isActive: boolean;
}

type ServiceWithCategory = Service & { category?: ServiceCategory | null };

export function presentCategory(category: ServiceCategory): ServiceCategoryView {
  return {
    id: category.id,
    name: category.name,
    sortOrder: category.sortOrder,
    isActive: category.isActive,
  };
}

export function presentService(service: ServiceWithCategory): ServiceView {
  const view: ServiceView = {
    id: service.id,
    categoryId: service.categoryId,
    name: service.name,
    durationMinutes: service.durationMinutes,
    priceFils: service.priceFils,
    description: service.description,
    requiresRoom: service.requiresRoom,
    isActive: service.isActive,
    sortOrder: service.sortOrder,
  };
  if (service.category) view.category = presentCategory(service.category);
  return view;
}

export function presentRoom(room: Room): RoomView {
  return { id: room.id, name: room.name, capacity: room.capacity, isActive: room.isActive };
}

/* ───────────────────────── query contract ───────────────────────── */

/** Query strings are strings: `?includeInactive=false` must not read as truthy. */
const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

export const listCatalogueQuerySchema = z.object({
  /** The menu is the live menu by default; retired lines are opt-in. */
  includeInactive: flag.default('false'),
});
export type ListCatalogueQuery = z.infer<typeof listCatalogueQuerySchema>;

export const listServicesQuerySchema = listCatalogueQuerySchema.extend({
  categoryId: z.string().uuid().optional(),
});
export type ListServicesQuery = z.infer<typeof listServicesQuerySchema>;

const CATEGORY_INCLUDE = { category: true } satisfies Prisma.ServiceInclude;
const CATALOGUE_ORDER = [{ sortOrder: 'asc' }, { name: 'asc' }] as const;

/* ───────────────────────── the service ───────────────────────── */

/**
 * One module, three resources: the menu, the headings it hangs under and the
 * rooms the treatments happen in. They change together — a new treatment needs
 * a category and a room to be bookable — and splitting them into three modules
 * would buy nothing but three more files.
 *
 * Nothing here is ever deleted. A retired treatment is `isActive: false`,
 * because its price is quoted on reservations going back years and the foreign
 * keys are RESTRICT for exactly that reason.
 */
@Injectable()
export class CatalogueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /* ── services ── */

  async findServices(query: ListServicesQuery, actor: AuthUser): Promise<ServiceView[]> {
    const where: Prisma.ServiceWhereInput = { branchId: actor.branchId };
    if (!query.includeInactive) where.isActive = true;
    if (query.categoryId) where.categoryId = query.categoryId;

    const rows = await this.prisma.service.findMany({
      where,
      include: CATEGORY_INCLUDE,
      orderBy: [...CATALOGUE_ORDER],
    });
    return rows.map(presentService);
  }

  async findService(id: string, actor: AuthUser): Promise<ServiceView> {
    const service = await this.prisma.service.findFirst({
      where: { id, branchId: actor.branchId },
      include: CATEGORY_INCLUDE,
    });
    if (!service) {
      throw new NotFoundException(
        apiError(ErrorCode.NOT_FOUND, 'That service is not on this branch’s menu.'),
      );
    }
    return presentService(service);
  }

  async createService(dto: CreateServiceDto, actor: AuthUser): Promise<ServiceView> {
    await this.assertCategoryExists(dto.categoryId);

    const service = await this.prisma.service.create({
      data: {
        // From the TOKEN, never the body. §6.6.
        branchId: actor.branchId,
        categoryId: dto.categoryId,
        name: dto.name,
        durationMinutes: dto.durationMinutes,
        priceFils: dto.priceFils,
        description: dto.description ?? null,
        requiresRoom: dto.requiresRoom ?? true,
        isActive: dto.isActive ?? true,
        sortOrder: dto.sortOrder ?? 0,
      },
      include: CATEGORY_INCLUDE,
    });
    return presentService(service);
  }

  /**
   * A price change is audited with before/after (§9.6) and touches NOTHING else.
   * `Reservation.baseCostFils` is a snapshot taken when the booking was made, so
   * tonight's bookings settle at tonight's price however often the menu changes
   * — rewriting history to match a new price list is how a guest gets charged
   * an amount nobody quoted them.
   */
  async updateService(
    id: string,
    dto: UpdateServiceDto,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<ServiceView> {
    if (dto.categoryId) await this.assertCategoryExists(dto.categoryId);

    const updated = await this.prisma.$transaction(async (tx) => {
      // Read inside the transaction, so the `beforeState` the audit records is
      // the state this write actually replaced and not one from a moment ago.
      const service = await tx.service.findFirst({ where: { id, branchId: actor.branchId } });
      if (!service) {
        throw new NotFoundException(
          apiError(ErrorCode.NOT_FOUND, 'That service is not on this branch’s menu.'),
        );
      }
      const priceChanged = dto.priceFils !== undefined && dto.priceFils !== service.priceFils;

      const row = await tx.service.update({
        where: { id: service.id },
        data: {
          ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.durationMinutes !== undefined ? { durationMinutes: dto.durationMinutes } : {}),
          ...(dto.priceFils !== undefined ? { priceFils: dto.priceFils } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.requiresRoom !== undefined ? { requiresRoom: dto.requiresRoom } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        },
        include: CATEGORY_INCLUDE,
      });

      if (priceChanged) {
        await this.audit.write(tx, ctx, {
          action: AuditAction.SERVICE_PRICE_CHANGED,
          entityType: 'Service',
          entityId: row.id,
          beforeState: pickAuditFields(service),
          afterState: pickAuditFields(row),
          amountFils: row.priceFils,
        });
      }

      return row;
    });

    return presentService(updated);
  }

  /* ── categories ── */

  /**
   * Categories carry no `branch_id`: they are the menu's headings, shared by
   * every branch, which is why `name` is globally unique.
   */
  async findCategories(query: ListCatalogueQuery): Promise<ServiceCategoryView[]> {
    const where: Prisma.ServiceCategoryWhereInput = {};
    if (!query.includeInactive) where.isActive = true;

    const rows = await this.prisma.serviceCategory.findMany({
      where,
      orderBy: [...CATALOGUE_ORDER],
    });
    return rows.map(presentCategory);
  }

  async createCategory(dto: CreateServiceCategoryDto): Promise<ServiceCategoryView> {
    try {
      const category = await this.prisma.serviceCategory.create({
        data: {
          name: dto.name,
          sortOrder: dto.sortOrder ?? 0,
          isActive: dto.isActive ?? true,
        },
      });
      return presentCategory(category);
    } catch (error) {
      throw asNameConflict(error, ErrorCode.CATEGORY_NAME_TAKEN, 'A category already has that name.');
    }
  }

  async updateCategory(
    id: string,
    dto: UpdateServiceCategoryDto,
  ): Promise<ServiceCategoryView> {
    const category = await this.prisma.serviceCategory.findUnique({ where: { id } });
    if (!category) {
      throw new NotFoundException(apiError(ErrorCode.NOT_FOUND, 'No such service category.'));
    }

    try {
      const updated = await this.prisma.serviceCategory.update({
        where: { id: category.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
      return presentCategory(updated);
    } catch (error) {
      throw asNameConflict(error, ErrorCode.CATEGORY_NAME_TAKEN, 'A category already has that name.');
    }
  }

  /* ── rooms ── */

  async findRooms(query: ListCatalogueQuery, actor: AuthUser): Promise<RoomView[]> {
    const where: Prisma.RoomWhereInput = { branchId: actor.branchId };
    if (!query.includeInactive) where.isActive = true;

    const rows = await this.prisma.room.findMany({ where, orderBy: { name: 'asc' } });
    return rows.map(presentRoom);
  }

  async createRoom(dto: CreateRoomDto, actor: AuthUser): Promise<RoomView> {
    try {
      const room = await this.prisma.room.create({
        data: {
          branchId: actor.branchId,
          name: dto.name,
          capacity: dto.capacity ?? 1,
          isActive: dto.isActive ?? true,
        },
      });
      return presentRoom(room);
    } catch (error) {
      throw asNameConflict(
        error,
        ErrorCode.ROOM_NAME_TAKEN,
        'A room in this branch already has that name.',
      );
    }
  }

  /**
   * Renaming or retiring a room does not disturb a booking that holds it: the
   * reservation keeps the room id, and the room exclusion constraint keeps
   * arbitrating. Deactivating simply takes it off tomorrow's grid.
   */
  async updateRoom(id: string, dto: UpdateRoomDto, actor: AuthUser): Promise<RoomView> {
    const room = await this.prisma.room.findFirst({ where: { id, branchId: actor.branchId } });
    if (!room) {
      throw new NotFoundException(apiError(ErrorCode.NOT_FOUND, 'No such room in this branch.'));
    }

    try {
      const updated = await this.prisma.room.update({
        where: { id: room.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
      return presentRoom(updated);
    } catch (error) {
      throw asNameConflict(
        error,
        ErrorCode.ROOM_NAME_TAKEN,
        'A room in this branch already has that name.',
      );
    }
  }

  private async assertCategoryExists(categoryId: string): Promise<void> {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) {
      throw new UnprocessableEntityException(
        apiError(ErrorCode.VALIDATION_FAILED, 'That service category does not exist.', {
          issues: [{ path: 'categoryId', message: 'Unknown category.' }],
        }),
      );
    }
  }
}

/** The unique index is the arbiter, not a pre-flight lookup that loses the race. */
function asNameConflict(error: unknown, code: ErrorCode, message: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictException(apiError(code, message));
  }
  return error;
}
