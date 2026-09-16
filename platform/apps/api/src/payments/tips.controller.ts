import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ReverseTipDto, reverseTipSchema } from '@berelax/contracts';
import { Ctx, CurrentUser, Idempotent, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthUser, RequestContext } from '../common/request-context';
import { TipReversalHandler, TipReversalView } from './tip-reversal.handler';
import { MANAGER_PLUS } from './money.support';

@Controller('tips')
export class TipsController {
  constructor(private readonly reversals: TipReversalHandler) {}

  /**
   * Void a tip. MANAGER+ — reception records tips all evening and must not also
   * be able to unrecord them. §6.4.
   *
   * There is deliberately no PATCH here and never will be: the correction is a
   * new signed row, and the mistake stays visible next to it. §9.4.
   */
  @Post(':id/reverse')
  @Roles(...MANAGER_PLUS)
  @Idempotent()
  reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reverseTipSchema)) dto: ReverseTipDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<TipReversalView> {
    return this.reversals.reverse(id, dto, actor, ctx);
  }
}
