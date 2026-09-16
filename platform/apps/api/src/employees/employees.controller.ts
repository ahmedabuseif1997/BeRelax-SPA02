import {
  Body,
  Controller,
  Delete,
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
  CreateEmployeeDto,
  UpdateEmployeeCommissionDto,
  UpdateEmployeeDto,
  UpdateEmployeeStatusDto,
  UserRole,
  createEmployeeSchema,
  updateEmployeeCommissionSchema,
  updateEmployeeSchema,
  updateEmployeeStatusSchema,
} from '@berelax/contracts';
import { Ctx, CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthUser, RequestContext } from '../common/request-context';
import {
  EmployeeView,
  EmployeesService,
  ListEmployeesQuery,
  listEmployeesQuerySchema,
} from './employees.service';

/** §6.4: "Manage employees" is OWNER and MANAGER. Reception never reaches this controller. */
const MANAGER_PLUS = [UserRole.OWNER, UserRole.MANAGER] as const;

@Controller('employees')
@Roles(...MANAGER_PLUS)
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  findMany(
    @Query(new ZodValidationPipe(listEmployeesQuerySchema)) query: ListEmployeesQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<EmployeeView[]> {
    return this.employees.findMany(query, actor);
  }

  /**
   * Widened to THERAPIST so the "own only" cell of the §6.4 legal-name row is
   * reachable at all; the service narrows them to their own record and 404s the
   * rest. The guard cannot know whose record an id is at routing time.
   */
  @Get(':id')
  @Roles(...MANAGER_PLUS, UserRole.THERAPIST)
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<EmployeeView> {
    return this.employees.findOne(id, actor);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createEmployeeSchema)) dto: CreateEmployeeDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<EmployeeView> {
    return this.employees.create(dto, actor);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateEmployeeSchema)) dto: UpdateEmployeeDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<EmployeeView> {
    return this.employees.update(id, dto, actor);
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateEmployeeStatusSchema)) dto: UpdateEmployeeStatusDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<EmployeeView> {
    return this.employees.setStatus(id, dto, actor);
  }

  /** Audited with before/after: this is what the business owes on every future treatment. §9.6. */
  @Post(':id/commission')
  @HttpCode(HttpStatus.OK)
  setCommission(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateEmployeeCommissionSchema)) dto: UpdateEmployeeCommissionDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<EmployeeView> {
    return this.employees.setCommission(id, dto, actor, ctx);
  }

  /** Soft delete. §3.5 — an employee row is never removed from the database. */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<EmployeeView> {
    return this.employees.remove(id, actor);
  }
}
