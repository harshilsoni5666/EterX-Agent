export default function Loading() {
  return (
    <div className="eterx-startup" role="status" aria-label="Starting EterX" aria-busy="true">
      <div className="eterx-startup-drag" aria-hidden="true" />
      <div className="eterx-startup-content" aria-hidden="true">
        <img src="/logo.png" alt="" draggable={false} className="eterx-startup-logo" />
        <h1 className="eterx-startup-title">Welcome to EterX</h1>
        <div className="eterx-startup-status">
          <span className="eterx-startup-spinner" />
          <span>Starting workspace</span>
        </div>
        <p className="eterx-startup-caption">Preparing your agent environment</p>
      </div>
    </div>
  );
}
