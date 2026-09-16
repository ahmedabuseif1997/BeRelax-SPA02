import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: is the process up. */
  @Public()
  @Get()
  live(): { status: string; at: string } {
    return { status: 'ok', at: new Date().toISOString() };
  }

  /** Readiness: can it actually serve traffic. */
  @Public()
  @Get('ready')
  async ready(): Promise<{ status: string; database: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'up' };
    } catch {
      throw new ServiceUnavailableException({
        error: { code: 'DATABASE_UNAVAILABLE', message: 'Database is not reachable.' },
      });
    }
  }
}
