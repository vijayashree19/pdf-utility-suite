# PDF Utility Suite

A 100% client-side, local-first PDF utility suite built with [pdf-lib](https://pdf-lib.js.org/). All PDF manipulation happens in memory on `ArrayBuffer`s — there is no server upload and no network call involved, so document contents never leave the browser.

## Features

- **Merge** — combine multiple PDFs into a single document, preserving order.
- **Split** — extract pages from a PDF using a page-range string (e.g. `"1-3, 5, 7-10"`), producing one output file per comma-separated segment.
- **Delete / reorder pages** — keep only a specified set of pages, in a specified order.

Every operation validates its input and raises a typed error (`InvalidPdfError`, `PasswordRequiredError`, `InvalidPageRangeError`, `EmptyInputError`) so calling UI code can branch on the failure mode — e.g. prompting for a password — instead of crashing.

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
  pdfService.ts           Core PDF operations (mergePDFs, splitPDF, deletePages, parsePageRanges)
  __tests__/
    pdfService.test.ts    Test suite
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
- TypeScript (strict mode)
- [vitest](https://vitest.dev/) for testing
