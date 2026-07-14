# PDF Utility Suite

A 100% client-side, local-first PDF (and file) utility suite. All operations happen in memory on `ArrayBuffer`s — there is no server upload and no network call involved, so document contents never leave the browser.

## Features

- **Merge** — combine multiple PDFs into a single document, preserving order.
- **Split** — extract pages from a PDF using a page-range string (e.g. `"1-3, 5, 7-10"`), producing one output file per comma-separated segment.
- **Delete / reorder pages** — keep only a specified set of pages, in a specified order.
- **Compress** — losslessly shrink PDFs, PNGs, JPEGs, and Word/Excel/PowerPoint documents (or any other file type) without any loss of quality. See [Compression](#compression) below.

Every operation validates its input and raises a typed error (`InvalidPdfError`, `PasswordRequiredError`, `InvalidPageRangeError`, `EmptyInputError`) so calling UI code can branch on the failure mode — e.g. prompting for a password — instead of crashing.

## Live demo

`demo/index.html` is a single self-contained HTML file — no build step, no server — with a UI for every operation above (Merge / Split / Keep pages / Compress). Open it directly in a browser:

```bash
open demo/index.html   # or just double-click it, or drag it into a browser tab
```

It embeds `pdf-lib` and `fflate` inline so it works fully offline. PDF, JPEG, zip/Office, and generic-file compression call the exact same logic as `src/compressionService.ts`; PNG compression uses the browser's own canvas encoder instead of the repo's Node-based `pngjs` path (see the note in the demo's footer). To publish it as a shareable link, serve `demo/index.html` as a static site (GitHub Pages, Netlify, Vercel, etc.) — it has no server-side dependencies.

## Compression

`src/compressionService.ts` provides lossless compression for any file type. For formats with a dedicated compressor, the output is a smaller file in the *same* format — directly openable with any normal viewer, with rendered content byte-for-byte identical to the original:

| Function | Format | How it stays lossless |
| --- | --- | --- |
| `compressPDF` | PDF | Re-packs internal objects into object streams (`pdf-lib`); page count, order, and rendered content are untouched. |
| `compressPNG` | PNG | Decodes to raw pixels and re-encodes with adaptive per-scanline filtering and maximum deflate effort (`pngjs`); pixel data is byte-identical. |
| `compressJPEG` | JPEG | Strips non-essential metadata segments (EXIF/XMP, comments) found before the first scan; the entropy-coded scan data that determines decoded pixels is copied verbatim, never re-parsed or re-encoded. |
| `compressZipContainer` / `compressDocx` | .docx / .xlsx / .pptx / .zip | Unzips and re-zips every entry at maximum compression level (`fflate`); no entry's decompressed bytes change. |
| `compressGeneric` / `decompressGeneric` | any file | Gzip compress/decompress pair for formats with no dedicated compressor. The output is a gzip blob, not a directly-openable file — call `decompressGeneric` to restore the original bytes. |
| `compressFile` | auto-detected | Sniffs the buffer's magic bytes (not the filename) and routes to the matching compressor above, falling back to `compressGeneric` for anything unrecognized. |

None of the format-specific compressors ever return a file larger than the input — if lossless re-encoding doesn't shrink it, the original bytes are returned unchanged.

> **Browser bundling note:** `compressPNG` depends on `pngjs`, which relies on Node's built-in `zlib`/`Buffer`. If you bundle this module for a browser target, configure your bundler to polyfill `zlib` (e.g. a pako-backed shim) or the PNG path won't run in-browser without one.

## Getting started

```bash
npm install
npm run verify   # type-check + run the test suite
```

### Scripts

| Script | Description |
| --- | --- |
| `npm run test` | Run the test suite once (vitest) |
| `npm run test:watch` | Run the test suite in watch mode |
| `npm run typecheck` | Type-check the project with `tsc --noEmit` |
| `npm run verify` | Type-check and run the full test suite |
| `npm run prepare-hooks` | Symlink `scripts/pre-commit.sh` as a local git pre-commit hook |

## Project structure

```
src/
  pdfService.ts               Core PDF operations (mergePDFs, splitPDF, deletePages, parsePageRanges)
  compressionService.ts       Lossless compression for PDF, PNG, JPEG, zip/Office docs, and any other file
  __tests__/
    pdfService.test.ts        Test suite for pdfService
    compressionService.test.ts Test suite for compressionService
scripts/
  pre-commit.sh           Local pre-commit hook: type-check + test suite
.github/workflows/ci.yml  CI: type-check, test, and dependency audit on push/PR
```

## Security notes

- No file contents are ever logged in full — only metadata such as byte length or page count, to avoid leaking potentially sensitive document content.
- All inputs are validated before being handed to `pdf-lib`.
- No API keys, credentials, or server endpoints are involved (see `.env.example`).

## Tech stack

- [pdf-lib](https://pdf-lib.js.org/) for PDF manipulation
- [pngjs](https://github.com/lukeapage/pngjs) for PNG decoding/re-encoding
- [fflate](https://github.com/101arrowz/fflate) for zip/Office document (re)compression
- TypeScript (strict mode)
- [vitest](https://vitest.dev/) for testing
