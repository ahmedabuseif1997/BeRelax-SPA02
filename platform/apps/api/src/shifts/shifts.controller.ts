import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ClockShiftDto,
  CreateShiftDto,
  UpdateShiftDto,
  UserRole,
  clockShiftSchema,
  createShiftSchema,
  updateShiftSchema,
} from '@berelax/contracts';
import { CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthUser } from '../common/request-context';
import {
  ListShiftsQuery,
  ShiftView,
  ShiftsService,
  listShiftsQuerySchema,
} from './shifts.service';

/** §7.3: planning the rota is MANAGER+. */
const MANAGER_PLUS = [UserRole.OWNER, UserRole.MANAGER] as const;

/** §7.3: the clocks are at the desk, and a THERAPIST may see their own line. §6.4. */
const ALL_STAFF = [
  UserRole.OWNER,
  UserRole.MANAGER,
  UserRole.RECEPTIONIST,
  UserRole.THERAPIST,
] as const;

const RECEPTIONIST_PLUS = [UserRole.OWNER, UserRole.MANAGER, UserRole.RECEPTIONIST] as const;

const clockBodyPipe = new ZodValidationPipe(clockShiftSchema);

@Controller('shifts')
@Roles(...MANAGER_PLUS)
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  /**
   * Wider than the planning endpoints below it: reception cannot clock a
   * therapist in without first finding the shift, and a rota line carries no
   * money — what §6.4 keeps from the desk is the earnings, not the roster.
   * The service narrows a THERAPIST to their own line.
   */
  @Get()
  @Roles(...ALL_STAFF)
  findMany(
    @Query(new ZodValidationPipe(listShiftsQuerySchema)) query: ListShiftsQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<ShiftView[]> {
    return this.shifts.findMany(query, actor);
  }

  @Post()
  plan(
    @Body(new ZodValidationPipe(createShiftSchema)) dto: CreateShiftDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ShiftView> {
    return this.shifts.plan(dto, actor);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateShiftSchema)) dto: UpdateShiftDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ShiftView> {
    return this.shifts.update(id, dto, actor);
  }

  @Post(':id/clock-in')
  @HttpCode(HttpStatus.OK)
  @Roles(...RECEPTIONIST_PLUS)
  clockIn(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(clockBodyPipe) dto: ClockShiftDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ShiftView> {
    return this.shifts.clockIn(id, dto, actor);
  }

  @Post(':id/clock-out')
  @HttpCode(HttpStatus.OK)
  @Roles(...RECEPTIONIST_PLUS)
  clockOut(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(clockBodyPipe) dto: ClockShiftDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ShiftView> {
    return this.shifts.clockOut(id, dto, actor);
  }
}
