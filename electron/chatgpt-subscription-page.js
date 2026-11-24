const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');

const styles = `
  :root {
    color-scheme: light dark;
    --page: #fff;
    --text: #171717;
    --muted: #595959;
    --tile: #f7f7f7;
    --border: #dedede;
    --dot: #a3a3a3;
    background: var(--page);
    color: var(--text);
    font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, Arial, sans-serif;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --page: #141414;
      --text: #f5f5f5;
      --muted: #b5b5b5;
      --tile: #222;
      --border: #3a3a3a;
      --dot: #737373;
    }

    .chatgpt img { filter: invert(1); }
  }

  body {
    box-sizing: border-box;
    display: grid;
    place-items: center;
    min-block-size: 100vh;
    min-block-size: 100svh;
    margin: 0;
    padding: clamp(1.5rem, 5vw, 4rem);
  }

  main {
    inline-size: min(100%, 46rem);
    text-align: center;
  }

  h1 {
    margin: 0;
    font-size: clamp(1.75rem, 5vw, 2.375rem);
    font-weight: 650;
    line-height: 1.18;
    letter-spacing: -.035em;
    text-wrap: balance;
  }

  .connection {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: clamp(.75rem, 3vw, 1.125rem);
    margin-block-start: 1.875rem;
  }

  .logo {
    box-sizing: border-box;
    display: grid;
    place-items: center;
    inline-size: clamp(3.375rem, 12vw, 4rem);
    aspect-ratio: 1;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 26%;
    background: var(--tile);
  }

  .logo img {
    display: block;
    inline-size: 100%;
    block-size: auto;
  }

  .chatgpt img { inline-size: 53%; }

  .dots { display: flex; gap: .4375rem; }

  .dots span {
    inline-size: .3125rem;
    block-size: .3125rem;
    border-radius: 50%;
    background: var(--dot);
  }

  p {
    max-inline-size: 44ch;
    margin: .875rem auto 0;
    color: var(--muted);
    font-size: 1.0625rem;
    line-height: 1.55;
    text-wrap: balance;
  }

  .close-note { margin-block-start: clamp(2.75rem, 7vh, 4.25rem); }
`;

const cleanCallbackUrl = "history.replaceState(null, '', '/auth/complete');";
const hash = content => `'sha256-${createHash('sha256').update(content).digest('base64')}'`;
const contentSecurityPolicy = [
  "default-src 'none'",
  `style-src ${hash(styles)}`,
  `script-src ${hash(cleanCallbackUrl)}`,
  'img-src data:',
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

function escapeText(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function renderConnection(chatGptLogoPath, eterxLogoPath) {
  try {
    const chatGptLogo = readFileSync(chatGptLogoPath, 'base64');
    const eterxLogo = readFileSync(eterxLogoPath, 'base64');
    return `
      <div class="connection" aria-hidden="true">
        <span class="logo chatgpt"><img src="data:image/svg+xml;base64,${chatGptLogo}" alt=""></span>
        <span class="dots"><span></span><span></span><span></span></span>
        <span class="logo"><img src="data:image/png;base64,${eterxLogo}" alt=""></span>
      </div>`;
  } catch {
    // An unavailable logo should not prevent showing the sign-in result.
    return '';
  }
}

function createChatGptCallbackPage({ chatGptLogoPath, eterxLogoPath } = {}) {
  let connection;

  return (response, { heading, detail, connected = false, status = 200 }) => {
    if (!response || response.destroyed || response.writableEnded) return;

    if (connected) connection ??= renderConnection(chatGptLogoPath, eterxLogoPath);
    const message = connected ? 'You can close this window now.' : detail;
    response.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'close',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': contentSecurityPolicy,
    }).end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>ChatGPT sign-in · EterX</title>
    <style>${styles}</style>
  </head>
  <body>
    <main>
      <h1>${escapeText(heading)}</h1>
      ${connected ? connection : ''}
      ${message ? `<p${connected ? ' class="close-note"' : ''}>${escapeText(message)}</p>` : ''}
    </main>
    <script>${cleanCallbackUrl}</script>
  </body>
</html>`);
  };
}

module.exports = { createChatGptCallbackPage };
