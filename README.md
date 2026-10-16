# PDF Viewer for Rigee

A [Rigee](https://github.com/Qyuan-Tech/rigee) plugin: PDFs open in a reader instead of the text
editor — continuous scrolling, selectable text, search, the document's outline, page thumbnails,
and the reading position kept when the editor is split. Rendered by [pdf.js](https://mozilla.github.io/pdf.js/).

## Installing

In Rigee, open the **Plugins** view, search for `pdf` and install **Qyuan-Tech/rigee-plugin-pdf**.
Rigee downloads the latest release, checks it against the checksum GitHub reports for it, and asks
before anything runs. It needs Rigee 1.1.0 or later.

What it declares: **read files on this computer** — the PDF being opened, read in Rigee's main
process and handed to the window. As with every Rigee plugin, that is a statement of what it is
for, not a limit Rigee enforces.

## How it is built

Two halves for one reason: the bytes can only be read in the main process, and they can only be
rendered in the window. The main half is a single bounded file read (256 MB at most); everything
else is the renderer half.

**pdf.js is not bundled.** `dist/pdfjs/` holds pdf.js's own release files byte for byte — the
library, its worker, the CMaps without which CJK text renders blank, the standard fonts, the colour
profiles and the WebAssembly decoders for JBIG2 and JPEG 2000, with their licences — so what runs
can be checked against what pdf.js published. The library is imported from there by URL the first
time a document loads. The worker is started through Rigee's `workerUrl`, because a window may only
start a worker from its own origin; that also leaves the worker free to compile WebAssembly, which
the window's own policy forbids.

```
src/protocol.ts           the one command the halves share, typed for both
src/main/index.ts         main half: one bounded read
src/renderer/index.tsx    renderer half: binds the editor, sweeps documents whose tabs closed
src/renderer/pdfjs.ts     where pdf.js and its files are
```

```bash
pnpm install
pnpm run typecheck
pnpm run build          # dist/main.js, dist/renderer.js and dist/pdfjs/
npm pack                # rigee-plugin-pdf-<version>.tgz, the release asset
```

To try a build in Rigee without publishing it, unpack the tarball's `package/` into
`<userData>/plugins/pdf/` and approve it in the Plugins view.

## Releasing

Set the same version in `version` and `rigee.version`, commit, and push a tag `v<version>`. The
release workflow checks the three agree, builds, packs, and publishes a release carrying
`rigee-plugin-pdf-<version>.tgz` — the one asset Rigee installs from.

## Licence

MIT. pdf.js, in `dist/pdfjs/`, is Apache-2.0; the WebAssembly decoders carry their own licences
beside them.
