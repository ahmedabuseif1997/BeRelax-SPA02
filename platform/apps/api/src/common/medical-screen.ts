import { UnprocessableEntityException } from '@nestjs/common';
import { ErrorCode } from '@berelax/contracts';

/**
 * BE RELAX stores no health or medical information — a decision, not an
 * omission. Under PDPL Art. 1 that data is sensitive, and Federal Law 2/2019
 * points at keeping health data generated in the UAE inside the UAE, which no
 * region of this database satisfies. Health questionnaires stay on paper.
 *
 * The schema has no column for it. This screen exists because free text does
 * not care what the schema intended: `guests.notes`, `reservations.notes` and
 * `booking_requests.message` will hold whatever someone types into them.
 *
 * The list is deliberately short and unambiguous. A check that rejected
 * "no jasmine oil" would teach reception to route around it within a week, and
 * then it protects nothing.
 */
export const MEDICAL_TERMS: ReadonlyArray<{ term: string; pattern: RegExp }> = [
  { term: 'pregnancy', pattern: /\bpregnan/i },
  { term: 'diabetes', pattern: /\bdiabet/i },
  { term: 'hypertension', pattern: /\bhypertens/i },
  { term: 'blood pressure', pattern: /\bblood\s+pressure\b/i },
  { term: 'medication', pattern: /\bmedication/i },
  { term: 'surgery', pattern: /\bsurger/i },
  { term: 'epilepsy', pattern: /\bepilep/i },
  { term: 'asthma', pattern: /\basthma\b/i },
  { term: 'heart condition', pattern: /\bheart\s+condition/i },
  { term: 'injury', pattern: /\binjur(y|ies|ed)\b/i },
];

export function findMedicalTerm(text: string | null | undefined): string | null {
  if (!text) return null;
  return MEDICAL_TERMS.find((t) => t.pattern.test(text))?.term ?? null;
}

/**
 * The STAFF path. Reception typing into the CRM gets a hard refusal, because
 * they can be taught the rule and the refusal is how they learn it.
 */
export function assertNotMedical(text: string | null | undefined): void {
  const term = findMedicalTerm(text);
  if (!term) return;

  throw new UnprocessableEntityException({
    error: {
      code: ErrorCode.GUEST_NOTES_MEDICAL_CONTENT,
      message:
        'Notes are for preferences only. Keep medical information on paper in the locked cabinet — this system stores no health data.',
      // The matched term, never the text submitted: the point is to say what
      // tripped, not to log the thing we just refused to store.
      details: { term },
    },
  });
}

/**
 * The GUEST path. Someone filling in the website form is not staff and cannot
 * be taught a rule — refusing their booking because they mentioned a shoulder
 * would lose the booking and teach them nothing. So the enquiry is accepted and
 * the text is simply not kept.
 *
 * Dropping it whole rather than masking the word matters: "no pressure on my
 * left shoulder, old injury" with one word masked still reads as a health note,
 * and a partial redaction would leave most of it in the column.
 */
export function screenPublicText(
  text: string | null | undefined,
): { text: string | null; redacted: boolean; term: string | null } {
  const term = findMedicalTerm(text);
  if (!term) return { text: text ?? null, redacted: false, term: null };
  return { text: null, redacted: true, term };
}
