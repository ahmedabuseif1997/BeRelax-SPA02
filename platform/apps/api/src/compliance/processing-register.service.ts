import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/request-context';

/* ───────────────────────── the declaration ───────────────────────── */

/**
 * The lawful bases of §11.2, in the words the specification uses. Deliberately
 * not dressed up with article sub-paragraph numbers: the PDPL's Executive
 * Regulations set the procedural detail and counsel will want to put the precise
 * citations in the privacy notice themselves. What this register has to be is
 * TRUE, and these four sentences are true.
 */
export const LawfulBasis = {
  CONTRACT: 'Necessary for the performance of a contract with the data subject',
  LEGAL_OBLIGATION: 'Compliance with a legal obligation (UAE tax and accounting law)',
  CONSENT: 'Consent — separate, opt-in and withdrawable',
  EMPLOYMENT: 'Employment contract and legal obligation',
  LEGITIMATE_INTEREST: 'Legitimate interest in operating and securing the service',
} as const;
export type LawfulBasis = (typeof LawfulBasis)[keyof typeof LawfulBasis];

interface ActivityDeclaration {
  id: string;
  activity: string;
  purpose: string;
  lawfulBasis: LawfulBasis;
  dataSubjects: readonly string[];
  /** Table -> the columns this register calls personal data. */
  tables: Readonly<Record<string, readonly string[]>>;
  /** A retention rule keyed to §11.6, resolved against live configuration. */
  retention: (c: RetentionConfig) => string;
  specialCategory: boolean;
  notes?: string;
}

interface RetentionConfig {
  attributionRetentionDays: number;
  guestRetentionYears: number;
  financialRetentionYears: number;
}

/**
 * The record of processing activities PDPL Article 7 requires, and §11.7 item 4
 * commits this repository to maintaining.
 *
 * Everything that CAN be derived from the database is derived from it: the
 * tables, their real columns and types, roughly how many rows each holds, and
 * whether the retention job is actually installed. What is declared here is only
 * what no schema can know — why the data is held, on what basis, and who it goes
 * to. A register that is typed out by hand drifts from the code within two
 * sprints and is then worse than useless, because it is confidently wrong.
 */
const ACTIVITIES: readonly ActivityDeclaration[] = [
  {
    id: 'bookings',
    activity: 'Taking and delivering a treatment booking',
    purpose:
      'Identifying the guest at the desk, holding a therapist and a room for a time, and reaching them if the appointment has to change.',
    lawfulBasis: LawfulBasis.CONTRACT,
    dataSubjects: ['Spa guests'],
    tables: {
      guests: ['full_name', 'phone', 'email', 'notes'],
      reservations: ['notes', 'cancellation_reason'],
    },
    retention: (c) =>
      `Guest identity anonymised ${c.guestRetentionYears} years after the last visit; the booking row itself survives with the person severed from it.`,
    specialCategory: false,
    notes:
      'No consent is taken for this and none is asked for: the service cannot be delivered without a name and a number. §11.2.',
  },
  {
    id: 'enquiries',
    activity: 'Answering an enquiry from the website or WhatsApp',
    purpose:
      'Calling back a prospective guest who asked for an appointment, and keeping the enquiry inbox reception works from.',
    lawfulBasis: LawfulBasis.CONTRACT,
    dataSubjects: ['Prospective guests'],
    tables: {
      booking_requests: ['guest_name', 'guest_phone', 'guest_email', 'message'],
    },
    retention: (c) =>
      `Anonymised with the guest record on erasure; otherwise with the guest identity window of ${c.guestRetentionYears} years.`,
    specialCategory: false,
    notes: 'Pre-contractual steps taken at the data subject’s own request.',
  },
  {
    id: 'payments',
    activity: 'Taking payment and recording tips',
    purpose:
      'Settling the bill, paying therapists what they are owed, and producing the accounting records the business is required to keep.',
    lawfulBasis: LawfulBasis.LEGAL_OBLIGATION,
    dataSubjects: ['Spa guests', 'Therapists'],
    tables: {
      payments: [],
      tips: [],
      therapist_payout_ledger: [],
      payout_batches: [],
    },
    retention: (c) =>
      `${c.financialRetentionYears} years minimum, and NOT deleted on an erasure request: the right to erasure yields to another legal obligation. §11.4.`,
    specialCategory: false,
    notes:
      'These tables carry no name — a payment points at a reservation, which points at a guest row that an erasure empties. They are append-only and database-enforced (§5.4).',
  },
  {
    id: 'marketing-consent',
    activity: 'Recording and proving consent',
    purpose:
      'Holding the evidence that a guest agreed to marketing, photography or non-contractual processing — which notice they saw, when, and from where.',
    lawfulBasis: LawfulBasis.CONSENT,
    dataSubjects: ['Spa guests'],
    tables: { guest_consents: ['ip_address'] },
    retention: () =>
      'Until withdrawal plus 3 years — proof that consent existed is itself a legal necessity. Deleted outright on an erasure request. §11.6.',
    specialCategory: false,
    notes:
      'Withdrawal is one call to POST /guests/:id/consents/:type/withdraw and must stay as easy as granting. PDPL Art. 6.',
  },
  {
    id: 'attribution',
    activity: 'Measuring which channel brought a guest in',
    purpose:
      'Attributing a booking to the search, advertisement or referral that produced it, so the marketing spend can be judged.',
    lawfulBasis: LawfulBasis.CONSENT,
    dataSubjects: ['Website visitors'],
    tables: {
      attribution_snapshots: ['visitor_id', 'touches', 'first_touch', 'last_touch', 'landing_path'],
      outbound_clicks: ['visitor_id', 'landing_path', 'referrer', 'user_agent'],
    },
    retention: (c) =>
      `${c.attributionRetentionDays} days, then identifiers stripped and channel aggregates kept (prune_attribution). Severed immediately on an erasure request, inside the window. §5.6, §11.4.`,
    specialCategory: false,
    notes:
      'A visitorId is a unique identifier tied to behaviour and is personal data even with no name attached, which is why attribution.js does not run before consent. §11.3.',
  },
  {
    id: 'staff',
    activity: 'Employing and paying staff',
    purpose:
      'Rostering, clocking, commission and payout records, and the login accounts that operate the system.',
    lawfulBasis: LawfulBasis.EMPLOYMENT,
    dataSubjects: ['Employees'],
    tables: {
      employees: ['display_name', 'legal_name', 'phone', 'photo_url'],
      users: ['email', 'full_name'],
      shifts: ['note'],
      refresh_tokens: ['ip_address', 'user_agent'],
    },
    retention: () =>
      'For the duration of employment and the statutory period after it. Revoked or expired refresh tokens are deleted after 30 days. §11.6.',
    specialCategory: false,
    notes: 'legalName is restricted to OWNER, MANAGER and the therapist themselves. §6.4.',
  },
  {
    id: 'accountability',
    activity: 'Keeping an audit trail of money and access',
    purpose:
      'Answering a therapist’s dispute, a tax question or a breach investigation — during a breach this is the only record that can still be trusted.',
    lawfulBasis: LawfulBasis.LEGAL_OBLIGATION,
    dataSubjects: ['Employees', 'Spa guests'],
    tables: {
      financial_audit_log: ['ip_address', 'user_agent'],
      idempotency_records: [],
      nightly_reconciliations: [],
    },
    retention: () => '7 years, then cold storage. Append-only and never edited. §5.4, §11.6.',
    specialCategory: false,
    notes:
      'pickAuditFields strips guest identity before anything is written: the log records what changed about the money, not a second copy of the guest database. §9.6. ' +
      'nightly_reconciliations belongs here for the same reason: it names STAFF — who signed a trading night off and who was taking cash at the desk when a variance appeared (§15.4) — and no guest. It is append-only and database-enforced.',
  },
  {
    id: 'abuse-prevention',
    activity: 'Rate limiting and brute-force protection',
    purpose:
      'Refusing a caller who is working through passwords, or flooding the public enquiry form, before they get anywhere.',
    lawfulBasis: LawfulBasis.LEGITIMATE_INTEREST,
    dataSubjects: ['Website visitors', 'Prospective guests', 'Employees'],
    tables: { rate_limit_counters: ['key'] },
    retention: () =>
      'The length of the rate-limit window — a minute, an hour, fifteen minutes — plus up to an hour of grace before the sweep removes the row. Nothing here survives the night. §12.4.',
    specialCategory: false,
    notes:
      '`key` is a SHA-256 of the route and the caller: `user:<uuid>` for a signed-in user, `ip:<address>` for everyone else. It is declared as personal data rather than waved through as "just a hash" — an unsalted SHA-256 of an IPv4 address is reversed by enumerating four billion inputs, which is minutes of work. Pseudonymised, not anonymous. ' +
      'The table holds a count and two timestamps and nothing else: no name, no phone number, no request body, no route in the clear. ' +
      'It exists because the counter has to be SHARED. Counting in the API process was adequate on one long-lived container and is not on a platform that runs several instances — the login limit would be multiplied by a number nobody controls. See src/common/pg-throttler.storage.ts.',
  },
] as const;

/**
 * Tables that hold no personal data and belong to no processing activity. Listed
 * so the drift check can tell "deliberately not in the register" apart from
 * "somebody added a table and nobody updated the register".
 */
const NON_PERSONAL_TABLES: readonly string[] = [
  'branches',
  'services',
  'service_categories',
  'rooms',
  '_prisma_migrations',
];

/* ───────────────────────── presentation ───────────────────────── */

export interface RegisterColumn {
  name: string;
  type: string;
  nullable: boolean;
  /** True when this register names the column as personal data. */
  personalData: boolean;
}

export interface RegisterTable {
  table: string;
  exists: boolean;
  approximateRows: number;
  columns: RegisterColumn[];
  /** Declared personal-data columns the table no longer has. Drift. */
  missingDeclaredColumns: string[];
}

export interface RegisterActivity {
  id: string;
  activity: string;
  purpose: string;
  lawfulBasis: LawfulBasis;
  specialCategory: boolean;
  dataSubjects: readonly string[];
  /** Derived from information_schema, not from this file's imagination. */
  data: RegisterTable[];
  retention: string;
  recipients: readonly string[];
  notes?: string;
}

export interface ProcessingRegister {
  generatedAt: string;
  /** The sections of the specification this register is the implementation of. */
  specSections: readonly string[];
  controller: {
    name: string;
    addressLine: string;
    city: string;
    country: string;
    role: string;
    branchId: string;
  };
  processors: ReadonlyArray<{ name: string; role: string; location: string }>;
  crossBorderTransfer: {
    dataLeavesTheUae: boolean;
    basis: readonly string[];
    obligations: readonly string[];
  };
  dataSubjectRights: ReadonlyArray<{ right: string; endpoint: string; role: string }>;
  activities: RegisterActivity[];
  retentionJob: {
    functionInstalled: boolean;
    pgCronAvailable: boolean;
    scheduled: boolean;
    schedule: string | null;
    /** The periods this deployment is actually configured with. */
    configured: RetentionConfig;
  };
  /**
   * The point of deriving the register. If this is not clean, the register and
   * the schema disagree and one of them is wrong.
   */
  drift: {
    clean: boolean;
    undeclaredTables: string[];
    missingTables: string[];
    missingColumns: Array<{ table: string; columns: string[] }>;
  };
  healthData: {
    stored: boolean;
    statement: string;
  };
}

/* ───────────────────────── the service ───────────────────────── */

@Injectable()
export class ProcessingRegisterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async build(actor: AuthUser): Promise<ProcessingRegister> {
    const [columns, rowCounts, branch, job] = await Promise.all([
      this.liveColumns(),
      this.approximateRowCounts(),
      this.prisma.branch.findUnique({ where: { id: actor.branchId } }),
      this.retentionJobStatus(),
    ]);

    const retentionConfig: RetentionConfig = {
      attributionRetentionDays: Number(this.config.get('ATTRIBUTION_RETENTION_DAYS') ?? 90),
      guestRetentionYears: Number(this.config.get('GUEST_RETENTION_YEARS') ?? 3),
      financialRetentionYears: Number(this.config.get('FINANCIAL_RETENTION_YEARS') ?? 5),
    };

    const declaredTables = new Set<string>();
    const missingTables: string[] = [];
    const missingColumns: Array<{ table: string; columns: string[] }> = [];

    const activities = ACTIVITIES.map<RegisterActivity>((declaration) => ({
      id: declaration.id,
      activity: declaration.activity,
      purpose: declaration.purpose,
      lawfulBasis: declaration.lawfulBasis,
      specialCategory: declaration.specialCategory,
      dataSubjects: declaration.dataSubjects,
      retention: declaration.retention(retentionConfig),
      recipients: PROCESSOR_NAMES,
      ...(declaration.notes ? { notes: declaration.notes } : {}),
      data: Object.entries(declaration.tables).map(([table, personal]) => {
        declaredTables.add(table);
        const live = columns.get(table);
        if (!live) {
          missingTables.push(table);
          return {
            table,
            exists: false,
            approximateRows: 0,
            columns: [],
            missingDeclaredColumns: [...personal],
          };
        }

        const names = new Set(live.map((c) => c.name));
        const absent = personal.filter((c) => !names.has(c));
        if (absent.length) missingColumns.push({ table, columns: absent });

        return {
          table,
          exists: true,
          approximateRows: rowCounts.get(table) ?? 0,
          columns: live.map((c) => ({ ...c, personalData: personal.includes(c.name) })),
          missingDeclaredColumns: absent,
        };
      }),
    }));

    const undeclaredTables = [...columns.keys()]
      .filter((t) => !declaredTables.has(t) && !NON_PERSONAL_TABLES.includes(t))
      .sort();

    return {
      generatedAt: new Date().toISOString(),
      specSections: ['§11.2', '§11.4', '§11.6', '§11.7'],
      controller: {
        name: branch?.name ?? 'BE RELAX',
        addressLine: branch?.addressLine ?? '',
        city: branch?.city ?? 'Abu Dhabi',
        country: 'United Arab Emirates',
        // Onshore Abu Dhabi, so Federal Decree-Law No. 45 of 2021 governs; the
        // DIFC and ADGM regimes do not reach an onshore establishment. §11.1.
        role: 'Controller under UAE Federal Decree-Law No. 45 of 2021 (PDPL)',
        branchId: actor.branchId,
      },
      processors: PROCESSORS,
      crossBorderTransfer: {
        dataLeavesTheUae: true,
        basis: [
          'PDPL Arts. 22-23 — transfer to a destination offering adequate protection, or under an appropriate contractual undertaking.',
          'A signed Data Processing Addendum with every processor, countersigned copies kept in the business records.',
        ],
        obligations: [
          'The hosting region is chosen deliberately and its reasoning recorded in the repository. §11.7.',
          'The privacy notice names the transfer, the country and the safeguard relied upon.',
          'The schema is stock PostgreSQL 15 plus btree_gist and pgcrypto, so localisation is a pg_dump and a connection string away.',
        ],
      },
      dataSubjectRights: [
        { right: 'Access and portability (Arts. 13-15)', endpoint: 'GET /v1/guests/:id/export', role: 'MANAGER+' },
        { right: 'Erasure (Art. 15)', endpoint: 'POST /v1/guests/:id/erase', role: 'MANAGER+' },
        { right: 'Correction (Art. 14)', endpoint: 'PATCH /v1/guests/:id', role: 'RECEPTIONIST+' },
        { right: 'Consent and its withdrawal (Art. 6)', endpoint: 'GET /v1/guests/:id/consents, POST /v1/guests/:id/consents/:type/withdraw', role: 'RECEPTIONIST+' },
        { right: 'Objection and restriction (Arts. 16-17)', endpoint: 'Withdraw the consent the processing relies on, or block the guest record', role: 'RECEPTIONIST+' },
      ],
      activities,
      retentionJob: { ...job, configured: retentionConfig },
      drift: {
        clean: undeclaredTables.length === 0 && missingTables.length === 0 && missingColumns.length === 0,
        undeclaredTables,
        missingTables,
        missingColumns,
      },
      healthData: {
        stored: false,
        statement:
          'This system stores no medical or health information. Guest notes are preferences only, validated against a medical-term screen, and a health questionnaire — if one is operationally required — stays on paper on site. UAE Federal Law No. 2 of 2019 keeps health data generated in the UAE inside the UAE, and this database is not hosted there. §11.5.',
      },
    };
  }

  /** The columns the database actually has. The derivation the register rests on. */
  private async liveColumns(): Promise<Map<string, Array<{ name: string; type: string; nullable: boolean }>>> {
    const rows = await this.prisma.$queryRaw<
      Array<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>
    >`
      SELECT table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`;

    const byTable = new Map<string, Array<{ name: string; type: string; nullable: boolean }>>();
    for (const row of rows) {
      const list = byTable.get(row.table_name) ?? [];
      list.push({ name: row.column_name, type: row.data_type, nullable: row.is_nullable === 'YES' });
      byTable.set(row.table_name, list);
    }
    return byTable;
  }

  /**
   * `reltuples` from the planner statistics — approximate on purpose. An exact
   * count would mean a sequential scan of every table in the register on every
   * call, and "roughly how much do we hold" is the question this answers.
   * A table never analysed reports -1, which is reported as 0 rather than as a
   * negative number of people.
   */
  private async approximateRowCounts(): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<Array<{ relname: string; rows: number }>>`
      SELECT c.relname, GREATEST(c.reltuples, 0)::int AS rows
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`;
    return new Map(rows.map((r) => [r.relname, Number(r.rows)]));
  }

  /**
   * Whether the retention job is genuinely installed and genuinely scheduled.
   *
   * A register that asserts a 90-day window while nothing prunes anything is the
   * exact failure this endpoint exists to prevent, so the claim is checked rather
   * than repeated. `pg_cron` is absent on a local Postgres and present on
   * Supabase; either answer is reported plainly, and a missing schedule on a
   * database that could carry one is the finding.
   */
  private async retentionJobStatus(): Promise<{
    functionInstalled: boolean;
    pgCronAvailable: boolean;
    scheduled: boolean;
    schedule: string | null;
  }> {
    const [row] = await this.prisma.$queryRaw<Array<{ installed: boolean; cron: boolean }>>`
      SELECT to_regprocedure('prune_attribution(int)') IS NOT NULL                     AS installed,
             EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')             AS cron`;

    const status = {
      functionInstalled: Boolean(row?.installed),
      pgCronAvailable: Boolean(row?.cron),
      scheduled: false,
      schedule: null as string | null,
    };
    if (!status.pgCronAvailable) return status;

    try {
      const jobs = await this.prisma.$queryRaw<Array<{ schedule: string; active: boolean }>>`
        SELECT schedule, active FROM cron.job WHERE jobname = 'prune-attribution'`;
      const job = jobs[0];
      if (job) {
        status.scheduled = job.active;
        status.schedule = job.schedule;
      }
    } catch {
      // cron.job is readable only by its owner on some managed platforms. Not
      // being allowed to look is not evidence that nothing is scheduled, and it
      // is certainly not a reason to fail the whole register.
    }
    return status;
  }
}

const PROCESSORS = [
  { name: 'Supabase', role: 'Managed PostgreSQL, backups and storage', location: 'Outside the UAE — region recorded in the repository. §11.7' },
  // One entry, not two: the API and the dashboard are separate Vercel projects
  // but one processor under one contract. This list is what
  // GET /v1/compliance/processing-register returns, so it states who actually
  // holds the data today — not who held it when the spec was written.
  { name: 'Vercel', role: 'API and dashboard hosting', location: 'Outside the UAE' },
  { name: 'Netlify', role: 'Public site hosting', location: 'Outside the UAE' },
  { name: 'Cloudflare', role: 'DNS, CDN and bot protection', location: 'Global edge' },
] as const;

const PROCESSOR_NAMES = PROCESSORS.map((p) => p.name);
