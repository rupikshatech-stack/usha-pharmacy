import { Card, cx } from '../common/ui';

export default function ChartCard({ title, subtitle, right, children, className }) {
  return (
    <Card className={cx('p-5', className)}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-bold">{title}</h2>
          <p className="text-xs text-muted">{subtitle}</p>
        </div>
        {right}
      </div>
      {children}
    </Card>
  );
}
