/**
 * pdfService.ts
 *
 * 100% client-side PDF manipulation utilities built on pdf-lib.
 * No network calls, no server upload — all processing happens on
 * ArrayBuffers already in the browser's memory.
 *
 * Security notes (per CLAUDE.md):
 * - No file contents are ever logged in full (only metadata like byte length,
 *   page count) to avoid leaking potentially sensitive document content.
 * - All inputs are validated before being handed to pdf-lib.
 * - Errors are typed so calling UI code can branch (e.g. prompt for a
 *   password) instead of the app crashing on a corrupted/protected file.
 */

import { PDFDocument, PDFPage } from 'pdf-lib';

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Base class for all errors thrown by pdfService. */
export class PdfServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfServiceError';
  }
}

/** Thrown when an input buffer is empty, not a PDF, or otherwise unreadable. */
export class InvalidPdfError extends PdfServiceError {
  constructor(message = 'The file could not be read as a valid PDF.') {
    super(message);
    this.name = 'InvalidPdfError';
  }
}

/** Thrown when a PDF is password-protected / encrypted and cannot be opened. */
export class PasswordRequiredError extends PdfServiceError {
  constructor(message = 'This PDF is password-protected. Please provide the password.') {
    super(message);
    this.name = 'PasswordRequiredError';
  }
}

/** Thrown when a page-range string or page index list is malformed or out of bounds. */
export class InvalidPageRangeError extends PdfServiceError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPageRangeError';
  }
}

/** Thrown when the caller provides no files / an empty input where at least one is required. */
export class EmptyInputError extends PdfServiceError {
  constructor(message = 'At least one file is required.') {
    super(message);
    this.name = 'EmptyInputError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Safely loads a PDFDocument from a raw ArrayBuffer, translating pdf-lib's
 * generic failures into typed, actionable errors.
 *
 * NOTE: pdf-lib cannot decrypt password-protected PDFs on its own — it can
 * only detect that a document is encrypted. True password-based decryption
 * would require a separate library (e.g. a WASM build of qpdf) and is
 * intentionally out of scope for this file. We surface PasswordRequiredError
 * so the calling UI can inform the user, rather than silently failing.
 */
async function loadPdfSafely(buffer: ArrayBuffer): Promise<PDFDocument> {
  if (!buffer || buffer.byteLength === 0) {
    throw new InvalidPdfError('The provided file is empty.');
  }

  try {
    // ignoreEncryption: false (default) — we want pdf-lib to tell us if it's encrypted.
    return await PDFDocument.load(buffer, { ignoreEncryption: false });
  } catch (err) {
    const message = err instanceof Error ? err.message.toLowerCase() : '';

    if (message.includes('encrypt')) {
      throw new PasswordRequiredError();
    }

    throw new InvalidPdfError(
      `The file appears to be corrupted or is not a valid PDF (${
        err instanceof Error ? err.message : 'unknown error'
      }).`
    );
  }
}

/**
 * Parses a human-entered page range string like "1-3, 5, 7-10" into an
 * array of groups, where each group is a list of 0-indexed page numbers
 * (one group per comma-separated segment, preserving the user's grouping
 * so splitPDF can emit one output file per segment).
 *
 * Validates that:
 * - The string is non-empty and well-formed (digits, hyphens, commas only).
 * - Every page number is within [1, totalPages].
 * - Ranges are not inverted (e.g. "5-2").
 */
export function parsePageRanges(pageRanges: string, totalPages: number): number[][] {
  if (!pageRanges || pageRanges.trim().length === 0) {
    throw new InvalidPageRangeError('Page range string must not be empty.');
  }

  const segments = pageRanges.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

  if (segments.length === 0) {
    throw new InvalidPageRangeError('Page range string must not be empty.');
  }

  const groups: number[][] = [];

  for (const segment of segments) {
    const rangeMatch = segment.match(/^(\d+)\s*-\s*(\d+)$/);
    const singleMatch = segment.match(/^(\d+)$/);

    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);

      if (start < 1 || end < 1) {
        throw new InvalidPageRangeError(`Page numbers must be 1 or greater in "${segment}".`);
      }
      if (start > end) {
        throw new InvalidPageRangeError(`Invalid range "${segment}": start page is after end page.`);
      }
      if (end > totalPages) {
        throw new InvalidPageRangeError(
          `Range "${segment}" exceeds the document's page count (${totalPages} pages).`
        );
      }

      const group: number[] = [];
      for (let p = start; p <= end; p++) group.push(p - 1); // 0-indexed for pdf-lib
      groups.push(group);
    } else if (singleMatch) {
      const page = Number(singleMatch[1]);

      if (page < 1) {
        throw new InvalidPageRangeError(`Page numbers must be 1 or greater in "${segment}".`);
      }
      if (page > totalPages) {
        throw new InvalidPageRangeError(
          `Page ${page} exceeds the document's page count (${totalPages} pages).`
        );
      }

      groups.push([page - 1]);
    } else {
      throw new InvalidPageRangeError(
        `Could not parse "${segment}". Expected a page number (e.g. "5") or range (e.g. "7-10").`
      );
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Combines multiple PDF ArrayBuffers into a single PDF, in the order given.
 *
 * @throws {EmptyInputError} if `files` is empty.
 * @throws {InvalidPdfError} if any file is empty/corrupted.
 * @throws {PasswordRequiredError} if any file is encrypted.
 */
export async function mergePDFs(files: ArrayBuffer[]): Promise<Uint8Array> {
  if (!files || files.length === 0) {
    throw new EmptyInputError('At least one PDF is required to merge.');
  }

  const mergedDoc = await PDFDocument.create();

  for (const fileBuffer of files) {
    const sourceDoc = await loadPdfSafely(fileBuffer);
    const pageIndices = sourceDoc.getPageIndices();
    const copiedPages: PDFPage[] = await mergedDoc.copyPages(sourceDoc, pageIndices);
    copiedPages.forEach((page) => mergedDoc.addPage(page));
  }

  return mergedDoc.save();
}

/**
 * Extracts pages from a PDF based on a page-range string (e.g. "1-3, 5, 7-10"),
 * producing one output PDF per comma-separated segment.
 *
 * @throws {InvalidPdfError} if the file is empty/corrupted.
 * @throws {PasswordRequiredError} if the file is encrypted.
 * @throws {InvalidPageRangeError} if the range string is malformed or out of bounds.
 */
export async function splitPDF(file: ArrayBuffer, pageRanges: string): Promise<Uint8Array[]> {
  const sourceDoc = await loadPdfSafely(file);
  const totalPages = sourceDoc.getPageCount();

  const groups = parsePageRanges(pageRanges, totalPages);

  const outputs: Uint8Array[] = [];

  for (const group of groups) {
    const newDoc = await PDFDocument.create();
    const copiedPages = await newDoc.copyPages(sourceDoc, group);
    copiedPages.forEach((page) => newDoc.addPage(page));
    outputs.push(await newDoc.save());
  }

  return outputs;
}

/**
 * Returns a new PDF containing only the given pages, in the order specified.
 *
 * @param pagesToKeep 1-indexed page numbers to retain, in desired output order.
 *
 * @throws {InvalidPdfError} if the file is empty/corrupted.
 * @throws {PasswordRequiredError} if the file is encrypted.
 * @throws {InvalidPageRangeError} if `pagesToKeep` is empty or contains out-of-range values.
 */
export async function deletePages(file: ArrayBuffer, pagesToKeep: number[]): Promise<Uint8Array> {
  const sourceDoc = await loadPdfSafely(file);
  const totalPages = sourceDoc.getPageCount();

  if (!pagesToKeep || pagesToKeep.length === 0) {
    throw new InvalidPageRangeError('At least one page must be kept.');
  }

  for (const page of pagesToKeep) {
    if (!Number.isInteger(page) || page < 1 || page > totalPages) {
      throw new InvalidPageRangeError(
        `Page ${page} is out of range for a document with ${totalPages} pages.`
      );
    }
  }

  const zeroIndexed = pagesToKeep.map((p) => p - 1);

  const newDoc = await PDFDocument.create();
  const copiedPages = await newDoc.copyPages(sourceDoc, zeroIndexed);
  copiedPages.forEach((page) => newDoc.addPage(page));

  return newDoc.save();
}
