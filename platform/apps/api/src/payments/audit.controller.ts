import { Controller, Get, Query } from '@nestjs/common';
import { AuditQuery, auditQuerySchema } from '@berelax/contracts';
import { CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthUser } from '../common/request-context';
import { AuditQueryService, AuditSearchView } from './audit-query.service';
import { MANAGER_PLUS } from './money.support';

/**
 * The financial audit log. MANAGER+ only: reception takes money all evening
 * without ever seeing the totals, because the person handling cash should not
 * also be the person auditing it. §6.4.
 *
 * This is the endpoint you open when a therapist says September was short.
 * Filter by the booking or the batch (`entityId`), by who did it (`actorUserId`)
 * or by what was done (`action`), over a range of trading days. §9.7.
 */
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get()
  @Roles(...MANAGER_PLUS)
  find(
    @Query(new ZodValidationPipe(auditQuerySchema)) query: AuditQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<AuditSearchView> {
    return this.audit.find(query, actor);
  }
}
