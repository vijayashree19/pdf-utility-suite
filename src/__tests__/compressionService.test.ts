import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { PNG } from 'pngjs';
import { zipSync, unzipSync } from 'fflate';
import { encode as encodeJpeg } from 'jpeg-js';
import {
  compressGeneric,
  decompressGeneric,
  compressPDF,
  compressPNG,
  compressJPEG,
  compressZipContainer,
  compressDocx,
  compressFile,
  detectFileType,
  EmptyBufferError,
  CorruptFileError,
} from '../compressionService';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// ---------------------------------------------------------------------------
// detectFileType
// ---------------------------------------------------------------------------

describe('detectFileType', () => {
  it('detects pdf, png, jpeg, and zip from magic bytes', () => {
    expect(detectFileType(new TextEncoder().encode('%PDF-1.7 rest').buffer as ArrayBuffer)).toBe('pdf');
    expect(
      detectFileType(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2).buffer as ArrayBuffer)
    ).toBe('png');
    expect(detectFileType(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2).buffer as ArrayBuffer)).toBe('jpeg');
    expect(detectFileType(Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 1, 2).buffer as ArrayBuffer)).toBe('zip');
  });

  it('returns unknown for unrecognized bytes', () => {
    expect(detectFileType(new TextEncoder().encode('just plain text').buffer as ArrayBuffer)).toBe('unknown');
  });

  it('throws EmptyBufferError for an empty buffer', () => {
    expect(() => detectFileType(new ArrayBuffer(0))).toThrow(EmptyBufferError);
  });
});

// ---------------------------------------------------------------------------
// compressGeneric / decompressGeneric
// ---------------------------------------------------------------------------

describe('compressGeneric / decompressGeneric', () => {
  it('round-trips arbitrary bytes losslessly', async () => {
    const original = new TextEncoder().encode('hello world '.repeat(500));
    const compressed = await compressGeneric(toArrayBuffer(original));
    expect(compressed.byteLength).toBeLessThan(original.byteLength);

    const decompressed = await decompressGeneric(toArrayBuffer(compressed));
    expect(decompressed).toEqual(original);
  });

  it('throws EmptyBufferError for empty input on both functions', async () => {
    await expect(compressGeneric(new ArrayBuffer(0))).rejects.toThrow(EmptyBufferError);
    await expect(decompressGeneric(new ArrayBuffer(0))).rejects.toThrow(EmptyBufferError);
  });

  it('throws CorruptFileError when decompressing non-gzip data', async () => {
    const garbage = new TextEncoder().encode('not gzip data').buffer as ArrayBuffer;
    await expect(decompressGeneric(garbage)).rejects.toThrow(CorruptFileError);
  });
});

// ---------------------------------------------------------------------------
// compressPDF
// ---------------------------------------------------------------------------

describe('compressPDF', () => {
  async function createUnoptimizedTestPdf(pageCount: number): Promise<ArrayBuffer> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pageCount; i++) {
      const page = doc.addPage([300, 300]);
      page.drawText(`Page ${i + 1} `.repeat(20), { x: 10, y: 150, size: 12 });
    }
    // useObjectStreams: false produces a deliberately larger, unoptimized PDF.
    const bytes = await doc.save({ useObjectStreams: false });
    return toArrayBuffer(bytes);
  }

  it('shrinks an unoptimized PDF while preserving page count', async () => {
    const original = await createUnoptimizedTestPdf(5);
    const compressed = await compressPDF(original);

    expect(compressed.byteLength).toBeLessThanOrEqual(original.byteLength);
    expect(compressed.byteLength).toBeLessThan(original.byteLength);

    const reloaded = await PDFDocument.load(compressed);
    expect(reloaded.getPageCount()).toBe(5);
  });

  it('never returns a file larger than the input', async () => {
    const original = await createUnoptimizedTestPdf(1);
    const compressed = await compressPDF(original);
    expect(compressed.byteLength).toBeLessThanOrEqual(original.byteLength);
  });

  it('throws EmptyBufferError for an empty buffer', async () => {
    await expect(compressPDF(new ArrayBuffer(0))).rejects.toThrow(EmptyBufferError);
  });

  it('throws CorruptFileError for non-PDF data', async () => {
    const garbage = new TextEncoder().encode('this is not a pdf').buffer as ArrayBuffer;
    await expect(compressPDF(garbage)).rejects.toThrow(CorruptFileError);
  });
});

// ---------------------------------------------------------------------------
// compressPNG
// ---------------------------------------------------------------------------

describe('compressPNG', () => {
  function createUnoptimizedTestPng(size: number): Uint8Array {
    const png = new PNG({ width: size, height: size });
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (size * y + x) << 2;
        // A gradient pattern gives the deflate/filter optimizer real work to do.
        png.data[idx] = (x * 7) % 256;
        png.data[idx + 1] = (y * 13) % 256;
        png.data[idx + 2] = (x + y) % 256;
        png.data[idx + 3] = 255;
      }
    }
    // Weak deflate + fixed filter type = deliberately unoptimized baseline.
    return PNG.sync.write(png, { deflateLevel: 1, filterType: 0 });
  }

  it('shrinks a PNG while preserving pixel data exactly', () => {
    const original = createUnoptimizedTestPng(40);
    const compressed = compressPNG(toArrayBuffer(original));

    expect(compressed.byteLength).toBeLessThanOrEqual(original.byteLength);

    const originalPixels = PNG.sync.read(Buffer.from(original));
    const compressedPixels = PNG.sync.read(Buffer.from(compressed));
    expect(Buffer.from(compressedPixels.data)).toEqual(Buffer.from(originalPixels.data));
    expect(compressedPixels.width).toBe(originalPixels.width);
    expect(compressedPixels.height).toBe(originalPixels.height);
  });

  it('throws EmptyBufferError for an empty buffer', () => {
    expect(() => compressPNG(new ArrayBuffer(0))).toThrow(EmptyBufferError);
  });

  it('throws CorruptFileError for non-PNG data', () => {
    const garbage = new TextEncoder().encode('this is not a png').buffer as ArrayBuffer;
    expect(() => compressPNG(garbage)).toThrow(CorruptFileError);
  });
});

// ---------------------------------------------------------------------------
// compressJPEG
// ---------------------------------------------------------------------------

describe('compressJPEG', () => {
  function createCleanTestJpeg(size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (i * 3) % 256;
      data[i + 1] = (i * 5) % 256;
      data[i + 2] = (i * 7) % 256;
      data[i + 3] = 255;
    }
    const { data: jpegBytes } = encodeJpeg({ data, width: size, height: size }, 90);
    return new Uint8Array(jpegBytes);
  }

  /** Splices a fake EXIF (APP1) and comment (COM) segment right after SOI. */
  function withFakeMetadata(jpeg: Uint8Array): Uint8Array {
    const exifPayload = new TextEncoder().encode('Exif\0\0FAKE-EXIF-PAYLOAD-'.repeat(10));
    const exifSegment = new Uint8Array(4 + exifPayload.length);
    exifSegment.set([0xff, 0xe1, (exifSegment.length - 2) >> 8, (exifSegment.length - 2) & 0xff], 0);
    exifSegment.set(exifPayload, 4);

    const comPayload = new TextEncoder().encode('a fake comment for testing');
    const comSegment = new Uint8Array(4 + comPayload.length);
    comSegment.set([0xff, 0xfe, (comSegment.length - 2) >> 8, (comSegment.length - 2) & 0xff], 0);
    comSegment.set(comPayload, 4);

    const result = new Uint8Array(2 + exifSegment.length + comSegment.length + (jpeg.length - 2));
    result.set([0xff, 0xd8], 0);
    result.set(exifSegment, 2);
    result.set(comSegment, 2 + exifSegment.length);
    result.set(jpeg.subarray(2), 2 + exifSegment.length + comSegment.length);
    return result;
  }

  function sosOffset(bytes: Uint8Array): number {
    for (let i = 2; i < bytes.length - 1; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xda) return i;
    }
    throw new Error('SOS marker not found in test fixture');
  }

  it('strips injected EXIF/comment metadata without touching scan data', () => {
    const clean = createCleanTestJpeg(16);
    const withMetadata = withFakeMetadata(clean);

    const compressed = compressJPEG(toArrayBuffer(withMetadata));

    expect(compressed.byteLength).toBeLessThan(withMetadata.byteLength);

    const compressedText = Buffer.from(compressed).toString('latin1');
    expect(compressedText).not.toContain('FAKE-EXIF-PAYLOAD');
    expect(compressedText).not.toContain('a fake comment for testing');

    // Entropy-coded scan data (from SOS to EOI) must be byte-identical.
    const originalScan = withMetadata.subarray(sosOffset(withMetadata));
    const compressedScan = compressed.subarray(sosOffset(compressed));
    expect(compressedScan).toEqual(originalScan);
  });

  it('leaves an already-clean JPEG unchanged in size (no smaller, no larger)', () => {
    const clean = createCleanTestJpeg(16);
    const compressed = compressJPEG(toArrayBuffer(clean));
    expect(compressed.byteLength).toBeLessThanOrEqual(clean.byteLength);
    expect(compressed).toEqual(clean);
  });

  it('throws EmptyBufferError for an empty buffer', () => {
    expect(() => compressJPEG(new ArrayBuffer(0))).toThrow(EmptyBufferError);
  });

  it('throws CorruptFileError for non-JPEG data', () => {
    const garbage = new TextEncoder().encode('this is not a jpeg').buffer as ArrayBuffer;
    expect(() => compressJPEG(garbage)).toThrow(CorruptFileError);
  });
});

// ---------------------------------------------------------------------------
// compressZipContainer / compressDocx
// ---------------------------------------------------------------------------

describe('compressZipContainer / compressDocx', () => {
  function createUnoptimizedDocx(): Uint8Array {
    const documentXml = new TextEncoder().encode(
      '<w:document>' + '<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>'.repeat(200) + '</w:document>'
    );
    const contentTypes = new TextEncoder().encode('<?xml version="1.0"?><Types></Types>');

    return zipSync(
      {
        '[Content_Types].xml': contentTypes,
        'word/document.xml': documentXml,
      },
      { level: 0 } // stored, uncompressed baseline
    );
  }

  it('shrinks a zip container while preserving every entry byte-for-byte', () => {
    const original = createUnoptimizedDocx();
    const compressed = compressZipContainer(toArrayBuffer(original));

    expect(compressed.byteLength).toBeLessThan(original.byteLength);

    const originalEntries = unzipSync(original);
    const compressedEntries = unzipSync(compressed);

    expect(Object.keys(compressedEntries).sort()).toEqual(Object.keys(originalEntries).sort());
    for (const name of Object.keys(originalEntries)) {
      expect(compressedEntries[name]).toEqual(originalEntries[name]);
    }
  });

  it('exposes compressDocx as an alias', () => {
    expect(compressDocx).toBe(compressZipContainer);
  });

  it('throws EmptyBufferError for an empty buffer', () => {
    expect(() => compressZipContainer(new ArrayBuffer(0))).toThrow(EmptyBufferError);
  });

  it('throws CorruptFileError for non-zip data', () => {
    const garbage = new TextEncoder().encode('this is not a zip').buffer as ArrayBuffer;
    expect(() => compressZipContainer(garbage)).toThrow(CorruptFileError);
  });
});

// ---------------------------------------------------------------------------
// compressFile dispatcher
// ---------------------------------------------------------------------------

describe('compressFile', () => {
  it('routes a PDF buffer through compressPDF', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    const pdfBytes = await doc.save({ useObjectStreams: false });

    const viaDispatcher = await compressFile(toArrayBuffer(pdfBytes));
    const viaDirect = await compressPDF(toArrayBuffer(pdfBytes));
    expect(viaDispatcher).toEqual(viaDirect);
  });

  it('falls back to compressGeneric (gzip) for unrecognized formats', async () => {
    const original = new TextEncoder().encode('plain text file contents '.repeat(50));
    const compressed = await compressFile(toArrayBuffer(original));

    expect(compressed.byteLength).toBeLessThan(original.byteLength);
    const decompressed = await decompressGeneric(toArrayBuffer(compressed));
    expect(decompressed).toEqual(original);
  });

  it('throws EmptyBufferError for an empty buffer', async () => {
    await expect(compressFile(new ArrayBuffer(0))).rejects.toThrow(EmptyBufferError);
  });
});
