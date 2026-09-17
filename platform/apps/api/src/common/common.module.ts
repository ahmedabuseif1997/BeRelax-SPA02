import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { PgThrottlerStorage } from './pg-throttler.storage';

@Global()
@Module({
  // PgThrottlerStorage lives here rather than in ThrottlerModule's own factory
  // so that Nest constructs it — the factory would have to `new` it, and a
  // provider Nest did not build gets no lifecycle hooks and no place to stand
  // in a test.
  providers: [AuditService, PgThrottlerStorage],
  exports: [AuditService, PgThrottlerStorage],
})
export class CommonModule {}
