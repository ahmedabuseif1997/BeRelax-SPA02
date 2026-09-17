import { HttpException } from '@nestjs/common';
import { assertNotMedical, findMedicalTerm, screenPublicText } from './medical-screen';

/**
 * The screen has to fail in two directions to be worth having. Too loose and
 * health data lands in a column that must not hold it; too tight and reception
 * learns to route around it within a week, after which it protects nothing.
 */
describe('the medical screen (§11.5)', () => {
  const REAL_PREFERENCES = [
    'prefers firm pressure',
    'no jasmine oil',
    'requests a female therapist',
    'likes the room warm, lights low',
    'allergic to nothing, happy with any oil',
    'heartfelt thank-you note left at the desk',
    'regular guest — always books the Moroccan bath',
    'prefers Therapist B if she is on',
  ];

  const MEDICAL_INTAKE = [
    'guest is pregnant, avoid deep tissue',
    'type 2 diabetes',
    'has hypertension',
    'high blood pressure, go gently',
    'on medication for her back',
    'recent surgery on left knee',
    'epilepsy — no strong scents',
    'asthma, keep the steam light',
    'heart condition, nothing vigorous',
    'old shoulder injury',
  ];

  describe('what it must let through', () => {
    it.each(REAL_PREFERENCES)('allows %p', (note) => {
      expect(findMedicalTerm(note)).toBeNull();
      expect(() => assertNotMedical(note)).not.toThrow();
      expect(screenPublicText(note)).toEqual({ text: note, redacted: false, term: null });
    });

    it('allows nothing at all', () => {
      expect(() => assertNotMedical(null)).not.toThrow();
      expect(() => assertNotMedical(undefined)).not.toThrow();
      expect(() => assertNotMedical('')).not.toThrow();
      expect(screenPublicText(null).text).toBeNull();
    });
  });

  describe('what it must catch', () => {
    it.each(MEDICAL_INTAKE)('catches %p', (note) => {
      expect(findMedicalTerm(note)).not.toBeNull();
    });
  });

  describe('the staff path refuses, so reception learns the rule', () => {
    it('throws 422 naming the term', () => {
      let thrown: HttpException | undefined;
      try {
        assertNotMedical('guest is pregnant, avoid deep tissue');
      } catch (err) {
        thrown = err as HttpException;
      }
      expect(thrown?.getStatus()).toBe(422);
      const body = thrown?.getResponse() as { error: { code: string; details: { term: string } } };
      expect(body.error.code).toBe('GUEST_NOTES_MEDICAL_CONTENT');
      expect(body.error.details.term).toBe('pregnancy');
    });

    it('never echoes the text it refused to store', () => {
      const secret = 'Fatima has epilepsy and takes lamotrigine';
      try {
        assertNotMedical(secret);
      } catch (err) {
        // Telling reception WHAT tripped is the point; logging the health note
        // into an error body would store the very thing we just refused.
        expect(JSON.stringify((err as HttpException).getResponse())).not.toContain('lamotrigine');
        expect(JSON.stringify((err as HttpException).getResponse())).not.toContain('Fatima');
      }
      expect.assertions(2);
    });
  });

  describe('the guest path keeps the booking and drops the text', () => {
    it('accepts the enquiry but stores nothing of the note', () => {
      const result = screenPublicText('no pressure on my left shoulder, old injury');
      expect(result.redacted).toBe(true);
      expect(result.term).toBe('injury');
      // Whole, not masked: "old [redacted]" still reads as a health note, and a
      // partial redaction would leave most of it in the column anyway.
      expect(result.text).toBeNull();
    });

    it('does not punish a guest for booking', () => {
      // The contrast that matters: same text, two call sites, two behaviours.
      expect(() => screenPublicText('guest is pregnant')).not.toThrow();
      expect(() => assertNotMedical('guest is pregnant')).toThrow();
    });
  });
});
