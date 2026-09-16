import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  CreateAdjustmentDto,
  RefundPaymentDto,
  createAdjustmentSchema,
  refundPaymentSchema,
} from '@berelax/contracts';
import { Ctx, CurrentUser, Idempotent, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthUser, RequestContext } from '../common/request-context';
import { AdjustmentView, RefundHandler, RefundView } from './refund.handler';
import { MANAGER_PLUS } from './money.support';

/**
 * Corrections to collected money. MANAGER+ throughout: the person handling cash
 * at the desk is not the person who gets to send it back out again. §6.4.
 *
 * Both routes are `@Idempotent()`. A manager on the same patchy iPad as
 * reception taps Refund, the request times out, they tap it again — and without
 * the key the guest is refunded twice. §7.6.
 */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly refunds: RefundHandler) {}

  /** Money going back to the guest, against one payment. §9.4. */
  @Post(':id/refund')
  @Roles(...MANAGER_PLUS)
  @Idempotent()
  refund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(refundPaymentSchema)) dto: RefundPaymentDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<RefundView> {
    return this.refunds.refund(id, dto, actor, ctx);
  }

  /**
   * A discount or a correction against a booking, with a mandatory reason.
   * Not under `/:id` because an adjustment corrects the BOOKING's position, not
   * one payment line — there may be no single line it belongs to. §8.2.
   */
  @Post('adjustments')
  @Roles(...MANAGER_PLUS)
  @Idempotent()
  adjust(
    @Body(new ZodValidationPipe(createAdjustmentSchema)) dto: CreateAdjustmentDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<AdjustmentView> {
    return this.refunds.adjust(dto, actor, ctx);
  }
}
