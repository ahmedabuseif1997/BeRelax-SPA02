'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { SourceChannel, createReservationSchema, formatAed } from '@berelax/contracts';
import type {
  CreateReservationBody,
  EmployeeSummary,
  GuestSummary,
  ReservationView,
  RoomSummary,
  ServiceSummary,
} from '@/lib/api-types';
import { useAuth } from '@/lib/auth-context';
import { explainConflict, type ConflictExplanation } from '@/lib/conflict';
import {
  TRADING_MINUTES,
  businessDayLabel,
  dubaiTime,
  slotInstant,
} from '@/lib/grid-time';
import { useReservations } from '@/lib/reservations-context';
import { Button } from '../ui/button';
import { ErrorNotice } from '../ui/error-notice';
import { Sheet } from '../ui/sheet';

/**
 * Take a booking.
 *
 * There is no availability check before the POST, on purpose: the three
 * database exclusion constraints arbitrate, and a check-then-insert would
 * double-book on a busy Friday when two receptionists tap Confirm in the same
 * second (spec §5.5). What this sheet owes the receptionist is a 409 they can
 * act on — which therapist, which hour — and a form that still holds everything
 * they typed so the fix is one tap, not a re-entry.
 */

const SLOT_STEP_MINUTES = 15;

export interface NewBookingPrefill {
  employeeId?: string;
  startsAt?: Date;
}

export function NewBookingSheet({
  prefill,
  services,
  employees,
  rooms,
  onClose,
  onCreated,
}: {
  prefill: NewBookingPrefill;
  services: readonly ServiceSummary[];
  employees: readonly EmployeeSummary[];
  rooms: readonly RoomSummary[];
  onClose: () => void;
  onCreated: (reservation: ReservationView) => void;
}): JSX.Element {
  const { client } = useAuth();
  const { day, reservations, writesEnabled, applyReservation, refresh } = useReservations();

  const slots = useMemo(() => buildSlots(), []);
  const defaultSlot = useMemo(
    () => (prefill.startsAt ? minutesInto(day, prefill.startsAt) : nearestSlot(day, slots)),
    [prefill.startsAt, day, slots],
  );

  const [employeeId, setEmployeeId] = useState(prefill.employeeId ?? employees[0]?.id ?? '');
  const [serviceId, setServiceId] = useState(services[0]?.id ?? '');
  const [roomId, setRoomId] = useState('');
  const [slotMinutes, setSlotMinutes] = useState(defaultSlot);
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [guestQuery, setGuestQuery] = useState('');
  const [guestMatches, setGuestMatches] = useState<GuestSummary[]>([]);
  const [guest, setGuest] = useState<GuestSummary | null>(null);
  const [sourceChannel, setSourceChannel] = useState<SourceChannel>(SourceChannel.WALK_IN);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<ConflictExplanation | null>(null);
  const [pending, setPending] = useState(false);

  const service = services.find((s) => s.id === serviceId);
  const durationMinutes = service?.durationMinutes ?? 60;
  const startsAt = slotInstant(day, slotMinutes);
  // E.164 or nothing: `createReservationSchema` will not take "050 123 4567".
  const phone = normaliseUaeMobile(guestPhone);

  const body: CreateReservationBody = {
    employeeId,
    serviceId,
    ...(roomId ? { roomId } : {}),
    ...(anonymous
      ? {}
      : guest
        ? { guestId: guest.id }
        : {
            ...(guestName.trim() ? { guestName: guestName.trim() } : {}),
            ...(phone ? { guestPhone: phone } : {}),
          }),
    startsAt: startsAt.toISOString(),
    sourceChannel,
    ...(notes.trim() ? { notes: notes.trim() } : {}),
  };

  const validation = createReservationSchema.safeParse(body);

  const submit = async (): Promise<void> => {
    if (pending || !writesEnabled) return;
    if (!validation.success) {
      setConflict(null);
      setError(new Error(validation.error.issues[0]?.message ?? 'Check the booking details.'));
      return;
    }

    setPending(true);
    setError(null);
    setConflict(null);
    try {
      const created = await client.request<ReservationView>('/reservations', {
        method: 'POST',
        body,
      });
      applyReservation(created);
      void refresh();
      onCreated(created);
    } catch (createError) {
      // A 409 is the database saying the slot went while they were typing. Name
      // the clash; keep every field exactly as it is.
      const explained = explainConflict(
        createError,
        {
          employeeId,
          roomId: roomId || undefined,
          guestId: guest?.id,
          startsAt: body.startsAt,
          durationMinutes,
        },
        reservations,
      );
      setConflict(explained);
      if (!explained) setError(createError);
    } finally {
      setPending(false);
    }
  };

  /**
   * `GET /guests?search=` matches the name and the phone at once — reception has
   * one search box, so this has one too. Failure is silent: not finding an
   * existing guest never blocks taking the booking, because the API upserts on
   * (branch, phone) anyway and the second visit finds the first guest.
   */
  useEffect(() => {
    const term = guestQuery.trim();
    if (anonymous || guest || term.length < 2) {
      setGuestMatches([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const found = await client.request<GuestSummary[]>(
            `/guests?search=${encodeURIComponent(term)}&limit=6`,
          );
          if (!cancelled) setGuestMatches(Array.isArray(found) ? found : []);
        } catch {
          if (!cancelled) setGuestMatches([]);
        }
      })();
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, guestQuery, anonymous, guest]);

  const noStaff = employees.length === 0;
  const noMenu = services.length === 0;
  // A treatment that needs a room must not go out without one.
  const roomMissing = service?.requiresRoom === true && roomId === '';

  return (
    <Sheet
      open
      title="New booking"
      subtitle={`${businessDayLabel(day)} · trading day`}
      onClose={onClose}
      busy={pending}
      footer={
        <div className="flex items-center gap-3">
          <Button variant="quiet" size="lg" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="lg"
            block
            disabled={!writesEnabled || noStaff || noMenu || roomMissing}
            pending={pending}
            pendingLabel="Confirming…"
            onClick={() => void submit()}
          >
            Confirm {dubaiTime(startsAt)}
            {service ? ` · ${formatAed(service.priceFils)}` : ''}
          </Button>
        </div>
      }
    >
      {conflict ? (
        <div
          role="alert"
          className="mb-5 rounded-xl border-2 border-alert bg-alert-pale px-4 py-3.5 text-alert-deep"
        >
          <p className="text-[16px] font-semibold leading-snug">{conflict.message}</p>
          <p className="mt-1.5 text-[14px]">
            {conflict.field === 'employee'
              ? 'Pick another therapist or another time — everything else you typed is still here.'
              : conflict.field === 'room'
                ? 'Pick another room or another time.'
                : conflict.field === 'guest'
                  ? 'This guest is already in a treatment then.'
                  : 'Pick another time.'}
          </p>
        </div>
      ) : null}

      {noMenu ? (
        <div className="mb-5 rounded-xl border border-gold-light bg-gold-pale px-4 py-3 text-[14px] leading-snug text-gold-deep">
          <span className="numeric">GET /services</span> returned nothing, so a booking cannot be
          priced. The grid, check-in and checkout still work.
        </div>
      ) : null}

      {noStaff ? (
        <div className="mb-5 rounded-xl border border-gold-light bg-gold-pale px-4 py-3 text-[14px] leading-snug text-gold-deep">
          No therapists to choose from: nobody is on shift for this trading day in{' '}
          <span className="numeric">/availability</span>, and nobody has a booking yet. Add a shift
          first.
        </div>
      ) : null}

      <Field label="Therapist" highlight={conflict?.field === 'employee'}>
        <select
          className="field-input"
          value={employeeId}
          onChange={(event) => setEmployeeId(event.target.value)}
        >
          <option value="">Choose a therapist</option>
          {employees.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.displayName}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Treatment">
        <select
          className="field-input"
          value={serviceId}
          onChange={(event) => setServiceId(event.target.value)}
        >
          <option value="">Choose a treatment</option>
          {services.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.durationMinutes} min · {formatAed(item.priceFils)}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Starts" highlight={conflict?.field === 'time'}>
          <select
            className="field-input numeric"
            value={slotMinutes}
            onChange={(event) => setSlotMinutes(Number(event.target.value))}
          >
            {slots.map((minutes) => (
              <option key={minutes} value={minutes}>
                {dubaiTime(slotInstant(day, minutes))}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Room" highlight={conflict?.field === 'room'}>
          <select
            className="field-input"
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            disabled={rooms.length === 0}
          >
            <option value="">{rooms.length === 0 ? 'Not available' : 'No room'}</option>
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <p className="-mt-2 mb-2 text-[13px] text-ink-muted">
        {service
          ? `Ends ${dubaiTime(new Date(startsAt.getTime() + durationMinutes * 60_000))} · ${durationMinutes} minutes`
          : 'Pick a treatment to set the length.'}
      </p>

      {roomMissing ? (
        <p className="mb-5 rounded-xl border border-gold-light bg-gold-pale px-4 py-2.5 text-[13.5px] text-gold-deep">
          {service?.name} needs a room. Pick one before confirming.
        </p>
      ) : (
        <div className="mb-5" />
      )}

      <div className="mb-4 rounded-xl border border-line bg-white p-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={anonymous}
            onChange={(event) => setAnonymous(event.target.checked)}
            className="mt-1 h-5 w-5 flex-none accent-teal-700"
          />
          <span className="text-[14px] leading-snug text-ink">
            Walk-in, no details taken
            <span className="mt-0.5 block text-[13px] text-ink-muted">
              Books with no guest record at all. Only for someone who walks in off the street.
            </span>
          </span>
        </label>
      </div>

      {anonymous ? null : guest ? (
        <div className="mb-4 rounded-xl border border-teal-300 bg-teal-50 px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[16px] font-medium text-ink">{guest.fullName}</p>
              <p className="text-[13.5px] text-ink-muted numeric">{guest.phone}</p>
              {guest.notes ? (
                <p className="mt-1 text-[13px] leading-snug text-ink-muted">{guest.notes}</p>
              ) : null}
            </div>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setGuest(null);
                setGuestQuery('');
              }}
            >
              Someone else
            </Button>
          </div>
          {guest.isBlocked ? (
            <p className="mt-2 rounded-lg border border-alert-line bg-alert-pale px-3 py-2 text-[13.5px] text-alert-deep">
              This guest is blocked. Check with a manager before booking them in.
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <Field label="Find an existing guest" highlight={conflict?.field === 'guest'}>
            <input
              className="field-input"
              value={guestQuery}
              onChange={(event) => setGuestQuery(event.target.value)}
              placeholder="Name or mobile"
              autoCapitalize="words"
            />
            {guestMatches.length > 0 ? (
              <ul className="mt-2 overflow-hidden rounded-xl border border-line bg-white">
                {guestMatches.map((match) => (
                  <li key={match.id} className="border-b border-line last:border-b-0">
                    <button
                      type="button"
                      onClick={() => {
                        setGuest(match);
                        setGuestMatches([]);
                      }}
                      className="flex min-h-[52px] w-full items-center justify-between gap-3 px-4 text-left hover:bg-teal-50"
                    >
                      <span className="truncate text-[15px] text-ink">{match.fullName}</span>
                      <span className="flex-none text-[13.5px] text-ink-muted numeric">
                        {match.phone}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </Field>

          <p className="-mt-2 mb-4 text-[13px] text-ink-muted">
            Nobody matching? Type the name and number below and they will be added.
          </p>

          <Field label="New guest name">
            <input
              className="field-input"
              value={guestName}
              onChange={(event) => setGuestName(event.target.value)}
              autoCapitalize="words"
              maxLength={120}
            />
          </Field>

          <Field label="Mobile">
            <input
              className="field-input numeric"
              value={guestPhone}
              onChange={(event) => setGuestPhone(event.target.value)}
              inputMode="tel"
              placeholder="050 123 4567"
            />
            <p className="mt-1.5 text-[13px] text-ink-muted">
              {phone
                ? `Saved as ${phone} — the same number finds the same guest next visit.`
                : 'A UAE mobile, e.g. 050 123 4567.'}
            </p>
          </Field>
        </>
      )}

      <Field label="How did they book?">
        <select
          className="field-input"
          value={sourceChannel}
          onChange={(event) => setSourceChannel(event.target.value as SourceChannel)}
        >
          {Object.values(SourceChannel).map((channel) => (
            <option key={channel} value={channel}>
              {channel.replace(/_/g, ' ').toLowerCase()}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Notes (optional)">
        <input
          className="field-input"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          maxLength={500}
          placeholder="Prefers firm pressure"
        />
      </Field>

      {error ? <ErrorNotice error={error} /> : null}
    </Sheet>
  );
}

function Field({
  label,
  highlight = false,
  children,
}: {
  label: string;
  highlight?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`mb-4 ${highlight ? 'rounded-xl bg-alert-pale p-3 ring-2 ring-alert' : ''}`}>
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}

/* ───────────────────────── helpers ───────────────────────── */

function buildSlots(): number[] {
  const slots: number[] = [];
  for (let minutes = 0; minutes < TRADING_MINUTES; minutes += SLOT_STEP_MINUTES) {
    slots.push(minutes);
  }
  return slots;
}

function minutesInto(day: string, at: Date): number {
  const minutes = (at.getTime() - slotInstant(day, 0).getTime()) / 60_000;
  return Math.max(0, Math.min(TRADING_MINUTES - SLOT_STEP_MINUTES, Math.round(minutes)));
}

/** The next quarter-hour, or the start of the evening if we are outside it. */
function nearestSlot(day: string, slots: readonly number[]): number {
  const minutes = minutesInto(day, new Date());
  const rounded = Math.ceil(minutes / SLOT_STEP_MINUTES) * SLOT_STEP_MINUTES;
  return slots.includes(rounded) ? rounded : (slots[0] ?? 0);
}

/**
 * `createReservationSchema` wants E.164: +9715XXXXXXXX. Reception types
 * "050 123 4567" or "+971 50 123 4567" — both mean the same person, and the
 * (branch, phone) unique index is what turns a second visit into the same guest
 * rather than a twin.
 */
export function normaliseUaeMobile(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, '');
  const national = digits
    .replace(/^\+971/, '')
    .replace(/^00971/, '')
    .replace(/^971/, '')
    .replace(/^0/, '');
  if (!/^5\d{8}$/.test(national)) return null;
  return `+971${national}`;
}
