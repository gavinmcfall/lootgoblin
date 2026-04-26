/**
 * Unit tests for the EXIF classifier provider — V2-002-T6
 *
 * Uses vi.mock('exifr') to stub the library, testing the provider's
 * behaviour given mocked EXIF data. This avoids committing binary image
 * fixtures with known EXIF data.
 *
 * Test scenarios:
 *   1. Artist field → creator 0.7.
 *   2. Creator field (XMP) → creator 0.7 (when Artist absent).
 *   3. Artist takes precedence over Creator.
 *   4. ImageDescription → description 0.5.
 *   5. Copyright → license 0.5.
 *   6. All fields present → all three emitted.
 *   7. No EXIF data returned → empty result.
 *   8. exifr.parse throws → empty result, no throw propagated.
 *   9. No image files in input → empty result (exifr not called).
 *   10. Multiple images — stops after finding first with data.
 *   11. Creator as string array → first element used.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClassifierInput } from '../../../src/stash/classifier';

// ---------------------------------------------------------------------------
// Mock exifr before importing the provider
// ---------------------------------------------------------------------------

const mockParse = vi.fn();

vi.mock('exifr', () => ({
  default: { parse: mockParse },
  parse: mockParse,
}));

// Import AFTER mocking.
const { createExifProvider } = await import('../../../src/stash/classifier-providers/exif');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(relativePaths: string[]): ClassifierInput {
  return {
    files: relativePaths.map((rp) => ({
      absolutePath: `/stash/${rp}`,
      relativePath: rp,
      size: 5000,
      mtime: new Date(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createExifProvider', () => {
  beforeEach(() => {
    mockParse.mockReset();
  });

  it('1. Artist field → creator 0.7', async () => {
    mockParse.mockResolvedValue({ Artist: 'Alice Sculptor' });

    const provider = createExifProvider();
    const result = await provider.classify(makeInput(['preview.jpg']));

    expect(result.creator).toEqual({ value: 'Alice Sculptor', confidence: 0.7 });
  });

  it('2. Creator XMP field → creator 0.7 when Artist absent', async () => {
    mockParse.mockResolvedValue({ Creator: 'Bob Maker' });

    const provider = createExifProvider();
    const result = await provider.classify(makeInput(['preview.jpg']));

    expect(result.creator).toEqual({ value: 'Bob Maker', confidence: 0.7 });
  });

  it('3. Artist takes precedence over Creator', async () => {
    mockParse.mockResolvedValue({ Artist: 'Alice', Creator: 'Bob' });

    const provider = createExifProvider();
    const result = await provider.classify(makeInput(['preview.jpg']));

    expect(result.creator?.value).toBe('Alice');
  });

  it('4. ImageDescription → description 0.5', async () => {
    mockParse.mockResolvedValue({ ImageDescription: 'A detailed dragon head' });

    const provider = createExifProvider();
    const result = await provider.classify(makeInput(['preview.jpeg']));

    expect(result.description).toEqual({
      value: 'A detailed dragon head',
      confidence: 0.5,
    });
  });

  it('5. Copyright → license 0.5', async () => {
    mockParse.mockResolvedValue({ Copyright: 'CC-BY-4.0 Alice 2024' });

    const provider = createExifProvider();
    const result = await provider.classify(makeInput(['preview.png']));

    expect(result.license).toEqual({ value: 'CC-BY-4.0 Alice 2024', confidence: 0.5 });
  });

  it('6. All fields present → all three emitted', async () => {
    mockParse.mockResolvedValue({
      Artist: 'Alice',
      ImageDescription: 'Dragon head',
      Copyright: 'CC-BY-4.0',
    });

    const provider = createExifProvider();
    const result = await provider.classify(makeInput(['preview.tif']));

    expect(result.creator?.value).toBe('Alice');
    expect(result.description?.value).toBe('Dragon head');
    expect(result.license?.value).toBe('CC-BY-4.0');
  });

  it('7. No EXIF data returned (null) → empty result', async () => {
    mockParse.mockResolvedValue(null);

    const provider = createExifProvider();
    const result = await provider.classify(makeInput(['preview.jpg']));

    expect(result).toEqual({});
  });

  it('8. exifr.parse throws → empty result, no throw propagated', async () => {
    mockParse.mockRejectedValue(new Error('EXIF parse failed'));

    const provider = createExifProvider();
    // Should not throw
    const result = await provider.classify(makeInput(['preview.jpg']));
    expect(result).toEqual({});
  });

  it('9. No image files in input → empty result, parse not called', async () => {
    const provider = createExifProvider();
    const result = await provider.classify(makeInput(['model.stl', 'readme.md']));

    expect(mockParse).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('10. Multiple images — stops after first image with data', async () => {
    mockParse
      .mockResolvedValueOnce({ Artist: 'Alice' }) // first image has data
      .mockResolvedValueOnce({ Artist: 'Bob' }); // second image should not be reached

    const provider = createExifProvider();
    const result = await provider.classify(makeInput(['first.jpg', 'second.jpg']));

    // Only first image parsed.
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(result.creator?.value).toBe('Alice');
  });

  it('11. Creator as string array → first element used', async () => {
    mockParse.mockResolvedValue({ Creator: ['Alice', 'Bob'] });

    const provider = createExifProvider();
    const result = await provider.classify(makeInput(['preview.jpg']));

    expect(result.creator?.value).toBe('Alice');
  });

  it('12. TIFF extension also parsed', async () => {
    mockParse.mockResolvedValue({ Artist: 'Tiff Artist' });

    const provider = createExifProvider();
    const result = await provider.classify(makeInput(['render.tiff']));

    expect(result.creator?.value).toBe('Tiff Artist');
  });

  it('13. Non-image files mixed with images — only images parsed', async () => {
    mockParse.mockResolvedValue({ Artist: 'Alice' });

    const provider = createExifProvider();
    await provider.classify(makeInput(['model.stl', 'preview.jpg', 'readme.md']));

    // Only the jpg should be passed to parse.
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(mockParse).toHaveBeenCalledWith('/stash/preview.jpg', expect.any(Object));
  });

  it('14. Empty files → empty result', async () => {
    const provider = createExifProvider();
    const result = await provider.classify({ files: [] });
    expect(result).toEqual({});
    expect(mockParse).not.toHaveBeenCalled();
  });
});
