import { Controller, Get, Query } from '@nestjs/common';
import { AvailabilityQuery, UserRole, availabilityQuerySchema } from '@berelax/contracts';
import { CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthUser } from '../common/request-context';
import { AvailabilityService, AvailabilityView } from './availability.service';

/**
 * Every staff role reads the grid. Unlike `/reservations` a THERAPIST is NOT
 * narrowed to themselves here: the response carries no guest, no money and no
 * booking ids — only who is on shift and which hours are open, which is the
 * same information as the rota on the staff-room wall. §6.4, §7.3.
 */
const ALL_STAFF = [
  UserRole.OWNER,
  UserRole.MANAGER,
  UserRole.RECEPTIONIST,
  UserRole.THERAPIST,
] as const;

@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  @Roles(...ALL_STAFF)
  find(
    @Query(new ZodValidationPipe(availabilityQuerySchema)) query: AvailabilityQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<AvailabilityView> {
    return this.availability.find(query, actor);
  }
}
