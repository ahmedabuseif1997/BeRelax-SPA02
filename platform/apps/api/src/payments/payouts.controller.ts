import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CreatePayoutDto, UserRole, createPayoutSchema } from '@berelax/contracts';
import { Ctx, CurrentUser, Idempotent, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthUser, RequestContext } from '../common/request-context';
import { PayoutBatchView, PayoutHandler } from './payout.handler';
import { MANAGER_PLUS } from './money.support';

@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payouts: PayoutHandler) {}

  /** Approve and record a settlement. MANAGER+. §6.4, §9.5. */
  @Post()
  @Roles(...MANAGER_PLUS)
  @Idempotent()
  create(
    @Body(new ZodValidationPipe(createPayoutSchema)) dto: CreatePayoutDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<PayoutBatchView> {
    return this.payouts.create(dto, actor, ctx);
  }

  /**
   * THERAPIST only, and only their own batch.
   *
   * Not MANAGER+: a receipt signed by the person who approved the payment is
   * not a receipt. The handler checks the batch belongs to this login before it
   * writes anything, so a therapist cannot acknowledge a colleague's money
   * either. §9.5.
   */
  @Post(':id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.THERAPIST)
  acknowledge(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<PayoutBatchView> {
    return this.payouts.acknowledge(id, actor, ctx);
  }
}
