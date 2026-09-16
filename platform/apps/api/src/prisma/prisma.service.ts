import { INestApplication, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async enableShutdownHooks(app: INestApplication): Promise<void> {
    process.on('beforeExit', () => {
      void app.close();
    });
  }

  /**
   * Truncate everything except the migration history. Test support only — it
   * refuses to run unless NODE_ENV is 'test', because the one thing worse than
   * no CRM is a CRM that empties itself.
   */
  async truncateAll(): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('truncateAll() is only available when NODE_ENV=test');
    }
    const tables = await this.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'`;
    const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
    if (list) await this.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
  }
}
