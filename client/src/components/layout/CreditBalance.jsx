import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Coins } from 'lucide-react';
import { creditService } from '../../services/creditService';
import { CREDITS_CHANGED, creditWord } from '../../utils/credit';

/**
 * The signed-in person's credit balance, in the header. The number always comes from the server (never from anything the browser worked out): it is read on
 * load, again every minute, and at once when something in this tab moves credits (the `usha:credits-changed` event an approval fires). It links to the ledger
 * that explains it. If the request fails, the chip simply stays out of the way rather than breaking the header.
 */
export default function CreditBalance() {
  const [balance, setBalance] = useState(null);
  const load = useCallback(() => {
    creditService
      .balance()
      .then((d) => setBalance(Number(d?.balance || 0)))
      .catch(() => {}); // the rest of the header still works
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60000);
    window.addEventListener(CREDITS_CHANGED, load);
    return () => {
      clearInterval(timer);
      window.removeEventListener(CREDITS_CHANGED, load);
    };
  }, [load]);

  if (balance === null) return null;
  return (
    <Link
      to="/credit?tab=ledger"
      aria-label={`Your credit balance is ${creditWord(balance)}. Open the credit ledger.`}
      className="hidden items-center gap-1.5 rounded-full border border-line bg-subtle px-2.5 py-1 text-[13px] font-bold tabular-nums transition-colors hover:border-accent hover:text-accent sm:flex"
    >
      <Coins className="h-4 w-4 text-accent" aria-hidden="true" />
      <span data-testid="credit-balance">{balance.toLocaleString('en-IN')}</span>
      <span className="font-semibold text-muted">credits</span>
    </Link>
  );
}
