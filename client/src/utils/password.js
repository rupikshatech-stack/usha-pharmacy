// Mirrors the server's password policy (server/utils/password.js) so users get instant feedback.
// The server is the source of truth and re-checks everything.
export const passwordRules = [
  { id: 'len', label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { id: 'lower', label: 'A lowercase letter', test: (p) => /[a-z]/.test(p) },
  { id: 'upper', label: 'An uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { id: 'num', label: 'A number', test: (p) => /\d/.test(p) },
  { id: 'sym', label: 'A symbol (e.g. @ # $ !)', test: (p) => /[^A-Za-z0-9]/.test(p) },
  { id: 'max', label: 'No more than 72 characters', test: (p) => new TextEncoder().encode(p).length <= 72 },
];

export const passwordValid = (p) => passwordRules.every((r) => r.test(p));
