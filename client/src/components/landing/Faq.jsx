import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Kicker, Plus, Split, useOvReveals } from './overstory/parts';

/*
 * Questions: the FAQ of "Overstory Studio Landing" (MIT, Kedhareswer Naidu). An accordion that opens smoothly, next
 * to a card; the template's card copies an email, this one leads to sign-in, since workspaces are set up for
 * pharmacies rather than signed up for. Every answer describes what the app does today.
 */

const FAQ = [
  {
    q: 'How do we get started?',
    a: 'There is no public sign-up. Your pharmacy’s workspace is set up for you, and your administrator then creates an account for each person, with the role they need.',
  },
  {
    q: 'Can we bring our existing stock?',
    a: 'Yes. Import your inventory from a CSV file. You see a preview of every row before anything is saved, and you can cancel the import at that point.',
  },
  {
    q: 'Does it handle GST?',
    a: 'Invoices are GST-ready, and the GST report is built from the same records as your sales and purchases, so the two always agree.',
  },
  {
    q: 'How does it deal with expiry?',
    a: 'Every batch carries its expiry date. Batches are listed earliest expiry first, expiry alerts flag what is close, and the expiry view shows which stock will not sell in time.',
  },
  {
    q: 'Can we run more than one branch?',
    a: 'Yes. Branches share one workspace. Transfer stock between them, and see performance branch by branch.',
  },
  {
    q: 'Can supplier invoices be read automatically?',
    a: 'Upload a supplier’s invoice and it is read for you. You review what was read and save it as a draft order; nothing changes your stock until you confirm.',
  },
  {
    q: 'Who can see what?',
    a: 'Each person has a role with its own permissions, every pharmacy sees only its own data, and changes are kept in an activity log.',
  },
];

export default function Faq() {
  const root = useRef(null);
  const [open, setOpen] = useState(0);
  useOvReveals(root);

  return (
    <section id="faq" ref={root} className="lp-ov lp-ov-sec scroll-mt-20" aria-labelledby="faq-heading">
      <div className="lp-ov-wrap lp-ov-faq-grid">
        <div>
          <Kicker n="03" text="Questions" />
          <Split id="faq-heading" text="What pharmacies ask us first" />
          <div className="lp-ov-faq-card" data-rv>
            <p>Already have a workspace? Sign in with the account your administrator created for you.</p>
            <Link to="/login" className="lp-ov-btn">
              Sign in <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </div>
        <div className="lp-ov-acc">
          {FAQ.map((f, i) => {
            const isOpen = open === i;
            return (
              <div key={f.q} className="lp-ov-acc-item" data-open={isOpen ? '' : undefined} data-rv>
                <h3>
                  <button type="button" aria-expanded={isOpen} aria-controls={`faq-a-${i}`} onClick={() => setOpen(isOpen ? -1 : i)}>
                    {f.q}
                    <Plus />
                  </button>
                </h3>
                <div id={`faq-a-${i}`} className="lp-ov-fold" role="region" aria-label={f.q}>
                  <div>
                    <p>{f.a}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
