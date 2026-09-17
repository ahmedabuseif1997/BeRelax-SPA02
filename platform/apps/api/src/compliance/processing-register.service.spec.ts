import type { ConfigService } from '@nestjs/config';
import { UserRole } from '@berelax/contracts';
import type { AuthUser } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { LawfulBasis, ProcessingRegisterService } from './processing-register.service';

/**
 * §11.7 item 4, PDPL Art. 7. The register is only worth having if it is DERIVED,
 * so the tests that matter here are the drift tests: a column that leaves the
 * schema and a table that joins it both have to show up as findings rather than
 * as silence. A register that cannot notice the schema moving is a document, not
 * a control.
 */

const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';

function actorFixture(): AuthUser {
  return {
    id: '0192dddd-0000-7000-8000-00000000000d',
    role: UserRole.OWNER,
    branchId: BRANCH_ID,
    email: 'owner@berelax.ae',
    fullName: 'Owner',
  };
}

/** Every table the register declares, with the columns it names as personal data. */
const SCHEMA: Record<string, string[]> = {
  guests: ['id', 'branch_id', 'full_name', 'phone', 'email', 'notes', 'anonymised_at'],
  reservations: ['id', 'guest_id', 'notes', 'cancellation_reason', 'base_cost_fils'],
  booking_requests: ['id', 'guest_name', 'guest_phone', 'guest_email', 'message'],
  payments: ['id', 'amount_fils'],
  tips: ['id', 'amount_fils'],
  therapist_payout_ledger: ['id', 'amount_fils'],
  payout_batches: ['id', 'total_fils'],
  guest_consents: ['id', 'guest_id', 'type', 'policy_version', 'ip_address'],
  attribution_snapshots: ['id', 'visitor_id', 'touches', 'first_touch', 'last_touch', 'landing_path'],
  outbound_clicks: ['id', 'visitor_id', 'landing_path', 'referrer', 'user_agent'],
  employees: ['id', 'display_name', 'legal_name', 'phone', 'photo_url'],
  users: ['id', 'email', 'full_name'],
  shifts: ['id', 'note'],
  refresh_tokens: ['id', 'ip_address', 'user_agent'],
  financial_audit_log: ['id', 'ip_address', 'user_agent'],
  idempotency_records: ['key'],
  nightly_reconciliations: ['id', 'business_day', 'verdict', 'submitted_by_user_id'],
  rate_limit_counters: ['key', 'throttler', 'hits', 'window_ends_at', 'blocked_until'],
  // Declared as holding no personal data, so absent from every activity and
  // deliberately NOT a drift finding.
  branches: ['id', 'name'],
  services: ['id', 'name'],
  service_categories: ['id', 'name'],
  rooms: ['id', 'name'],
  _prisma_migrations: ['id'],
};

function setup(
  options: { schema?: Record<string, string[]>; cron?: boolean; installed?: boolean } = {},
) {
  const schema = options.schema ?? SCHEMA;

  const prisma = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('information_schema.columns')) {
        return Object.entries(schema).flatMap(([table, columns]) =>
          columns.map((column) => ({
            table_name: table,
            column_name: column,
            data_type: 'text',
            is_nullable: 'YES',
          })),
        );
      }
      if (sql.includes('pg_class')) {
        return Object.keys(schema).map((relname) => ({ relname, rows: 125 }));
      }
      if (sql.includes('to_regprocedure')) {
        return [{ installed: options.installed ?? true, cron: options.cron ?? false }];
      }
      if (sql.includes('cron.job')) return [{ schedule: '30 3 * * *', active: true }];
      return [];
    }),
    branch: {
      findUnique: jest.fn(async () => ({
        id: BRANCH_ID,
        name: 'BE RELAX',
        addressLine: '250 Al Meena Street, Al Zahiyah',
        city: 'Abu Dhabi',
      })),
    },
  } as unknown as PrismaService;

  const config = {
    get: jest.fn((key: string) =>
      ({
        ATTRIBUTION_RETENTION_DAYS: 90,
        GUEST_RETENTION_YEARS: 3,
        FINANCIAL_RETENTION_YEARS: 5,
      })[key],
    ),
  } as unknown as ConfigService;

  return { service: new ProcessingRegisterService(prisma, config) };
}

describe('ProcessingRegisterService.build', () => {
  it('reports no drift when the register and the schema agree', async () => {
    const { service } = setup();

    const register = await service.build(actorFixture());

    expect(register.drift).toEqual({
      clean: true,
      undeclaredTables: [],
      missingTables: [],
      missingColumns: [],
    });
  });

  it('flags a personal-data column that has left the schema', async () => {
    const schema = { ...SCHEMA, guests: SCHEMA.guests!.filter((c) => c !== 'notes') };
    const { service } = setup({ schema });

    const register = await service.build(actorFixture());

    expect(register.drift.clean).toBe(false);
    expect(register.drift.missingColumns).toEqual([{ table: 'guests', columns: ['notes'] }]);
  });

  it('flags a new table nobody added to the register', async () => {
    // The failure this endpoint exists to catch: somebody ships a table of guest
    // loyalty points and the register still says the business holds six things.
    const { service } = setup({ schema: { ...SCHEMA, loyalty_points: ['id', 'guest_id'] } });

    const register = await service.build(actorFixture());

    expect(register.drift.clean).toBe(false);
    expect(register.drift.undeclaredTables).toEqual(['loyalty_points']);
  });

  it('flags a table the register declares but the database does not have', async () => {
    const schema = { ...SCHEMA };
    delete schema.outbound_clicks;
    const { service } = setup({ schema });

    const register = await service.build(actorFixture());

    expect(register.drift.missingTables).toEqual(['outbound_clicks']);
    const attribution = register.activities.find((a) => a.id === 'attribution');
    expect(attribution?.data.find((d) => d.table === 'outbound_clicks')?.exists).toBe(false);
  });

  it('derives the columns and marks which of them are personal data', async () => {
    const { service } = setup();

    const guests = (await service.build(actorFixture())).activities
      .find((a) => a.id === 'bookings')
      ?.data.find((d) => d.table === 'guests');

    // Straight out of information_schema, not out of this file.
    expect(guests?.columns.map((c) => c.name)).toEqual(SCHEMA.guests);
    expect(guests?.columns.filter((c) => c.personalData).map((c) => c.name)).toEqual([
      'full_name',
      'phone',
      'email',
      'notes',
    ]);
    expect(guests?.approximateRows).toBe(125);
  });

  it('states the lawful basis per activity, with money on legal obligation', async () => {
    const { service } = setup();

    const register = await service.build(actorFixture());
    const basis = Object.fromEntries(register.activities.map((a) => [a.id, a.lawfulBasis]));

    expect(basis.bookings).toBe(LawfulBasis.CONTRACT);
    expect(basis.payments).toBe(LawfulBasis.LEGAL_OBLIGATION);
    expect(basis['marketing-consent']).toBe(LawfulBasis.CONSENT);
    expect(basis.attribution).toBe(LawfulBasis.CONSENT);
    expect(basis.staff).toBe(LawfulBasis.EMPLOYMENT);
  });

  it('quotes the retention periods this deployment is actually configured with', async () => {
    const { service } = setup();

    const register = await service.build(actorFixture());

    expect(register.retentionJob.configured).toEqual({
      attributionRetentionDays: 90,
      guestRetentionYears: 3,
      financialRetentionYears: 5,
    });
    expect(register.activities.find((a) => a.id === 'bookings')?.retention).toContain('3 years');
    expect(register.activities.find((a) => a.id === 'payments')?.retention).toContain('5 years');
  });

  it('reports the retention job honestly where pg_cron is absent', async () => {
    const { service } = setup({ cron: false });

    const { retentionJob } = await service.build(actorFixture());

    expect(retentionJob).toMatchObject({
      functionInstalled: true,
      pgCronAvailable: false,
      scheduled: false,
      schedule: null,
    });
  });

  it('reads the live schedule where pg_cron is present', async () => {
    const { service } = setup({ cron: true });

    const { retentionJob } = await service.build(actorFixture());

    // The claim is checked rather than repeated: a register asserting a 90-day
    // window while nothing prunes anything is the failure this prevents.
    expect(retentionJob).toMatchObject({
      pgCronAvailable: true,
      scheduled: true,
      schedule: '30 3 * * *',
    });
  });

  it('names the controller, the processors and the transfer, and denies holding health data', async () => {
    const { service } = setup();

    const register = await service.build(actorFixture());

    expect(register.controller.name).toBe('BE RELAX');
    expect(register.controller.role).toMatch(/Decree-Law No\. 45 of 2021/);
    expect(register.processors.map((p) => p.name)).toContain('Supabase');
    expect(register.crossBorderTransfer.dataLeavesTheUae).toBe(true);
    expect(register.healthData.stored).toBe(false);
    expect(register.dataSubjectRights.map((r) => r.endpoint)).toContain(
      'POST /v1/guests/:id/erase',
    );
  });
});
