import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { RetentionRunDto, UserRole, retentionRunSchema } from '@berelax/contracts';
import { Ctx, CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthUser, RequestContext } from '../common/request-context';
import { ProcessingRegister, ProcessingRegisterService } from './processing-register.service';
import { RetentionRunReport, RetentionService } from './retention.service';

/**
 * The controller-level obligations: what is kept and for how long (§11.6), and
 * the record of processing activities (Art. 7, §11.7).
 *
 * OWNER only — a tighter gate than the MANAGER+ of the data subject rights
 * endpoints, and deliberately so. Running retention anonymises guests in bulk and
 * the register is the document handed to a regulator; neither is a shift
 * decision. §6.4 puts "create / disable users" at OWNER for the same reason.
 */
@Controller('compliance')
@Roles(UserRole.OWNER)
export class ComplianceController {
  constructor(
    private readonly retention: RetentionService,
    private readonly register: ProcessingRegisterService,
  ) {}

  /**
   * The manual trigger. `pg_cron` runs `prune_attribution()` nightly without
   * anyone's help (see the retention-schedule migration), but the guest half
   * needs an actor to write `GUEST_ERASED` against — and the first run against
   * real data should be a decision somebody made, with `dryRun` first.
   */
  @Post('retention/run')
  @HttpCode(HttpStatus.OK)
  run(
    @Body(new ZodValidationPipe(retentionRunSchema)) dto: RetentionRunDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<RetentionRunReport> {
    return this.retention.run(dto, actor, ctx);
  }

  /** PDPL Art. 7: what is collected, why, on what basis, where it goes, how long it is kept. */
  @Get('processing-register')
  processingRegister(@CurrentUser() actor: AuthUser): Promise<ProcessingRegister> {
    return this.register.build(actor);
  }
}
