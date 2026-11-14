import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import { IconButton, Logo } from '../../components/common/ui';

/** Centered single-card layout for the auth pages that don't use the split login layout. */
export default function AuthShell({ title, description, children, footer }) {
  const { theme, toggle } = useTheme();
  return (
    <div className="relative flex min-h-full items-center justify-center bg-app p-4">
      <IconButton label="Toggle theme" onClick={toggle} className="absolute right-4 top-4">
        {theme === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
      </IconButton>
      <div className="anim-pop w-full max-w-md">
        <div className="mx-auto mb-6 w-44">
          <Logo />
        </div>
        <div className="rounded-2xl border border-line bg-card p-6 shadow-card sm:p-8">
          <h1 className="text-xl font-bold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
          <div className="mt-6">{children}</div>
        </div>
        {footer && <div className="mt-5 text-center text-sm text-muted">{footer}</div>}
      </div>
    </div>
  );
}
