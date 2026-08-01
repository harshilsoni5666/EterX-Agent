export default function Loading() {
  return (
    <div className="eterx-app-loader" aria-label="Loading EterX">
      <div className="eterx-app-loader-lockup" aria-hidden="true">
        <div className="eterx-app-loader-logo-shell">
          <img src="/logo-black.png" alt="" className="eterx-app-loader-logo dark:hidden" />
          <img src="/logo-white.png" alt="" className="eterx-app-loader-logo hidden dark:block" />
        </div>
        <div className="eterx-app-loader-wordmark">
          <span data-text="EterX">EterX</span>
        </div>
      </div>
    </div>
  );
}
