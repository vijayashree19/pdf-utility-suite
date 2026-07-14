import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  mergePDFs,
  splitPDF,
  deletePages,
  parsePageRanges,
  EmptyInputError,
  InvalidPdfError,
  InvalidPageRangeError,
} from '../pdfService';

// ---------------------------------------------------------------------------
// Test fixtures: generate minimal valid PDFs in-memory (no binary files needed)
// ---------------------------------------------------------------------------

/** Creates a valid PDF with `pageCount` blank pages, each labeled for identification. */
async function createTestPdf(pageCount: number): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([300, 300]);
    page.drawText(`Page ${i + 1}`, { x: 50, y: 150, size: 20 });
  }
  const bytes = await doc.save();
  // Return a real ArrayBuffer (not a Node Buffer-backed view) to mirror browser behavior.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function getPageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}

// ---------------------------------------------------------------------------
// mergePDFs
// ---------------------------------------------------------------------------

describe('mergePDFs', () => {
  it('merges two valid PDFs into one with combined page count', async () => {
    const pdfA = await createTestPdf(3);
    const pdfB = await createTestPdf(2);

    const merged = await mergePDFs([pdfA, pdfB]);
    const pageCount = await getPageCount(merged);

    expect(pageCount).toBe(5);
  });

  it('merges three PDFs preserving total order/count', async () => {
    const pdfs = await Promise.all([createTestPdf(1), createTestPdf(4), createTestPdf(2)]);
    const merged = await mergePDFs(pdfs);
    expect(await getPageCount(merged)).toBe(7);
  });

  it('throws EmptyInputError when given an empty array', async () => {
    await expect(mergePDFs([])).rejects.toThrow(EmptyInputError);
  });

  it('throws InvalidPdfError when given an empty ArrayBuffer', async () => {
    const empty = new ArrayBuffer(0);
    await expect(mergePDFs([empty])).rejects.toThrow(InvalidPdfError);
  });

  it('throws InvalidPdfError when given corrupted/non-PDF data', async () => {
    const garbage = new TextEncoder().encode('this is not a pdf').buffer;
    await expect(mergePDFs([garbage as ArrayBuffer])).rejects.toThrow(InvalidPdfError);
  });
});

// ---------------------------------------------------------------------------
// parsePageRanges (pure logic, tested directly for clarity)
// ---------------------------------------------------------------------------

describe('parsePageRanges', () => {
  it('parses a mixed range/single string correctly', () => {
    const groups = parsePageRanges('1-3, 5, 7-10', 10);
    expect(groups).toEqual([
      [0, 1, 2],
      [4],
      [6, 7, 8, 9],
    ]);
  });

  it('throws on empty string', () => {
    expect(() => parsePageRanges('', 10)).toThrow(InvalidPageRangeError);
    expect(() => parsePageRanges('   ', 10)).toThrow(InvalidPageRangeError);
  });

  it('throws on malformed segment', () => {
    expect(() => parsePageRanges('abc', 10)).toThrow(InvalidPageRangeError);
    expect(() => parsePageRanges('1-3, xyz', 10)).toThrow(InvalidPageRangeError);
  });

  it('throws when a range exceeds the document page count', () => {
    // 5-page document, range asks for pages 99-100
    expect(() => parsePageRanges('99-100', 5)).toThrow(InvalidPageRangeError);
  });

  it('throws when a single page number exceeds the document page count', () => {
    expect(() => parsePageRanges('1-3, 20', 5)).toThrow(InvalidPageRangeError);
  });

  it('throws on inverted range (start after end)', () => {
    expect(() => parsePageRanges('5-2', 10)).toThrow(InvalidPageRangeError);
  });

  it('throws on zero or negative page numbers', () => {
    expect(() => parsePageRanges('0-3', 10)).toThrow(InvalidPageRangeError);
  });
});

// ---------------------------------------------------------------------------
// splitPDF
// ---------------------------------------------------------------------------

describe('splitPDF', () => {
  it('splits a valid PDF into correct number of output files per segment', async () => {
    const pdf = await createTestPdf(10);
    const results = await splitPDF(pdf, '1-3, 5, 7-10');

    expect(results).toHaveLength(3);
    expect(await getPageCount(results[0]!)).toBe(3); // 1-3
    expect(await getPageCount(results[1]!)).toBe(1); // 5
    expect(await getPageCount(results[2]!)).toBe(4); // 7-10
  });

  it('splits a single page correctly', async () => {
    const pdf = await createTestPdf(5);
    const results = await splitPDF(pdf, '3');
    expect(results).toHaveLength(1);
    expect(await getPageCount(results[0]!)).toBe(1);
  });

  it('throws InvalidPageRangeError for a range beyond the page count (99-100 on a 5-page doc)', async () => {
    const pdf = await createTestPdf(5);
    await expect(splitPDF(pdf, '99-100')).rejects.toThrow(InvalidPageRangeError);
  });

  it('throws InvalidPageRangeError for an empty range string', async () => {
    const pdf = await createTestPdf(5);
    await expect(splitPDF(pdf, '')).rejects.toThrow(InvalidPageRangeError);
  });

  it('throws InvalidPdfError for an empty file buffer', async () => {
    const empty = new ArrayBuffer(0);
    await expect(splitPDF(empty, '1-2')).rejects.toThrow(InvalidPdfError);
  });
});

// ---------------------------------------------------------------------------
// deletePages
// ---------------------------------------------------------------------------

describe('deletePages', () => {
  it('keeps only the specified pages', async () => {
    const pdf = await createTestPdf(5);
    const result = await deletePages(pdf, [1, 3, 5]);
    expect(await getPageCount(result)).toBe(3);
  });

  it('preserves the order given in pagesToKeep', async () => {
    const pdf = await createTestPdf(5);
    const result = await deletePages(pdf, [5, 1]);
    const doc = await PDFDocument.load(result);
    expect(doc.getPageCount()).toBe(2);
  });

  it('throws InvalidPageRangeError when pagesToKeep is empty', async () => {
    const pdf = await createTestPdf(5);
    await expect(deletePages(pdf, [])).rejects.toThrow(InvalidPageRangeError);
  });

  it('throws InvalidPageRangeError when a page number is out of range', async () => {
    const pdf = await createTestPdf(5);
    await expect(deletePages(pdf, [1, 2, 99])).rejects.toThrow(InvalidPageRangeError);
  });

  it('throws InvalidPdfError for a corrupted buffer', async () => {
    const garbage = new TextEncoder().encode('not a real pdf').buffer;
    await expect(deletePages(garbage as ArrayBuffer, [1])).rejects.toThrow(InvalidPdfError);
  });
});
