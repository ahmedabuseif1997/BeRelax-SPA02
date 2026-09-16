/**
 * BE RELAX — development seed. Spec §13.4.
 *
 * "Reports built against an empty database look correct and are not." This
 * builds one realistic branch: the live service menu scraped from index.html,
 * eight therapists, five rooms, one user per role, and roughly two hundred
 * reservations spread over the previous sixty *business* days — with the money
 * that goes with them, in the shape §8 and §9 demand.
 *
 * Three properties this file is responsible for:
 *
 *  1. IDEMPOTENT. The catalogue is written with deterministic UUIDs and
 *     `upsert`, so a second run rewrites the same rows. The transactional
 *     history is guarded on `reservation.count()` — the money tables are
 *     append-only (§5.4) and cannot be upserted at all.
 *
 *  2. CONSTRAINT-CLEAN. Reservations are laid out in per-room "lanes", one
 *     therapist per lane per day, each session advanced past the previous
 *     one's `blocked_until` (duration + the branch's 15-minute turnaround).
 *     Nothing here leans on the exclusion constraints to sort it out; the
 *     data genuinely does not overlap. See §5.2.
 *
 *  3. FINANCIALLY COHERENT. Every COMPLETED reservation carries BASE payments
 *     summing exactly to `base_cost_fils`, a tip mix of ~40 % none /
 *     ~35 % DIRECT_CASH / ~25 % COLLECTED_BY_BUSINESS, and — only for the
 *     collected mode — a TIP payment plus a TIP_ACCRUAL ledger entry. Every
 *     money row gets a `financial_audit_log` entry at the same instant, so
 *     the seven invariants in §13.3 pass on this data.
 *
 * Money is integer fils throughout. 1 AED = 100 fils (§3.1).
 */

/* eslint-disable no-console */
import * as bcrypt from 'bcrypt';
import {
  ConsentType,
  EmployeeStatus,
  LedgerEntryType,
  PaymentKind,
  PaymentMethod,
  Prisma,
  PrismaClient,
  ReservationStatus,
  ShiftStatus,
  SourceChannel,
  TipType,
  UserRole,
} from '@prisma/client';
import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';
import { businessDay, toFils } from '@berelax/contracts';

// ─────────────────────────────────────────────────────────────
// TUNING
// ─────────────────────────────────────────────────────────────

const HISTORY_DAYS = 60;
/** ~200 all told: the history plus the handful of near-future bookings. */
const HISTORY_TARGET = 189;
const FUTURE_DAY_COUNTS = [4, 4, 3];
const GUEST_POOL = 120;

/** Spec §13.4. These three must sum to 100. */
const TIP_MIX = { none: 40, directCash: 35, collectedByBusiness: 25 } as const;

/** Rota size per trading day — one lane per room, five rooms. */
const LANES_PER_DAY = 5;

/** Bookings per trading day, indexed by JS day-of-week (0 = Sunday). */
const DAY_WEIGHTS = [2, 3, 3, 3, 3, 4, 4];

const BCRYPT_COST = 12;
const PRIVACY_POLICY_VERSION = '2026-01-15';

// ─────────────────────────────────────────────────────────────
// THE LIVE MENU
//
// Lifted verbatim from index.html: every `.book-row` carries
// data-menu / data-treat / data-dur / data-price. Prices are AED and are
// converted to fils here, once, by `toFils`.
// ─────────────────────────────────────────────────────────────

interface MenuRow {
  menu: 'Asian' | 'Arabic';
  treatment: string;
  minutes: number;
  aed: number;
}

const MENU: readonly MenuRow[] = [
  { menu: 'Asian', treatment: 'Normal Massage', minutes: 45, aed: 170 },
  { menu: 'Asian', treatment: 'Normal Massage', minutes: 60, aed: 200 },
  { menu: 'Asian', treatment: 'Normal Massage', minutes: 90, aed: 300 },
  { menu: 'Asian', treatment: 'Normal Massage', minutes: 120, aed: 400 },
  { menu: 'Asian', treatment: 'Hot Oil / Balm Massage', minutes: 45, aed: 200 },
  { menu: 'Asian', treatment: 'Hot Oil / Balm Massage', minutes: 60, aed: 250 },
  { menu: 'Asian', treatment: 'Hot Oil / Balm Massage', minutes: 90, aed: 350 },
  { menu: 'Asian', treatment: 'Hot Oil / Balm Massage', minutes: 120, aed: 450 },
  { menu: 'Asian', treatment: 'Morocco Bath or Jacuzzi', minutes: 45, aed: 250 },
  { menu: 'Asian', treatment: 'Morocco Bath or Jacuzzi', minutes: 60, aed: 300 },
  { menu: 'Asian', treatment: 'Morocco Bath or Jacuzzi', minutes: 90, aed: 440 },
  { menu: 'Asian', treatment: 'Morocco Bath or Jacuzzi', minutes: 120, aed: 550 },
  { menu: 'Asian', treatment: 'Massage with Shaving', minutes: 45, aed: 200 },
  { menu: 'Asian', treatment: 'Massage with Shaving', minutes: 60, aed: 250 },
  { menu: 'Asian', treatment: 'Massage with Shaving', minutes: 90, aed: 350 },
  { menu: 'Asian', treatment: 'Massage with Shaving', minutes: 120, aed: 450 },
  { menu: 'Arabic', treatment: 'Normal Massage', minutes: 45, aed: 200 },
  { menu: 'Arabic', treatment: 'Normal Massage', minutes: 60, aed: 250 },
  { menu: 'Arabic', treatment: 'Normal Massage', minutes: 90, aed: 350 },
  { menu: 'Arabic', treatment: 'Normal Massage', minutes: 120, aed: 450 },
  { menu: 'Arabic', treatment: 'Hot Oil / Balm Massage', minutes: 45, aed: 250 },
  { menu: 'Arabic', treatment: 'Hot Oil / Balm Massage', minutes: 60, aed: 300 },
  { menu: 'Arabic', treatment: 'Hot Oil / Balm Massage', minutes: 90, aed: 400 },
  { menu: 'Arabic', treatment: 'Hot Oil / Balm Massage', minutes: 120, aed: 500 },
  { menu: 'Arabic', treatment: 'Morocco Bath or Jacuzzi', minutes: 45, aed: 330 },
  { menu: 'Arabic', treatment: 'Morocco Bath or Jacuzzi', minutes: 60, aed: 380 },
  { menu: 'Arabic', treatment: 'Morocco Bath or Jacuzzi', minutes: 90, aed: 520 },
  { menu: 'Arabic', treatment: 'Morocco Bath or Jacuzzi', minutes: 120, aed: 620 },
  { menu: 'Arabic', treatment: 'Massage with Shaving', minutes: 45, aed: 300 },
  { menu: 'Arabic', treatment: 'Massage with Shaving', minutes: 60, aed: 350 },
  { menu: 'Arabic', treatment: 'Massage with Shaving', minutes: 90, aed: 450 },
  { menu: 'Arabic', treatment: 'Massage with Shaving', minutes: 120, aed: 550 },
];

/** Card copy from index.html, kept so /public/services can render the site from the database. */
const TREATMENT_BLURB: Record<string, string> = {
  'Normal Massage': 'A full-body massage with steady, even pressure — the house classic.',
  'Hot Oil / Balm Massage': 'Warm oil or herbal balm worked into the muscles to loosen deep tension.',
  'Morocco Bath or Jacuzzi': 'Traditional hammam scrub and steam, or warm hydro-jets in the jacuzzi.',
  'Massage with Shaving': 'A full massage together with bikini and underarm shaving.',
};

/** Water treatments only run in the two wet rooms. */
const WET_TREATMENT = 'Morocco Bath or Jacuzzi';

// ─────────────────────────────────────────────────────────────
// STAFF AND ROOMS
// ─────────────────────────────────────────────────────────────

/**
 * The live site lists nineteen "Certified Therapist" cards and no names, so the
 * seed keeps them general too. `legalName` stays null on purpose: it is a
 * restricted HR field (§6.4) and inventing personal data for a dev fixture is
 * how fake people end up in a production export.
 */
const EMPLOYEES = [
  { key: 'A', displayName: 'Therapist A', commissionBps: 0, status: EmployeeStatus.ACTIVE, photo: 'assets/team/team-01.jpg' },
  { key: 'B', displayName: 'Therapist B', commissionBps: 1000, status: EmployeeStatus.ACTIVE, photo: 'assets/team/team-02.jpg' },
  { key: 'C', displayName: 'Therapist C', commissionBps: 0, status: EmployeeStatus.ACTIVE, photo: 'assets/team/team-03.jpg' },
  { key: 'D', displayName: 'Therapist D', commissionBps: 1500, status: EmployeeStatus.ACTIVE, photo: 'assets/team/team-04.jpg' },
  { key: 'E', displayName: 'Therapist E', commissionBps: 1000, status: EmployeeStatus.ACTIVE, photo: 'assets/team/team-05.jpg' },
  { key: 'F', displayName: 'Therapist F', commissionBps: 0, status: EmployeeStatus.ACTIVE, photo: 'assets/team/team-06.jpg' },
  { key: 'G', displayName: 'Therapist G', commissionBps: 500, status: EmployeeStatus.ACTIVE, photo: 'assets/team/team-07.jpg' },
  { key: 'H', displayName: 'Therapist H', commissionBps: 0, status: EmployeeStatus.ON_LEAVE, photo: 'assets/team/team-08.jpg' },
] as const;

const ROOMS = [
  { key: 'suite-1', name: 'Suite 1', wet: false },
  { key: 'suite-2', name: 'Suite 2', wet: false },
  { key: 'suite-3', name: 'Suite 3', wet: false },
  { key: 'hammam', name: 'Hammam Room', wet: true },
  { key: 'jacuzzi', name: 'Jacuzzi Suite', wet: true },
] as const;

/**
 * Dev credentials, printed at the end of the run. `mustChangePassword` is false
 * so they are usable straight away — the forced-rotation path has its own test.
 */
const USERS = [
  { key: 'owner', email: 'owner@berelax.ae', fullName: 'Branch Owner', role: UserRole.OWNER, password: 'BeRelaxOwner2026!' },
  { key: 'manager', email: 'manager@berelax.ae', fullName: 'Duty Manager', role: UserRole.MANAGER, password: 'BeRelaxManager2026!' },
  { key: 'reception', email: 'reception@berelax.ae', fullName: 'Front Desk', role: UserRole.RECEPTIONIST, password: 'BeRelaxReception2026!' },
  { key: 'therapist', email: 'therapist@berelax.ae', fullName: 'Therapist A', role: UserRole.THERAPIST, password: 'BeRelaxTherapist2026!', employeeKey: 'A' },
] as const;

// ─────────────────────────────────────────────────────────────
// ATTRIBUTION CHANNELS (§10.1)
// ─────────────────────────────────────────────────────────────

interface ChannelSpec {
  source: string;
  medium: string;
  campaign?: string;
  term?: string;
  gclid?: boolean;
  referrer?: string;
  weight: number;
}

const CHANNELS: readonly ChannelSpec[] = [
  { source: 'google', medium: 'organic', term: 'massage al zahiyah', weight: 30 },
  { source: 'google', medium: 'cpc', campaign: 'brand-abu-dhabi', term: 'be relax spa', gclid: true, weight: 14 },
  { source: 'instagram', medium: 'social', campaign: 'reels-autumn', weight: 20 },
  { source: 'direct', medium: 'none', weight: 22 },
  { source: 'tripadvisor.com', medium: 'referral', referrer: 'https://www.tripadvisor.com/', weight: 14 },
];

const LANDING_PATHS = ['/', '/#services', '/#team', '/#contact', '/#about'];

/** Only these arrive with a browsing session behind them. A phone call has no UTM. */
const ATTRIBUTABLE_CHANNELS: readonly SourceChannel[] = [
  SourceChannel.WEBSITE_FORM,
  SourceChannel.WHATSAPP,
  SourceChannel.INSTAGRAM,
];

const SOURCE_CHANNEL_MIX: readonly [SourceChannel, number][] = [
  [SourceChannel.WHATSAPP, 34],
  [SourceChannel.WALK_IN, 22],
  [SourceChannel.PHONE, 16],
  [SourceChannel.WEBSITE_FORM, 12],
  [SourceChannel.INSTAGRAM, 8],
  [SourceChannel.GOOGLE_MAPS, 5],
  [SourceChannel.REFERRAL, 3],
];

const CANCELLATION_REASONS = [
  'Guest called to cancel',
  'Guest rescheduled to another evening',
  'Therapist called in sick, guest declined a swap',
  'Flight delayed, guest could not make it',
  'Double entry at the desk',
];

const FIRST_NAMES = [
  'Aisha', 'Omar', 'Layla', 'Yusuf', 'Fatima', 'Khalid', 'Mariam', 'Rashid', 'Noura', 'Saeed',
  'Hessa', 'Tariq', 'Salma', 'Bilal', 'Dana', 'Faisal', 'Reem', 'Nasser', 'Huda', 'Adel',
  'Anna', 'Viktor', 'Priya', 'Arjun', 'Chen', 'Mei', 'Daniel', 'Sofia', 'Marcus', 'Elena',
];
const LAST_NAMES = [
  'Al Mansoori', 'Al Hashimi', 'Al Suwaidi', 'Al Zaabi', 'Al Nuaimi', 'Al Ketbi', 'Al Dhaheri',
  'Haddad', 'Nasser', 'Rahman', 'Petrova', 'Kowalski', 'Sharma', 'Nair', 'Wang', 'Lim',
  'Fischer', 'Moreau', 'Silva', 'O’Connor',
];

const GUEST_NOTES = [
  'Prefers firm pressure',
  'No jasmine oil',
  'Requests a quiet room',
  'Always books the 90-minute slot',
  'Prefers a ladies therapist',
  null,
  null,
  null,
];

// ─────────────────────────────────────────────────────────────
// SMALL UTILITIES
// ─────────────────────────────────────────────────────────────

/** Deterministic PRNG. The seed must produce the same branch on every machine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

const intBetween = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;

function weighted<T>(rng: Rng, entries: readonly (readonly [T, number])[]): T {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [value, w] of entries) {
    roll -= w;
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1]![0];
}

/** Dubai is UTC+4 year round, so a literal offset is exact — no tz database needed. */
const DUBAI_OFFSET = '+04:00';
const dubaiAt = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00.000${DUBAI_OFFSET}`);
const addMinutes = (at: Date, minutes: number): Date => new Date(at.getTime() + minutes * 60_000);

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Prisma `@db.Date` reads the UTC date part, so a date-only column must be built at UTC midnight. */
const dateOnly = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const dayOfWeek = (day: string): number => new Date(`${day}T00:00:00.000Z`).getUTCDay();

/** Stable UUIDs for the catalogue, so `upsert` makes a second run a no-op. */
const SEED_NAMESPACE = uuidv5('berelax.ae/seed/v1', uuidv5.DNS);
const stableId = (kind: string, key: string): string => uuidv5(`${kind}:${key}`, SEED_NAMESPACE);

/** Round to the nearest note people actually hand over. `step` is in fils. */
const roundToStep = (fils: number, step: number): number => Math.max(step, Math.round(fils / step) * step);

// ─────────────────────────────────────────────────────────────
// PUBLIC SHAPE
// ─────────────────────────────────────────────────────────────

export interface SeedOptions {
  /** Trading day the history hangs off. Defaults to today in Dubai; pin it in CI. */
  anchorDay?: string;
  /** Silence stdout. The e2e suites seed quietly. */
  quiet?: boolean;
  /** PRNG seed — same number, same branch. */
  randomSeed?: number;
}

export interface SeedSummary {
  branchId: string;
  anchorDay: string;
  services: number;
  rooms: number;
  employees: number;
  users: number;
  guests: number;
  reservations: number;
  payments: number;
  tips: number;
  ledgerEntries: number;
  auditEntries: number;
  attributionSnapshots: number;
  shifts: number;
  payoutBatches: number;
  /** True when the transactional history was already present and was left alone. */
  historySkipped: boolean;
}

interface Catalogue {
  branchId: string;
  turnaroundMins: number;
  services: { id: string; minutes: number; priceFils: number; treatment: string; menu: string }[];
  rooms: { id: string; name: string; wet: boolean }[];
  employees: { id: string; key: string; commissionBps: number; status: EmployeeStatus }[];
  userIds: Record<string, string>;
  guestIds: string[];
}

// ─────────────────────────────────────────────────────────────
// CATALOGUE — idempotent, deterministic ids
// ─────────────────────────────────────────────────────────────

const BRANCH_ID = stableId('branch', 'be-relax-al-zahiyah');

async function seedCatalogue(prisma: PrismaClient, rng: Rng): Promise<Catalogue> {
  const branchData = {
    name: 'BE RELAX',
    addressLine: '250 Al Meena Street, Tower Block A/B, M-Floor, Al Zahiyah (Al Mina), E14',
    city: 'Abu Dhabi',
    phonePrimary: '+971525108633',
    phoneSecondary: '+971563429399',
    phoneLandline: '+97125576533',
    whatsappNumber: '+971525108633',
    googleMapsUrl: 'https://maps.app.goo.gl/uuZxw2Q4snj2SEH47',
    timezone: 'Asia/Dubai',
    opensAt: '11:00',
    closesAt: '02:00',
    turnaroundMins: 15,
  };

  const branch = await prisma.branch.upsert({
    where: { id: BRANCH_ID },
    update: branchData,
    create: { id: BRANCH_ID, ...branchData },
  });

  // ── categories and services, straight off the website menu ──
  // Where the schema carries a natural unique key, upsert on THAT, not on the
  // deterministic id — otherwise a row someone else already created under the
  // same name collides instead of being adopted.
  const categoryIds: Record<string, string> = {};
  for (const [index, name] of ['Asian', 'Arabic'].entries()) {
    const category = await prisma.serviceCategory.upsert({
      where: { name },
      update: { sortOrder: index, isActive: true },
      create: { id: stableId('service-category', name), name, sortOrder: index, isActive: true },
    });
    categoryIds[name] = category.id;
  }

  const services: Catalogue['services'] = [];
  for (const [index, row] of MENU.entries()) {
    const key = `${row.menu}|${row.treatment}|${row.minutes}`;
    const id = stableId('service', key);
    const priceFils = toFils(row.aed);
    const data = {
      branchId: branch.id,
      categoryId: categoryIds[row.menu]!,
      name: `${row.treatment} — ${row.minutes} min`,
      durationMinutes: row.minutes,
      priceFils,
      description: TREATMENT_BLURB[row.treatment] ?? null,
      requiresRoom: true,
      isActive: true,
      sortOrder: index,
    };
    await prisma.service.upsert({ where: { id }, update: data, create: { id, ...data } });
    services.push({ id, minutes: row.minutes, priceFils, treatment: row.treatment, menu: row.menu });
  }

  // ── rooms ──
  const rooms: Catalogue['rooms'] = [];
  for (const room of ROOMS) {
    const created = await prisma.room.upsert({
      where: { branchId_name: { branchId: branch.id, name: room.name } },
      update: { capacity: 1, isActive: true },
      create: { id: stableId('room', room.key), branchId: branch.id, name: room.name, capacity: 1, isActive: true },
    });
    rooms.push({ id: created.id, name: room.name, wet: room.wet });
  }

  // ── employees ──
  const employees: Catalogue['employees'] = [];
  for (const [index, employee] of EMPLOYEES.entries()) {
    const id = stableId('employee', employee.key);
    const data = {
      branchId: branch.id,
      displayName: employee.displayName,
      legalName: null,
      phone: `+9715${5}${String(1000000 + index).padStart(7, '0')}`,
      status: employee.status,
      commissionBps: employee.commissionBps,
      hiredOn: dateOnly(addDays('2024-01-15', index * 47)),
      photoUrl: employee.photo,
    };
    await prisma.employee.upsert({ where: { id }, update: data, create: { id, ...data } });
    employees.push({ id, key: employee.key, commissionBps: employee.commissionBps, status: employee.status });
  }

  // ── users, one per role ──
  const userIds: Record<string, string> = {};
  for (const user of USERS) {
    const id = stableId('user', user.key);
    const employeeKey = 'employeeKey' in user ? user.employeeKey : undefined;
    const employeeId = employeeKey ? stableId('employee', employeeKey) : null;
    const passwordHash = await bcrypt.hash(user.password, BCRYPT_COST);
    const data = {
      branchId: branch.id,
      email: user.email,
      passwordHash,
      fullName: user.fullName,
      role: user.role,
      isActive: true,
      // Seed accounts are meant to be logged into immediately; the forced-rotation
      // path is exercised by its own test, not by every developer every morning.
      mustChangePassword: false,
      employeeId,
    };
    // Email uniqueness is a PARTIAL index on lower(email) (§5.1), which Prisma
    // cannot treat as a unique input — so the lookup is explicit.
    const live = await prisma.user.findFirst({ where: { email: user.email, deletedAt: null } });
    const saved = live
      ? await prisma.user.update({ where: { id: live.id }, data })
      : await prisma.user.upsert({ where: { id }, update: data, create: { id, ...data } });
    userIds[user.key] = saved.id;
  }

  // ── guests ──
  const guestRows: Prisma.GuestCreateManyInput[] = [];
  const consentRows: Prisma.GuestConsentCreateManyInput[] = [];
  const carriers = ['0', '2', '5', '6'];
  for (let i = 0; i < GUEST_POOL; i++) {
    const id = stableId('guest', String(i));
    const fullName = `${FIRST_NAMES[i % FIRST_NAMES.length]} ${LAST_NAMES[(i * 7) % LAST_NAMES.length]}`;
    const phone = `+9715${carriers[i % carriers.length]}${String(1200000 + i * 137).padStart(7, '0')}`;
    guestRows.push({
      id,
      branchId: branch.id,
      fullName,
      phone,
      email: i % 3 === 0 ? `guest${i}@example.ae` : null,
      // Operational preferences only. This system stores NO health data (§11.5).
      notes: GUEST_NOTES[i % GUEST_NOTES.length] ?? null,
      isBlocked: false,
    });
    consentRows.push({
      id: stableId('consent', `${i}:processing`),
      guestId: id,
      type: ConsentType.DATA_PROCESSING,
      granted: true,
      source: i % 2 === 0 ? 'website-form' : 'reception-ipad',
      policyVersion: PRIVACY_POLICY_VERSION,
    });
    if (rng() < 0.55) {
      consentRows.push({
        id: stableId('consent', `${i}:marketing`),
        guestId: id,
        type: ConsentType.MARKETING,
        granted: true,
        source: 'website-form',
        policyVersion: PRIVACY_POLICY_VERSION,
      });
    }
  }
  await prisma.guest.createMany({ data: guestRows, skipDuplicates: true });
  // `skipDuplicates` silently drops a row whose (branch, phone) already exists,
  // so the ids are read back rather than assumed: a reservation pointing at a
  // guest that was never inserted is a foreign-key failure 200 rows later.
  const savedGuests = await prisma.guest.findMany({
    where: { branchId: branch.id, phone: { in: guestRows.map((g) => g.phone) } },
    select: { id: true, phone: true },
  });
  const guestIdByPhone = new Map(savedGuests.map((g) => [g.phone, g.id]));
  const guestIds = guestRows.map((g) => guestIdByPhone.get(g.phone)!).filter(Boolean);
  await prisma.guestConsent.createMany({
    data: consentRows.filter((c) => guestIds.includes(c.guestId)),
    skipDuplicates: true,
  });

  return {
    branchId: branch.id,
    turnaroundMins: branch.turnaroundMins,
    services,
    rooms,
    employees,
    userIds,
    guestIds,
  };
}

// ─────────────────────────────────────────────────────────────
// HISTORY
// ─────────────────────────────────────────────────────────────

interface PlannedReservation {
  id: string;
  ref: string;
  day: string;
  startsAt: Date;
  durationMinutes: number;
  endsAt: Date;
  blockedUntil: Date;
  employeeId: string;
  commissionBps: number;
  roomId: string;
  serviceId: string;
  guestId: string | null;
  baseCostFils: number;
  status: ReservationStatus;
  sourceChannel: SourceChannel;
  attributionId: string | null;
  createdAt: Date;
  actualArrivalAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
}

/**
 * Lay out one trading day. A lane is (room, therapist) and runs sequentially:
 * the next session in a lane cannot start before the previous one's
 * `blocked_until`, which is `ends_at + turnaround`. Because each lane owns a
 * distinct room and a distinct therapist for the whole day, and no guest is
 * used twice in a day, none of the three exclusion constraints in §5.2 can
 * fire — the data is genuinely non-overlapping, not merely accepted.
 */
type PlannedSlot = Pick<
  PlannedReservation,
  | 'id' | 'day' | 'startsAt' | 'durationMinutes' | 'endsAt' | 'blockedUntil'
  | 'employeeId' | 'commissionBps' | 'roomId' | 'serviceId' | 'guestId' | 'baseCostFils'
>;

function planDay(
  day: string,
  target: number,
  catalogue: Catalogue,
  rng: Rng,
  guestCursor: { next: number },
): PlannedSlot[] {
  const opensAt = dubaiAt(day, '11:00');
  const closesAt = dubaiAt(addDays(day, 1), '02:00');

  const roster = catalogue.employees.filter((e) => e.status === EmployeeStatus.ACTIVE);
  // Rotate the rota so the same five therapists are not on every single night.
  const offset = Math.abs(dayOfWeek(day) * 3 + day.charCodeAt(9)) % roster.length;
  const lanes = Array.from({ length: Math.min(LANES_PER_DAY, roster.length) }, (_, i) => ({
    employee: roster[(offset + i) % roster.length]!,
    room: catalogue.rooms[i]!,
    // A spa is quiet at noon and busy at midnight, so skew each lane's first
    // slot toward the evening rather than bunching every booking against
    // opening time. This is also what gives the fixture genuine after-midnight
    // bookings — without them the business-day boundary (§3.3), the single
    // trickiest rule in the system, would have no coverage in seeded data.
    cursor: addMinutes(opensAt, Math.floor(780 * Math.pow(rng(), 0.55)) + i * 9),
  }));

  const out: PlannedSlot[] = [];
  const guestsUsedToday = new Set<string>();

  for (let k = 0; k < target; k++) {
    let placed = false;
    for (let attempt = 0; attempt < lanes.length && !placed; attempt++) {
      const lane = lanes[(k + attempt) % lanes.length]!;
      const minutesLeft = (closesAt.getTime() - lane.cursor.getTime()) / 60_000;
      // Wet treatments only run in the two wet rooms, and only a treatment that
      // still finishes by 02:00 can be offered at all — so a late booking is a
      // short one, exactly as it would be at the desk. Filtering here rather
      // than picking and discarding keeps the evening from thinning out.
      const candidates = catalogue.services.filter(
        (s) => (lane.room.wet || s.treatment !== WET_TREATMENT) && s.minutes <= minutesLeft,
      );
      if (candidates.length === 0) continue;

      const service = pick(rng, candidates);
      const startsAt = lane.cursor;
      const endsAt = addMinutes(startsAt, service.minutes);
      const blockedUntil = addMinutes(endsAt, catalogue.turnaroundMins);

      // ~12 % of the floor is an anonymous walk-in with no guest record at all —
      // a NULL guest_id can never collide, which is worth having in the fixture.
      let guestId: string | null = null;
      if (rng() >= 0.12) {
        for (let tries = 0; tries < catalogue.guestIds.length; tries++) {
          const candidate = catalogue.guestIds[guestCursor.next % catalogue.guestIds.length]!;
          guestCursor.next++;
          if (!guestsUsedToday.has(candidate)) {
            guestId = candidate;
            guestsUsedToday.add(candidate);
            break;
          }
        }
      }

      out.push({
        id: uuidv7(),
        day,
        startsAt,
        durationMinutes: service.minutes,
        endsAt,
        blockedUntil,
        employeeId: lane.employee.id,
        commissionBps: lane.employee.commissionBps,
        roomId: lane.room.id,
        serviceId: service.id,
        guestId,
        baseCostFils: service.priceFils,
      });

      // Next session in this lane starts after the turnaround plus a real-world gap.
      lane.cursor = addMinutes(blockedUntil, intBetween(rng, 5, 55));
      placed = true;
    }
    if (!placed) break; // the floor is full for tonight
  }

  return out;
}

async function seedHistory(
  prisma: PrismaClient,
  catalogue: Catalogue,
  anchorDay: string,
  rng: Rng,
): Promise<Omit<SeedSummary, 'branchId' | 'anchorDay' | 'services' | 'rooms' | 'employees' | 'users' | 'guests' | 'historySkipped'>> {
  const guestCursor = { next: 0 };

  // ── 1. lay out every trading day, oldest first ──
  const historyDays = Array.from({ length: HISTORY_DAYS }, (_, i) => addDays(anchorDay, -(HISTORY_DAYS - i)));
  const futureDays = FUTURE_DAY_COUNTS.map((_, i) => addDays(anchorDay, i + 1));

  let planned: PlannedReservation[] = [];
  const stage = (
    slots: PlannedSlot[],
    status: (rng: Rng) => ReservationStatus,
  ): void => {
    for (const slot of slots) {
      planned.push({
        ...slot,
        ref: '',
        status: status(rng),
        // Channel, attribution and the lifecycle timestamps are filled in by the
        // pass below, once every slot across every day is known.
        sourceChannel: SourceChannel.WALK_IN,
        attributionId: null,
        createdAt: slot.startsAt,
        actualArrivalAt: null,
        completedAt: null,
        cancelledAt: null,
        cancellationReason: null,
      });
    }
  };

  const historicStatus = (r: Rng): ReservationStatus =>
    weighted(r, [
      [ReservationStatus.COMPLETED, 84],
      [ReservationStatus.CANCELLED, 8],
      [ReservationStatus.NO_SHOW, 8],
    ]);

  for (const day of historyDays) {
    stage(planDay(day, DAY_WEIGHTS[dayOfWeek(day)]!, catalogue, rng, guestCursor), historicStatus);
  }
  // Keep the most recent slice: a busy last fortnight matters more to a demo than
  // a complete one sixty days ago.
  planned = planned.slice(-HISTORY_TARGET);

  for (const [i, day] of futureDays.entries()) {
    stage(planDay(day, FUTURE_DAY_COUNTS[i]!, catalogue, rng, guestCursor), () => ReservationStatus.SCHEDULED);
  }

  // ── 2. reference numbers ──
  // Drawn from `reservation_ref_seq`, the same sequence ReservationsService uses.
  // Minting them any other way leaves the sequence at 1 and the first booking a
  // receptionist makes after seeding collides on `reservations.ref`. §3.4.
  planned.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const refSeq = await prisma.$queryRaw<{ seq: bigint }[]>`
    SELECT nextval('reservation_ref_seq') AS seq FROM generate_series(1, ${planned.length})`;
  planned.forEach((r, i) => {
    r.ref = `BR-${r.day.slice(0, 4)}-${String(Number(refSeq[i]!.seq)).padStart(4, '0')}`;
  });

  // ── 3. lifecycle timestamps, channels and attribution ──
  const attributionRows: Prisma.AttributionSnapshotCreateManyInput[] = [];
  for (const r of planned) {
    r.sourceChannel = weighted(rng, SOURCE_CHANNEL_MIX);

    // Walk-ins are entered at the desk minutes before the treatment; everything
    // else is booked days ahead.
    r.createdAt =
      r.sourceChannel === SourceChannel.WALK_IN
        ? addMinutes(r.startsAt, -intBetween(rng, 3, 25))
        : addMinutes(r.startsAt, -intBetween(rng, 45, 60 * 24 * 11));

    if (r.status === ReservationStatus.COMPLETED) {
      r.actualArrivalAt = addMinutes(r.startsAt, intBetween(rng, 0, 7));
      r.completedAt = addMinutes(r.actualArrivalAt, r.durationMinutes + intBetween(rng, 0, 12));
    } else if (r.status === ReservationStatus.CANCELLED) {
      r.cancelledAt = addMinutes(r.startsAt, -intBetween(rng, 30, 60 * 48));
      if (r.cancelledAt.getTime() < r.createdAt.getTime()) r.cancelledAt = addMinutes(r.createdAt, 30);
      r.cancellationReason = pick(rng, CANCELLATION_REASONS);
    }

    if (ATTRIBUTABLE_CHANNELS.includes(r.sourceChannel) && rng() < 0.8) {
      const id = uuidv7();
      const touches = buildTouches(rng, r.createdAt);
      attributionRows.push({
        id,
        visitorId: uuidv7(),
        firstTouch: touches[0]! as unknown as Prisma.InputJsonValue,
        lastTouch: touches[touches.length - 1]! as unknown as Prisma.InputJsonValue,
        touches: touches as unknown as Prisma.InputJsonValue,
        touchCount: touches.length,
        firstSeenAt: new Date(touches[0]!.ts),
        lastSeenAt: new Date(touches[touches.length - 1]!.ts),
        landingPath: touches[0]!.landing,
        capturedAt: r.createdAt,
      });
      r.attributionId = id;
    }
  }

  // ── 4. money ──
  const payments: Prisma.PaymentCreateManyInput[] = [];
  const tips: Prisma.TipCreateManyInput[] = [];
  const ledger: (Prisma.TherapistPayoutLedgerCreateManyInput & { _employeeKey: string })[] = [];
  const audit: Prisma.FinancialAuditLogCreateManyInput[] = [];

  const receptionist = catalogue.userIds['reception']!;
  const manager = catalogue.userIds['manager']!;
  // The tip mix is dealt from an exact bag, not rolled per checkout: across ~150
  // completed visits a fair die lands several points off 40/35/25, and a fixture
  // whose job is to DEMONSTRATE the documented mix should actually hit it.
  const tipModes = buildTipBag(rng, planned.filter((r) => r.status === ReservationStatus.COMPLETED).length);
  let tipCursor = 0;
  let requestSeq = 0;
  const requestId = (): string => `req_seed_${String(++requestSeq).padStart(6, '0')}`;

  const writeAudit = (
    action: string,
    entityType: string,
    entityId: string,
    createdAt: Date,
    amountFils: number | null,
    actorUserId: string,
    actorRole: UserRole,
    afterState: Prisma.InputJsonValue,
  ): void => {
    audit.push({
      id: uuidv7(),
      branchId: catalogue.branchId,
      actorUserId,
      actorRole,
      action,
      entityType,
      entityId,
      beforeState: Prisma.JsonNull,
      afterState,
      amountFils,
      ipAddress: '10.0.0.24',
      userAgent: 'BeRelax-Reception-iPad/1.0 (seed)',
      requestId: requestId(),
      createdAt,
    });
  };

  for (const r of planned) {
    const desk = rng() < 0.2 ? manager : receptionist;
    const deskRole = desk === manager ? UserRole.MANAGER : UserRole.RECEPTIONIST;

    writeAudit('RESERVATION_CREATED', 'Reservation', r.id, r.createdAt, r.baseCostFils, desk, deskRole, {
      ref: r.ref,
      status: ReservationStatus.SCHEDULED,
      startsAt: r.startsAt.toISOString(),
      baseCostFils: r.baseCostFils,
    });

    if (r.status === ReservationStatus.CANCELLED) {
      writeAudit('RESERVATION_CANCELLED', 'Reservation', r.id, r.cancelledAt!, 0, desk, deskRole, {
        ref: r.ref,
        status: ReservationStatus.CANCELLED,
        cancellationReason: r.cancellationReason,
      });
      continue;
    }
    if (r.status === ReservationStatus.NO_SHOW) {
      writeAudit('RESERVATION_NO_SHOW', 'Reservation', r.id, addMinutes(r.startsAt, 20), 0, desk, deskRole, {
        ref: r.ref,
        status: ReservationStatus.NO_SHOW,
      });
      continue;
    }
    if (r.status !== ReservationStatus.COMPLETED) continue; // SCHEDULED: no money yet

    // ── check-in: BASE payment, collected up front (§8.2) ──
    const arrival = r.actualArrivalAt!;
    const arrivalDay = businessDay(arrival);
    const lines = splitBasePayment(rng, r.baseCostFils);
    lines.forEach((line, i) => {
      payments.push({
        id: uuidv7(),
        branchId: catalogue.branchId,
        reservationId: r.id,
        kind: PaymentKind.BASE,
        method: line.method,
        amountFils: line.amountFils,
        businessDay: dateOnly(arrivalDay),
        collectedByUserId: desk,
        collectedAt: arrival,
        externalRef: line.method === PaymentMethod.CARD ? `TRM-${intBetween(rng, 10000, 99999)}` : null,
        idempotencyKey: `seed:${r.ref}:base:${i}`,
      });
    });
    writeAudit('RESERVATION_CHECK_IN', 'Reservation', r.id, arrival, r.baseCostFils, desk, deskRole, {
      ref: r.ref,
      status: ReservationStatus.IN_PROGRESS,
      actualArrivalAt: arrival.toISOString(),
    });

    // Commission accrues on the base service at check-in, for therapists on commission.
    if (r.commissionBps > 0) {
      ledger.push({
        _employeeKey: r.employeeId,
        id: uuidv7(),
        branchId: catalogue.branchId,
        employeeId: r.employeeId,
        entryType: LedgerEntryType.COMMISSION_ACCRUAL,
        amountFils: Math.round((r.baseCostFils * r.commissionBps) / 10_000),
        businessDay: dateOnly(arrivalDay),
        reservationId: r.id,
        createdByUserId: desk,
        createdAt: arrival,
        note: `Commission ${r.commissionBps / 100}% on ${r.ref}`,
      });
    }

    // ── checkout: the tip, decided after the treatment (§8.3) ──
    const completedAt = r.completedAt!;
    const completedDay = businessDay(completedAt);
    const mode = tipModes[tipCursor++]!;

    let tipFils = 0;
    if (mode !== 'none') {
      // 5–20 % of the bill, rounded to a note, never anywhere near the 3x sanity cap.
      tipFils = roundToStep(Math.round(r.baseCostFils * (0.05 + rng() * 0.15)), 1000);
    }

    if (mode === 'collected') {
      // Mode A: the money enters the till, so the business now OWES the therapist.
      const paymentId = uuidv7();
      const tipId = uuidv7();
      const method = weighted(rng, [
        [PaymentMethod.CARD, 70],
        [PaymentMethod.CASH, 30],
      ] as const);
      payments.push({
        id: paymentId,
        branchId: catalogue.branchId,
        reservationId: r.id,
        kind: PaymentKind.TIP,
        method,
        amountFils: tipFils,
        businessDay: dateOnly(completedDay),
        collectedByUserId: desk,
        collectedAt: completedAt,
        externalRef: method === PaymentMethod.CARD ? `TRM-${intBetween(rng, 10000, 99999)}` : null,
        idempotencyKey: `seed:${r.ref}:tip`,
      });
      tips.push({
        id: tipId,
        branchId: catalogue.branchId,
        reservationId: r.id,
        employeeId: r.employeeId,
        type: TipType.COLLECTED_BY_BUSINESS,
        amountFils: tipFils,
        method,
        paymentId,
        businessDay: dateOnly(completedDay),
        recordedByUserId: desk,
        recordedAt: completedAt,
      });
      ledger.push({
        _employeeKey: r.employeeId,
        id: uuidv7(),
        branchId: catalogue.branchId,
        employeeId: r.employeeId,
        entryType: LedgerEntryType.TIP_ACCRUAL,
        amountFils: tipFils,
        businessDay: dateOnly(completedDay),
        reservationId: r.id,
        tipId,
        createdByUserId: desk,
        createdAt: completedAt,
        note: `Tip collected by business on ${r.ref}`,
      });
    } else if (mode === 'direct') {
      // Mode B: cash straight to the therapist. Recorded, but NO payment row and
      // deliberately NO ledger entry — the business never held it (§9.2).
      tips.push({
        id: uuidv7(),
        branchId: catalogue.branchId,
        reservationId: r.id,
        employeeId: r.employeeId,
        type: TipType.DIRECT_CASH,
        amountFils: tipFils,
        method: null,
        paymentId: null,
        businessDay: dateOnly(completedDay),
        recordedByUserId: desk,
        recordedAt: completedAt,
      });
    }

    writeAudit('RESERVATION_CHECKOUT', 'Reservation', r.id, completedAt, tipFils, desk, deskRole, {
      ref: r.ref,
      status: ReservationStatus.COMPLETED,
      completedAt: completedAt.toISOString(),
      tipFils,
      tipType: mode === 'none' ? null : mode === 'direct' ? TipType.DIRECT_CASH : TipType.COLLECTED_BY_BUSINESS,
    });
  }

  // ── 5. payout batches: everything accrued before the cutoff has been settled ──
  const payoutCutoff = addDays(anchorDay, -30);
  const batches: Prisma.PayoutBatchCreateManyInput[] = [];
  for (const employee of catalogue.employees) {
    const settled = ledger.filter(
      (l) => l._employeeKey === employee.id && (l.businessDay as Date).toISOString().slice(0, 10) <= payoutCutoff,
    );
    const total = settled.reduce((sum, l) => sum + l.amountFils, 0);
    if (settled.length === 0 || total <= 0) continue;

    const batchId = uuidv7();
    const days = settled.map((l) => (l.businessDay as Date).toISOString().slice(0, 10)).sort();
    const paidAt = dubaiAt(addDays(payoutCutoff, 1), '12:00');
    batches.push({
      id: batchId,
      branchId: catalogue.branchId,
      employeeId: employee.id,
      periodStart: dateOnly(days[0]!),
      periodEnd: dateOnly(payoutCutoff),
      totalFils: total,
      method: PaymentMethod.BANK_TRANSFER,
      paidAt,
      approvedByUserId: manager,
      acknowledgedAt: addMinutes(paidAt, 60 * 26),
      note: `Settled ${settled.length} accrual(s) up to ${payoutCutoff}`,
    });
    for (const entry of settled) entry.payoutBatchId = batchId;

    ledger.push({
      _employeeKey: employee.id,
      id: uuidv7(),
      branchId: catalogue.branchId,
      employeeId: employee.id,
      entryType: LedgerEntryType.PAYOUT,
      amountFils: -total, // signed: negative pays the balance down (§9.3)
      businessDay: dateOnly(businessDay(paidAt)),
      payoutBatchId: batchId,
      createdByUserId: manager,
      createdAt: paidAt,
      note: `Payout batch to ${payoutCutoff}`,
    });
    writeAudit('PAYOUT_CREATED', 'PayoutBatch', batchId, paidAt, total, manager, UserRole.MANAGER, {
      employeeId: employee.id,
      totalFils: total,
      periodEnd: payoutCutoff,
    });
  }

  // ── 6. shifts, so the utilisation report has something to divide by ──
  const shifts: Prisma.ShiftCreateManyInput[] = [];
  const seenShift = new Set<string>();
  for (const r of planned) {
    const key = `${r.employeeId}|${r.day}`;
    if (seenShift.has(key)) continue;
    seenShift.add(key);
    const plannedStart = dubaiAt(r.day, '11:00');
    const plannedEnd = dubaiAt(addDays(r.day, 1), '02:00');
    const future = r.day > anchorDay;
    shifts.push({
      id: stableId('shift', key),
      branchId: catalogue.branchId,
      employeeId: r.employeeId,
      businessDay: dateOnly(r.day),
      plannedStart,
      plannedEnd,
      clockInAt: future ? null : addMinutes(plannedStart, -intBetween(rng, 0, 15)),
      clockOutAt: future ? null : addMinutes(plannedEnd, intBetween(rng, 0, 20)),
      status: future ? ShiftStatus.PLANNED : ShiftStatus.ENDED,
    });
  }

  // ── 7. write, parents first ──
  await chunked(attributionRows, (rows) => prisma.attributionSnapshot.createMany({ data: rows }));
  await chunked(
    planned.map<Prisma.ReservationCreateManyInput>((r) => ({
      id: r.id,
      ref: r.ref,
      branchId: catalogue.branchId,
      guestId: r.guestId,
      employeeId: r.employeeId,
      roomId: r.roomId,
      serviceId: r.serviceId,
      startsAt: r.startsAt,
      durationMinutes: r.durationMinutes,
      // The derive trigger (§5.3) overwrites these three on insert. They are
      // computed correctly anyway so the seed is honest on its own terms.
      endsAt: r.endsAt,
      blockedUntil: r.blockedUntil,
      businessDay: dateOnly(businessDay(r.startsAt)),
      status: r.status,
      baseCostFils: r.baseCostFils,
      sourceChannel: r.sourceChannel,
      attributionId: r.attributionId,
      actualArrivalAt: r.actualArrivalAt,
      completedAt: r.completedAt,
      cancelledAt: r.cancelledAt,
      cancellationReason: r.cancellationReason,
      createdByUserId: receptionist,
      createdAt: r.createdAt,
    })),
    (rows) => prisma.reservation.createMany({ data: rows }),
  );
  await chunked(shifts, (rows) => prisma.shift.createMany({ data: rows }));
  await chunked(payments, (rows) => prisma.payment.createMany({ data: rows }));
  await chunked(batches, (rows) => prisma.payoutBatch.createMany({ data: rows }));
  await chunked(tips, (rows) => prisma.tip.createMany({ data: rows }));
  await chunked(
    ledger.map(({ _employeeKey, ...row }) => row),
    (rows) => prisma.therapistPayoutLedger.createMany({ data: rows }),
  );
  await chunked(audit, (rows) => prisma.financialAuditLog.createMany({ data: rows }));

  return {
    reservations: planned.length,
    payments: payments.length,
    tips: tips.length,
    ledgerEntries: ledger.length,
    auditEntries: audit.length,
    attributionSnapshots: attributionRows.length,
    shifts: shifts.length,
    payoutBatches: batches.length,
  };
}

type TipMode = 'none' | 'direct' | 'collected';

/** `count` checkouts split exactly 40/35/25, shuffled with a deterministic Fisher-Yates. */
function buildTipBag(rng: Rng, count: number): TipMode[] {
  const none = Math.round((count * TIP_MIX.none) / 100);
  const direct = Math.round((count * TIP_MIX.directCash) / 100);
  const bag: TipMode[] = [
    ...new Array<TipMode>(none).fill('none'),
    ...new Array<TipMode>(direct).fill('direct'),
    ...new Array<TipMode>(Math.max(0, count - none - direct)).fill('collected'),
  ];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [bag[i], bag[j]] = [bag[j]!, bag[i]!];
  }
  return bag;
}

/** Guests genuinely do pay part cash, part card. The lines must reconcile exactly (§8.2). */
function splitBasePayment(rng: Rng, baseCostFils: number): { method: PaymentMethod; amountFils: number }[] {
  const method = (): PaymentMethod =>
    weighted(rng, [
      [PaymentMethod.CASH, 52],
      [PaymentMethod.CARD, 44],
      [PaymentMethod.BANK_TRANSFER, 2],
      [PaymentMethod.VOUCHER, 2],
    ] as const);

  const steps = Math.floor(baseCostFils / 5000);
  if (rng() >= 0.15 || steps < 2) return [{ method: method(), amountFils: baseCostFils }];

  const cut = 5000 * intBetween(rng, 1, steps - 1);
  return [
    { method: PaymentMethod.CARD, amountFils: baseCostFils - cut },
    { method: PaymentMethod.CASH, amountFils: cut },
  ];
}

interface SeedTouch {
  ts: string;
  source: string;
  medium: string;
  campaign?: string;
  term?: string;
  gclid?: string;
  referrer?: string;
  landing: string;
}

/** A short ordered touch list ending at the moment of booking (§10.1). */
function buildTouches(rng: Rng, convertedAt: Date): SeedTouch[] {
  const count = intBetween(rng, 1, 4);
  const touches: SeedTouch[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const channel = weighted(rng, CHANNELS.map((c) => [c, c.weight] as const));
    touches.push({
      ts: addMinutes(convertedAt, -(i * intBetween(rng, 60, 60 * 72) + intBetween(rng, 1, 90))).toISOString(),
      source: channel.source,
      medium: channel.medium,
      ...(channel.campaign ? { campaign: channel.campaign } : {}),
      ...(channel.term ? { term: channel.term } : {}),
      ...(channel.gclid ? { gclid: `Cj0KCQ${intBetween(rng, 100000, 999999)}` } : {}),
      ...(channel.referrer ? { referrer: channel.referrer } : {}),
      landing: pick(rng, LANDING_PATHS),
    });
  }
  return touches;
}

/** Postgres has a bind-parameter ceiling; wide rows in one createMany will hit it. */
async function chunked<T>(rows: T[], write: (batch: T[]) => Promise<unknown>, size = 500): Promise<void> {
  for (let i = 0; i < rows.length; i += size) await write(rows.slice(i, i + size));
}

// ─────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────

export async function seed(prisma: PrismaClient, options: SeedOptions = {}): Promise<SeedSummary> {
  const quiet = options.quiet ?? false;
  const log = (...args: unknown[]): void => {
    if (!quiet) console.log(...args);
  };

  const anchorDay = options.anchorDay ?? process.env.SEED_ANCHOR_DAY ?? businessDay(new Date());
  const rng = mulberry32(options.randomSeed ?? 0xbe5e1a);

  log(`Seeding BE RELAX — anchor trading day ${anchorDay}`);
  const catalogue = await seedCatalogue(prisma, rng);
  log(`  catalogue: ${catalogue.services.length} services, ${catalogue.rooms.length} rooms, ` +
      `${catalogue.employees.length} employees, ${USERS.length} users, ${catalogue.guestIds.length} guests`);

  // The money tables are append-only (§5.4), so history cannot be upserted. Running
  // the seed twice therefore refreshes the catalogue and leaves the history alone.
  const existing = await prisma.reservation.count({ where: { branchId: catalogue.branchId } });
  if (existing > 0) {
    log(`  history: ${existing} reservations already present — left untouched (the seed is idempotent)`);
    printCredentials(log);
    return {
      branchId: catalogue.branchId,
      anchorDay,
      services: catalogue.services.length,
      rooms: catalogue.rooms.length,
      employees: catalogue.employees.length,
      users: USERS.length,
      guests: catalogue.guestIds.length,
      reservations: existing,
      payments: 0,
      tips: 0,
      ledgerEntries: 0,
      auditEntries: 0,
      attributionSnapshots: 0,
      shifts: 0,
      payoutBatches: 0,
      historySkipped: true,
    };
  }

  const history = await seedHistory(prisma, catalogue, anchorDay, rng);
  log(`  history: ${history.reservations} reservations, ${history.payments} payments, ` +
      `${history.tips} tips, ${history.ledgerEntries} ledger entries, ${history.payoutBatches} payout batches`);
  log(`  trail:   ${history.auditEntries} audit entries, ${history.attributionSnapshots} attribution snapshots, ` +
      `${history.shifts} shifts`);
  printCredentials(log);

  return {
    branchId: catalogue.branchId,
    anchorDay,
    services: catalogue.services.length,
    rooms: catalogue.rooms.length,
    employees: catalogue.employees.length,
    users: USERS.length,
    guests: catalogue.guestIds.length,
    historySkipped: false,
    ...history,
  };
}

function printCredentials(log: (...args: unknown[]) => void): void {
  log('');
  log('  Sign in with (development only — bcrypt cost 12, mustChangePassword: false):');
  for (const user of USERS) log(`    ${user.role.padEnd(12)} ${user.email.padEnd(24)} ${user.password}`);
  log('');
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV is production.');
  }
  const prisma = new PrismaClient();
  try {
    await seed(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked directly (`prisma db seed`). Importing this module — the
// e2e invariant suite does — must not write anything by itself.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
