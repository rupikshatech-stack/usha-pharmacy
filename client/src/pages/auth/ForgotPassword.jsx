import { Link } from 'react-router-dom';
import { ArrowLeft, KeyRound } from 'lucide-react';
import AuthShell from './AuthShell';

/**
 * Self-service reset by email isn't available yet (no email service is configured), so this page
 * tells people the truth and what to do instead.
 */
export default function ForgotPassword() {
  return (
    <AuthShell
      title="Forgot your password?"
      description="Password resets are handled by your administrator."
      footer={
        <Link to="/login" className="inline-flex items-center gap-1.5 font-semibold text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to sign in
        </Link>
      }
    >
      <div className="flex gap-3 rounded-xl bg-sage p-4 text-sm text-sage-ink">
        <KeyRound className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <p>Ask the administrator of your organization to set a new password for your account. You'll be asked to choose your own password the next time you sign in.</p>
      </div>
      <p className="mt-4 text-xs text-muted">Reset-by-email isn't enabled for this installation.</p>
    </AuthShell>
  );
}
