# Material Icon Theme

SVG assets are vendored from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme), revision `2ad292ecbdb54cc4d4901fa5a72091e90bc612ba`.

The upstream MIT license is retained in `LICENSE.txt`. EterX serves this selected subset locally; no icon CDN or runtime package is required. `folder.svg` is derived from the upstream `folder-base.svg`, with its base path in neutral grey and the decorative motive omitted. Other assets are unchanged.

Next.js and pnpm include the upstream light variants, selected through the application theme. File and folder associations are in `src/lib/workspace-file-icons.ts`.
