export default function Loading() {
  return (
    <div className="eterx-app-loader" aria-label="Loading EterX">
      <div className="eterx-app-loader-lockup" aria-hidden="true">
        <div className="eterx-app-loader-logo-shell">
          <img src="/logo.png" alt="" className="eterx-app-loader-logo" />
        </div>
        <div className="eterx-app-loader-wordmark">
          <span data-text="EterX">EterX</span>
        </div>
      </div>
    </div>
  );
}
