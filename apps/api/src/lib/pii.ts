/**
 * Admin notes (on members and on reports) are for handover, not for collecting data about anyone: refuse what looks
 * like an e-mail address, a phone number (Korean or international), a card number or a resident registration number.
 * Chip amounts and dates pass.
 */
const PERSONAL = [
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i,
  /(^|[^\d])0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/,
  /\+\d{1,3}[-.\s]?\d{1,4}[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/,
  /(^|[^\d])\d{6}[-\s]?[1-8]\d{6}(?!\d)/,
  /(^|[^\d])\d{4}([-\s]?\d{4}){3}(?!\d)/,
];
export const looksPersonal = (s: string) => PERSONAL.some((re) => re.test(s));
