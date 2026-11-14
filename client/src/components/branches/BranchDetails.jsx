import { Pencil } from 'lucide-react';
import { addressText } from '../../utils/branchForm';
import { dateFmt, dateTimeFmt } from '../../utils/format';
import { Badge, Button, Modal } from '../common/ui';

const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);

function Row({ label, children }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 text-sm sm:flex-row sm:gap-4">
      <dt className="w-44 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 break-words font-medium">{children}</dd>
    </div>
  );
}

/** Everything about one branch, read-only, with an Edit button for people who may manage branches. */
export default function BranchDetails({ branch: b, canEdit, onEdit, onClose }) {
  return (
    <Modal
      title={b.name}
      description={`Branch code ${b.code}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {canEdit && (
            <Button variant="accent" onClick={() => onEdit(b)}>
              <Pencil className="h-4 w-4" aria-hidden="true" /> Edit
            </Button>
          )}
        </>
      }
    >
      <dl className="divide-y divide-line" aria-label="Branch details">
        <Row label="Branch name">{b.name}</Row>
        <Row label="Branch code">{b.code}</Row>
        <Row label="Contact information">
          <div>{dash(b.phone)}</div>
          <div className="text-muted">{dash(b.email)}</div>
        </Row>
        <Row label="Address">{dash(addressText(b))}</Row>
        <Row label="Branch manager">{dash(b.managerName)}</Row>
        <Row label="GSTIN">{dash(b.gstin)}</Row>
        <Row label="Opening date">{b.openingDate ? dateFmt(b.openingDate) : '—'}</Row>
        <Row label="Status">
          <Badge tone={b.status === 'active' ? 'success' : 'neutral'} dot>
            {b.status === 'active' ? 'Active' : 'Inactive'}
          </Badge>
          {b.isDefault && (
            <span className="ml-2">
              <Badge tone="info">Default</Badge>
            </span>
          )}
        </Row>
        {b.notes && <Row label="Notes">{b.notes}</Row>}
        <Row label="Stock held">
          {b.batchCount ?? 0} batch{b.batchCount === 1 ? '' : 'es'} · {b.unitsOnHand ?? 0} units · {b.openTransfers ?? 0} open transfer{b.openTransfers === 1 ? '' : 's'}
        </Row>
        <Row label="Purchase orders and staff">
          {b.orderCount ?? 0} purchase order{b.orderCount === 1 ? '' : 's'} {'·'} {b.staffCount ?? 0} staff assigned
        </Row>
        <Row label="Created">
          {b.createdAt ? dateTimeFmt(b.createdAt) : '—'}
          {b.createdByName ? ` by ${b.createdByName}` : ''}
        </Row>
        <Row label="Last updated">
          {b.updatedAt ? dateTimeFmt(b.updatedAt) : '—'}
          {b.updatedByName ? ` by ${b.updatedByName}` : ''}
        </Row>
      </dl>
    </Modal>
  );
}
