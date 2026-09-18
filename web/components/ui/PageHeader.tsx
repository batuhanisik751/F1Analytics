// Top-of-page header: title, optional subtitle/meta line, right-side actions.
export type PageHeaderProps = {
  title: React.ReactNode;
  /** Muted line under the title (official name, season summary...). */
  subtitle?: React.ReactNode;
  /** Small line of facts (date · location · laps); rendered under the subtitle. */
  meta?: React.ReactNode;
  /** Right-aligned controls (SeasonSwitcher, prev/next links, badges). */
  actions?: React.ReactNode;
  /** Free content below the header block (podium chips, stat tiles...). */
  children?: React.ReactNode;
  className?: string;
};

export default function PageHeader({
  title,
  subtitle,
  meta,
  actions,
  children,
  className,
}: PageHeaderProps): React.JSX.Element {
  return (
    <div className={`mb-8 ${className ?? ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-black uppercase leading-none tracking-tight text-fg sm:text-[2.75rem]">{title}</h1>
          {subtitle ? <p className="mt-1 text-base text-muted">{subtitle}</p> : null}
          {meta ? <p className="mt-1 text-sm text-muted">{meta}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}
