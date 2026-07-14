/**
 * compressionService.ts
 *
 * 100% client-side, lossless file compression utilities. No network calls —
 * everything operates on ArrayBuffers already in memory.
 *
 * Every function here is lossless: for PDF, PNG, JPEG, and zip-based Office
 * documents (.docx/.xlsx/.pptx) the output is a smaller file in the *same*
 * format, directly openable with any normal viewer, with byte-for-byte
 * identical rendered content. `compressGeneric`/`compressFile`'s generic
 * fallback wraps arbitrary bytes in gzip so any file type can be shrunk, but
 * that output must be decompressed (via `decompressGeneric`) before it can
 * be opened as its original format again.
 *
 * Note on PNG support: `compressPNG` uses pngjs, which depends on Node's
 * built-in `zlib`/`Buffer`. When bundling this module for a browser target,
 * configure your bundler to polyfill `zlib` (e.g. a pako-backed shim) or the
 * PNG path will not run in-browser without one.
 */

import { PDFDocument } from 'pdf-lib';
import { PNG } from 'pngjs';
import { unzipSync, zipSync, type Unzipped } from 'fflate';

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Base class for all errors thrown by compressionService. */
export class CompressionServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompressionServiceError';
  }
}

/** Thrown when an input buffer is empty. */
export class EmptyBufferError extends CompressionServiceError {
  constructor(message = 'The provided file is empty.') {
    super(message);
    this.name = 'EmptyBufferError';
  }
}

/** Thrown when a file cannot be parsed as the format its compressor expects. */
export class CorruptFileError extends CompressionServiceError {
  constructor(message = 'The file could not be read; it may be corrupted or is not the expected format.') {
    super(message);
    this.name = 'CorruptFileError';
  }
}

// ---------------------------------------------------------------------------
// File type detection (magic-byte sniffing, not filename extension)
// ---------------------------------------------------------------------------

export type DetectedFileType = 'pdf' | 'png' | 'jpeg' | 'zip' | 'unknown';

/** Sniffs a buffer's format from its magic bytes. `'zip'` covers .zip as well as .docx/.xlsx/.pptx. */
export function detectFileType(buffer: ArrayBuffer): DetectedFileType {
  if (!buffer || buffer.byteLength === 0) {
    throw new EmptyBufferError();
  }

  const bytes = new Uint8Array(buffer);

  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'pdf'; // %PDF
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }

  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) {
    return 'zip';
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function pipeThroughStream(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream
): Promise<Uint8Array> {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  // lib.dom's CompressionStream/DecompressionStream types its `writable` side as
  // WritableStream<BufferSource>, which TS's pipeThrough overload resolution doesn't
  // accept as a ReadableWritablePair<..., Uint8Array> despite Uint8Array satisfying
  // BufferSource at runtime — cast through the pair type to sidestep the false mismatch.
  const chunks: Uint8Array[] = [];
  const reader = readable.pipeThrough(transform as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Returns whichever of `candidate`/`fallback` is smaller, for compressors whose output stays in the same format as the input. */
function smallerOf(candidate: Uint8Array, fallback: Uint8Array): Uint8Array {
  return candidate.byteLength < fallback.byteLength ? candidate : fallback;
}

// ---------------------------------------------------------------------------
// Generic lossless compression (any file type)
// ---------------------------------------------------------------------------

/**
 * Gzip-compresses an arbitrary buffer. Lossless for any file type, but the
 * output is a gzip blob, not a directly-openable file of the original
 * format — pair with `decompressGeneric` to get the original bytes back.
 *
 * @throws {EmptyBufferError} if `buffer` is empty.
 */
export async function compressGeneric(buffer: ArrayBuffer): Promise<Uint8Array> {
  if (!buffer || buffer.byteLength === 0) {
    throw new EmptyBufferError();
  }

  return pipeThroughStream(new Uint8Array(buffer), new CompressionStream('gzip'));
}

/**
 * Inverse of `compressGeneric`.
 *
 * @throws {EmptyBufferError} if `buffer` is empty.
 * @throws {CorruptFileError} if `buffer` is not valid gzip data.
 */
export async function decompressGeneric(buffer: ArrayBuffer): Promise<Uint8Array> {
  if (!buffer || buffer.byteLength === 0) {
    throw new EmptyBufferError();
  }

  try {
    return await pipeThroughStream(new Uint8Array(buffer), new DecompressionStream('gzip'));
  } catch (err) {
    throw new CorruptFileError(
      `The data is not valid gzip-compressed content (${err instanceof Error ? err.message : 'unknown error'}).`
    );
  }
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * Losslessly recompresses a PDF's internal object storage (cross-reference
 * and object streams). Rendered content, page count, and page order are
 * unchanged; only how the objects are packed on disk changes. Never returns
 * a file larger than the input.
 *
 * @throws {EmptyBufferError} if `buffer` is empty.
 * @throws {CorruptFileError} if the file is not a valid PDF.
 */
export async function compressPDF(buffer: ArrayBuffer): Promise<Uint8Array> {
  if (!buffer || buffer.byteLength === 0) {
    throw new EmptyBufferError('The provided PDF is empty.');
  }

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(buffer, { ignoreEncryption: false });
  } catch (err) {
    throw new CorruptFileError(
      `The file is not a valid PDF (${err instanceof Error ? err.message : 'unknown error'}).`
    );
  }

  const recompressed = await doc.save({ useObjectStreams: true });
  return smallerOf(recompressed, new Uint8Array(buffer));
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

/**
 * Losslessly re-encodes a PNG: decodes to raw pixels, then re-packs with
 * adaptive per-scanline filtering and maximum deflate effort. Pixel data is
 * byte-for-byte identical; only the compressed container size changes.
 * Never returns a file larger than the input.
 *
 * @throws {EmptyBufferError} if `buffer` is empty.
 * @throws {CorruptFileError} if the file is not a valid PNG.
 */
export function compressPNG(buffer: ArrayBuffer): Uint8Array {
  if (!buffer || buffer.byteLength === 0) {
    throw new EmptyBufferError('The provided image is empty.');
  }

  const bytes = new Uint8Array(buffer);

  let decoded: PNG;
  try {
    decoded = PNG.sync.read(Buffer.from(bytes));
  } catch (err) {
    throw new CorruptFileError(
      `The file is not a valid PNG (${err instanceof Error ? err.message : 'unknown error'}).`
    );
  }

  const recompressed = PNG.sync.write(decoded, {
    deflateLevel: 9,
    filterType: -1, // try all 5 filter types per scanline, keep the smallest
  });

  return smallerOf(recompressed, bytes);
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

/** Marker codes safe to drop without affecting decoded pixels: APP1 (EXIF/XMP) and COM (comments). */
const STRIPPABLE_JPEG_MARKERS = new Set([0xe1, 0xfe]);

/**
 * Losslessly shrinks a JPEG by stripping non-essential metadata segments
 * (EXIF/XMP, comments) found before the first scan. The entropy-coded scan
 * data — everything that determines decoded pixel values — is copied
 * verbatim and never parsed or re-encoded, so image quality is unaffected.
 * Never returns a file larger than the input.
 *
 * @throws {EmptyBufferError} if `buffer` is empty.
 * @throws {CorruptFileError} if the file is not a valid JPEG.
 */
export function compressJPEG(buffer: ArrayBuffer): Uint8Array {
  if (!buffer || buffer.byteLength === 0) {
    throw new EmptyBufferError('The provided image is empty.');
  }

  const bytes = new Uint8Array(buffer);

  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new CorruptFileError('The file is not a valid JPEG (missing SOI marker).');
  }

  const chunks: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  let offset = 2;
  let sawEoi = false;

  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      throw new CorruptFileError('The file is not a valid JPEG (malformed marker sequence).');
    }

    // Skip 0xFF fill/padding bytes to find the real marker code.
    let markerOffset = offset;
    while (bytes[markerOffset + 1] === 0xff) markerOffset++;
    const marker = bytes[markerOffset + 1]!;

    if (marker === 0xd9) {
      chunks.push(Uint8Array.of(0xff, 0xd9));
      sawEoi = true;
      break;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      // Standalone markers (TEM, restart markers) carry no length/payload.
      chunks.push(Uint8Array.of(0xff, marker));
      offset = markerOffset + 2;
      continue;
    }

    if (markerOffset + 3 >= bytes.length) {
      throw new CorruptFileError('The file is not a valid JPEG (truncated marker segment).');
    }
    const length = (bytes[markerOffset + 2]! << 8) | bytes[markerOffset + 3]!;
    const segmentEnd = markerOffset + 2 + length;

    if (marker === 0xda) {
      // Start of scan: copy the header and every remaining byte verbatim.
      // Entropy-coded data may contain byte-stuffed 0xFF00 and restart
      // markers, and progressive JPEGs interleave further scans/tables —
      // none of that is safe to parse, so we stop interpreting here.
      chunks.push(bytes.subarray(markerOffset));
      sawEoi = true;
      break;
    }

    if (!STRIPPABLE_JPEG_MARKERS.has(marker)) {
      chunks.push(bytes.subarray(markerOffset, segmentEnd));
    }

    offset = segmentEnd;
  }

  if (!sawEoi) {
    throw new CorruptFileError('The file is not a valid JPEG (missing end-of-image marker).');
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }

  return smallerOf(result, bytes);
}

// ---------------------------------------------------------------------------
// Zip-based documents (.docx / .xlsx / .pptx / .zip)
// ---------------------------------------------------------------------------

/**
 * Losslessly recompresses a zip container — including Word/Excel/PowerPoint
 * OOXML documents (.docx/.xlsx/.pptx), which are zip archives internally —
 * by unzipping and re-zipping every entry at maximum compression level. No
 * entry's decompressed bytes are modified. Never returns a file larger than
 * the input.
 *
 * @throws {EmptyBufferError} if `buffer` is empty.
 * @throws {CorruptFileError} if the file is not a valid zip archive.
 */
export function compressZipContainer(buffer: ArrayBuffer): Uint8Array {
  if (!buffer || buffer.byteLength === 0) {
    throw new EmptyBufferError('The provided document is empty.');
  }

  const bytes = new Uint8Array(buffer);

  let entries: Unzipped;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    throw new CorruptFileError(
      `The file is not a valid .docx/.xlsx/.pptx/.zip document (${err instanceof Error ? err.message : 'unknown error'}).`
    );
  }

  const recompressed = zipSync(entries, { level: 9 });
  return smallerOf(recompressed, bytes);
}

/** Alias of `compressZipContainer` for callers specifically compressing Word documents. */
export const compressDocx = compressZipContainer;

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Detects a buffer's format and routes it to the matching lossless
 * compressor. PDF, PNG, JPEG, and zip-based documents come back as a
 * smaller file in their original format. Anything else falls back to
 * `compressGeneric` (gzip) — decompress that result with `decompressGeneric`
 * before treating it as the original file again.
 *
 * @throws {EmptyBufferError} if `buffer` is empty.
 * @throws {CorruptFileError} if the sniffed format can't actually be parsed.
 */
export async function compressFile(buffer: ArrayBuffer): Promise<Uint8Array> {
  if (!buffer || buffer.byteLength === 0) {
    throw new EmptyBufferError();
  }

  switch (detectFileType(buffer)) {
    case 'pdf':
      return compressPDF(buffer);
    case 'png':
      return compressPNG(buffer);
    case 'jpeg':
      return compressJPEG(buffer);
    case 'zip':
      return compressZipContainer(buffer);
    default:
      return compressGeneric(buffer);
  }
}
