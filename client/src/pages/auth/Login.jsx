import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, Eye, EyeOff, Moon, ReceiptText, ShieldCheck, Sun } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { Button, FormField, IconButton, Logo, cx, inputCls } from '../../components/common/ui';

const points = [
  [Boxes, 'Batch-wise stock with expiry tracking'],
  [ReceiptText, 'A keyboard-first billing counter'],
  [ShieldCheck, 'Isolated, audited data for every organization'],
];

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(f) {
  const e = {};
  if (!f.email.trim()) e.email = 'Enter your email address';
  else if (!EMAIL_RX.test(f.email.trim())) e.email = 'Enter a valid email address, like name@company.com';
  if (!f.password) e.password = 'Enter your password';
  return e;
}

export default function Login() {
  const { login } = useAuth();
  const { theme, toggle } = useTheme();
  const [form, setForm] = useState({ email: '', password: '', remember: false });
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null); // { message, locked }

  const errors = validate(form);
  const fieldError = (k) => (submitted || touched[k] ? errors[k] : undefined);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }));

  const submit = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    setError(null);
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      await login(form.email.trim(), form.password, form.remember);
      toast.success('Welcome back');
      // GuestRoute redirects to the page they wanted, or /dashboard.
    } catch (err) {
      setError({ message: err.message, locked: err.code === 'ACCOUNT_LOCKED' || err.status === 429 });
      setForm((f) => ({ ...f, password: '' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full bg-app lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-side p-12 text-white lg:flex">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{ backgroundImage: 'radial-gradient(currentColor 1px, transparent 1px)', backgroundSize: '22px 22px' }}
          aria-hidden="true"
        />
        <div className="relative w-56">
          <Logo onDark />
        </div>
        <div className="relative max-w-md">
          <h1 className="text-[34px] font-extrabold leading-[1.15] tracking-tight">Wholesale pharmacy operations, in one calm workspace.</h1>
          <p className="mt-4 text-[15px] opacity-80">Inventory, billing, returns and suppliers — organized, auditable and fast.</p>
          <ul className="mt-9 space-y-4 text-sm">
            {points.map(([Icon, text]) => (
              <li key={text} className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-white/10">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs opacity-60">© {new Date().getFullYear()} Usha Pharmacy</p>
      </aside>

      <main className="relative flex items-center justify-center p-6">
        <IconButton label="Toggle theme" onClick={toggle} className="absolute right-4 top-4">
          {theme === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </IconButton>

        <form onSubmit={submit} noValidate className="anim-pop w-full max-w-sm">
          <div className="mb-8 w-48 lg:hidden">
            <Logo />
          </div>
          <h2 className="text-2xl font-bold tracking-tight">Welcome back</h2>
          <p className="mt-1 text-sm text-muted">Sign in to access your workspace.</p>

          {error && (
            <div role="alert" className={cx('mt-5 rounded-lg border px-3.5 py-2.5 text-sm', error.locked ? 'border-warning/40 bg-warning-soft text-ink' : 'border-danger/30 bg-danger-soft text-danger')}>
              {error.message}
            </div>
          )}

          <div className="mt-6 space-y-4">
            <FormField label="Email" required error={fieldError('email')}>
              {(a) => (
                <input
                  {...a}
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  placeholder="you@company.com"
                  value={form.email}
                  onChange={set('email')}
                  onBlur={blur('email')}
                  autoFocus
                  className={cx(inputCls, fieldError('email') && 'border-danger')}
                />
              )}
            </FormField>

            <FormField label="Password" required error={fieldError('password')}>
              {(a) => (
                <div className="relative">
                  <input
                    {...a}
                    type={show ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="••••••••"
                    value={form.password}
                    onChange={set('password')}
                    onBlur={blur('password')}
                    className={cx(inputCls, 'pr-10', fieldError('password') && 'border-danger')}
                  />
                  <button
                    type="button"
                    onClick={() => setShow((s) => !s)}
                    aria-label={show ? 'Hide password' : 'Show password'}
                    className="absolute right-0 top-0 grid h-10 w-10 place-items-center text-muted hover:text-ink"
                  >
                    {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              )}
            </FormField>

            <div className="flex items-center justify-between gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" checked={form.remember} onChange={(e) => setForm((f) => ({ ...f, remember: e.target.checked }))} className="h-4 w-4 accent-[var(--primary)]" />
                Remember me
              </label>
              <Link to="/forgot-password" className="text-sm font-semibold text-primary hover:underline">
                Forgot password?
              </Link>
            </div>
          </div>

          <Button type="submit" loading={busy} className="mt-6 w-full">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
          <p className="mt-5 text-center text-xs text-muted">
            {form.remember ? 'You will stay signed in on this device.' : 'On a shared computer? Leave "Remember me" unchecked.'}
          </p>
        </form>
      </main>
    </div>
  );
}
