import { Pill } from './ShowcaseParts';
import ShowcaseSidebar from './ShowcaseSidebar';

/**
 * The desktop application window: browser bar, sidebar and a content area. The five scenes are children and are
 * stacked on top of each other by the parent; the frame itself never changes while they cross-fade.
 * `inert` removes the whole preview from the tab order, so none of the mock UI can trap keyboard focus.
 */
export default function ShowcaseFrame({ active, children }) {
  return (
    <div className="showcase-frame" inert aria-hidden="true">
      <div className="flex h-9 items-center gap-3 border-b border-line bg-subtle px-3">
        <span className="flex gap-1.5">
          {[0, 1, 2].map((i) => <span key={i} className="h-2.5 w-2.5 rounded-full bg-line" />)}
        </span>
        <span className="mx-auto flex h-5 w-72 items-center justify-center rounded-md bg-card text-[10.5px] text-muted">Usha Pharmacy · Sample workspace</span>
        <Pill tone="info">Illustrative data</Pill>
      </div>
      <div className="flex min-h-0 flex-1">
        <ShowcaseSidebar active={active} />
        <div className="showcase-scenes bg-app">{children}</div>
      </div>
    </div>
  );
}
