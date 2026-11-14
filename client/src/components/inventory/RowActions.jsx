import { Archive, ArchiveRestore, Eye, MoreHorizontal, PackagePlus, Pencil, Trash2 } from 'lucide-react';
import { Dropdown, MenuItem } from '../common/Dropdown';
import { IconButton } from '../common/ui';

/**
 * The per-medicine action menu: View, Edit, Add batch, and Delete or Archive.
 * A medicine with stock history can only be archived (and later restored); one that never had any is deleted.
 */
export default function RowActions({ m, onView, onAddBatch, onEdit, onRemove, onRestore }) {
  const archived = m.isActive === false;
  const hasHistory = m.batchCount > 0;
  return (
    <Dropdown
      width="w-52"
      label={`Actions for ${m.medicineName}`}
      trigger={({ toggle, props }) => (
        <IconButton label={`Actions for ${m.medicineName}`} {...props} onClick={toggle}>
          <MoreHorizontal className="h-4 w-4" />
        </IconButton>
      )}
    >
      {(close) => {
        const run = (fn) => () => {
          close();
          fn(m);
        };
        return (
          <div className="py-1">
            <MenuItem icon={Eye} onClick={run(onView)}>View details</MenuItem>
            <MenuItem icon={Pencil} onClick={run(onEdit)}>Edit</MenuItem>
            {!archived && <MenuItem icon={PackagePlus} onClick={run(onAddBatch)}>Add batch</MenuItem>}
            <div className="my-1 border-t border-line" />
            {archived ? (
              <MenuItem icon={ArchiveRestore} onClick={run(onRestore)}>Restore</MenuItem>
            ) : (
              <MenuItem icon={hasHistory ? Archive : Trash2} danger onClick={run(onRemove)}>
                {hasHistory ? 'Archive' : 'Delete'}
              </MenuItem>
            )}
          </div>
        );
      }}
    </Dropdown>
  );
}
