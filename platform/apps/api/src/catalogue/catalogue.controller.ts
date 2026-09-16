import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateRoomDto,
  CreateServiceCategoryDto,
  CreateServiceDto,
  UpdateRoomDto,
  UpdateServiceCategoryDto,
  UpdateServiceDto,
  UserRole,
  createRoomSchema,
  createServiceCategorySchema,
  createServiceSchema,
  updateRoomSchema,
  updateServiceCategorySchema,
  updateServiceSchema,
} from '@berelax/contracts';
import { Ctx, CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthUser, RequestContext } from '../common/request-context';
import {
  CatalogueService,
  ListCatalogueQuery,
  ListServicesQuery,
  RoomView,
  ServiceCategoryView,
  ServiceView,
  listCatalogueQuerySchema,
  listServicesQuerySchema,
} from './catalogue.service';

/** §6.4: "Edit the service catalogue and prices" is OWNER and MANAGER. */
const MANAGER_PLUS = [UserRole.OWNER, UserRole.MANAGER] as const;

/**
 * Reading the menu is wider than editing it: reception cannot take a booking
 * without the treatment list, its durations and its prices, and a therapist
 * needs to know which room they are in. A price list is not a revenue total —
 * what §6.4 keeps from the desk is the takings, not the menu.
 */
const ALL_STAFF = [
  UserRole.OWNER,
  UserRole.MANAGER,
  UserRole.RECEPTIONIST,
  UserRole.THERAPIST,
] as const;

const catalogueQueryPipe = new ZodValidationPipe(listCatalogueQuerySchema);

@Controller('services')
@Roles(...MANAGER_PLUS)
export class ServicesController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Get()
  @Roles(...ALL_STAFF)
  findMany(
    @Query(new ZodValidationPipe(listServicesQuerySchema)) query: ListServicesQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<ServiceView[]> {
    return this.catalogue.findServices(query, actor);
  }

  @Get(':id')
  @Roles(...ALL_STAFF)
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<ServiceView> {
    return this.catalogue.findService(id, actor);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createServiceSchema)) dto: CreateServiceDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ServiceView> {
    return this.catalogue.createService(dto, actor);
  }

  /** A `priceFils` change is audited with before/after and leaves bookings alone. §9.6. */
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateServiceSchema)) dto: UpdateServiceDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<ServiceView> {
    return this.catalogue.updateService(id, dto, actor, ctx);
  }
}

@Controller('service-categories')
@Roles(...MANAGER_PLUS)
export class ServiceCategoriesController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Get()
  @Roles(...ALL_STAFF)
  findMany(
    @Query(catalogueQueryPipe) query: ListCatalogueQuery,
  ): Promise<ServiceCategoryView[]> {
    return this.catalogue.findCategories(query);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createServiceCategorySchema)) dto: CreateServiceCategoryDto,
  ): Promise<ServiceCategoryView> {
    return this.catalogue.createCategory(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateServiceCategorySchema)) dto: UpdateServiceCategoryDto,
  ): Promise<ServiceCategoryView> {
    return this.catalogue.updateCategory(id, dto);
  }
}

@Controller('rooms')
@Roles(...MANAGER_PLUS)
export class RoomsController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Get()
  @Roles(...ALL_STAFF)
  findMany(
    @Query(catalogueQueryPipe) query: ListCatalogueQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<RoomView[]> {
    return this.catalogue.findRooms(query, actor);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createRoomSchema)) dto: CreateRoomDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<RoomView> {
    return this.catalogue.createRoom(dto, actor);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateRoomSchema)) dto: UpdateRoomDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<RoomView> {
    return this.catalogue.updateRoom(id, dto, actor);
  }
}
