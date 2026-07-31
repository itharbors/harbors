interface StatusViewProps {
  title: string;
  detail: string;
  action?: string;
  onAction?(): void;
}

export function StatusView({ title, detail, action, onAction }: StatusViewProps) {
  return (
    <section className="status-view" role="status">
      <span className="status-view__mark" aria-hidden="true">⌁</span>
      <h2>{title}</h2>
      <p>{detail}</p>
      {action && onAction ? <button type="button" onClick={onAction}>{action}</button> : null}
    </section>
  );
}
