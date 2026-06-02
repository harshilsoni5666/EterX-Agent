export default function Loading() {
  return (
    <div
      aria-hidden="true"
      className="fixed inset-0"
      style={{
        background: 'var(--eterx-settings-shell-bg, #151515)',
        color: 'var(--eterx-settings-shell-fg, #F4F4F4)',
      }}
    />
  );
}
