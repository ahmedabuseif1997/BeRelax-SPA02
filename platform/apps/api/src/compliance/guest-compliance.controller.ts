import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { EraseGuestDto, UserRole, eraseGuestSchema } from '@berelax/contracts';
import { Ctx, CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthUser, RequestContext } from '../common/request-context';
import { GuestExportBundle, GuestExportService } from './guest-export.service';
import { GuestErasureService, GuestErasureView } from './guest-erasure.service';

/**
 * Data subject rights, §7.5. Both routes are MANAGER+ and both write to the
 * financial audit log — reception takes bookings, a manager answers a legal
 * request, and either of these is a legal request. §6.4.
 *
 * They live on `/guests/:id` beside reception's CRUD because that is where a
 * dashboard will look for them, and in their own controller because they are not
 * reception's to call. The role gate is per controller, not per route: there is
 * no widening exception here and there should never be one.
 */
@Controller('guests')
@Roles(UserRole.OWNER, UserRole.MANAGER)
export class GuestComplianceController {
  constructor(
    private readonly exporter: GuestExportService,
    private readonly erasure: GuestErasureService,
  ) {}

  /**
   * The answer to an access request AND a portability request at once, PDPL
   * Arts. 13-15. Complete or it has failed: a partial export is a partial answer
   * to a legal request, which is not an answer. §11.4.
   */
  @Get(':id/export')
  export(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<GuestExportBundle> {
    return this.exporter.export(id, actor, ctx);
  }

  /**
   * An ANONYMISATION, not a DELETE — and the response says so item by item, so
   * the manager who ran it can see both what went and what stayed. The
   * reservations and payments stay because UAE tax law requires five years of
   * accounting records and the right to erasure yields to another legal
   * obligation; the person is severed from the transaction instead. §11.4.
   *
   * 200 rather than 204: the result is evidence of what was done, and the person
   * answering a guest's erasure request needs to be able to show it.
   */
  @Post(':id/erase')
  @HttpCode(HttpStatus.OK)
  erase(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(eraseGuestSchema)) dto: EraseGuestDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<GuestErasureView> {
    return this.erasure.erase(id, dto.reason, actor, ctx);
  }
}
