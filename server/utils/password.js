// bcrypt only uses the first 72 bytes, so longer passwords would be silently truncated.
export const PASSWORD_MAX = 72;

/** Returns a human-readable problem with the password, or null if it meets the policy. */
export function passwordProblem(pw) {
  if (typeof pw !== 'string') return 'Password is required';
  if (pw.length < 8) return 'Password must be at least 8 characters';
  if (Buffer.byteLength(pw) > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;
  if (!/[a-z]/.test(pw)) return 'Password must include a lowercase letter';
  if (!/[A-Z]/.test(pw)) return 'Password must include an uppercase letter';
  if (!/\d/.test(pw)) return 'Password must include a number';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password must include a symbol (e.g. @ # $ !)';
  return null;
}
