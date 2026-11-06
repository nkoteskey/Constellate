import { findPersonNames } from './names.js';

/**
 * Constellate's personal-data rule: records are permanent (signed, gossiped,
 * archived on Autonomi), so people are only ever referred to by a PUBLIC handle
 * (@name) or an organisation. Never an email address, phone number, personal
 * name, home folder or other personal detail.
 *
 * Two tools enforce it:
 * - the scrubber BLOCKS anything a person or agent tries to publish with personal
 *   data in it (blocked, not trimmed: they fix it and try again), and every node
 *   refuses to store or pass on records from the network that contain it;
 * - `redactPersonal` CLEANS text we import from public history (issues, pull
 *   requests, CI logs) before it is signed, so a useful lesson isn't lost
 *   because someone pasted their email into an issue.
 */
const RULES: [RegExp, string][] = [
  [/\b[A-Za-z0-9._%+-]+@(?!(?:example|users\.noreply\.github)\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>'],
  [/(\/Users\/|\/home\/|[A-Z]:\\Users\\)(?!runner\b|user\b|ubuntu\b|root\b|seat\b|rename\b)[A-Za-z0-9._-]+/g, '~'],
  // Phone numbers only in unmistakable formats: international (+44 7700 900123) or North American ((555) 123-4567, 555-123-4567).
  // Job ids, run numbers, dates and versions are never touched.
  [/(?<![\w.+])\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]\d{2,6}){1,3}(?![\w.])|(?<![\w.])\(\d{3}\)[ .-]?\d{3}-\d{4}(?![\w.])|(?<![\w.-])\d{3}-\d{3}-\d{4}(?![\w.-])/g, '<phone>'],
];

export function redactPersonal(text: string): string {
  let s = text;
  for (const [re, to] of RULES) s = s.replace(re, to);
  // Names last, from the end so indexes stay valid.
  for (const n of findPersonNames(s).sort((a, b) => b.index - a.index)) s = s.slice(0, n.index) + '<person>' + s.slice(n.index + n.name.length);
  return s;
}
