import { describe, expect, it } from 'vitest';
import {
	COVER_ASPECT,
	COVER_MAX_BYTES,
	COVER_MIN_WIDTH,
	coverContentType,
	coverObjectPath,
	readImageHeader,
	validateCover
} from './cover.js';

/**
 * Cover validation (spec #19 §2). Headers are built inline as byte arrays: the module takes a
 * `Uint8Array` precisely so its spec needs no fixture files, no filesystem and no image
 * library — the same reason the module itself is pure.
 */

const SLUG = 'pride-and-prejudice';

/** A PNG: the 8-byte signature, then an IHDR chunk carrying width and height. */
function png(width: number, height: number, padding = 0): Uint8Array {
	const bytes = new Uint8Array(24 + padding);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	// IHDR length (13) then the chunk type.
	bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

/**
 * A JPEG: `FF D8`, an APP0 segment to be skipped over, then a start-of-frame marker.
 * `sofMarker` defaults to baseline (`C0`); pass `0xc2` for a progressive JPEG.
 */
function jpeg(width: number, height: number, sofMarker = 0xc0, padding = 0): Uint8Array {
	// APP0: `FF E0`, then a length of 16 that COUNTS ITSELF — so 14 payload bytes follow
	// (`JFIF\0` and nine more). A segment whose declared length disagrees with its contents
	// desynchronises the marker walk, which is worth getting right in the fixture.
	const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, ...new Array(9).fill(0)];
	const sof = [
		0xff,
		sofMarker,
		0x00,
		0x11, // segment length
		0x08, // sample precision
		(height >> 8) & 0xff,
		height & 0xff,
		(width >> 8) & 0xff,
		width & 0xff,
		0x03, // component count
		...new Array(9).fill(0)
	];
	return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xda, ...new Array(padding).fill(0)]);
}

/** A RIFF/WebP header — a third parse path the module deliberately does not have. */
function webp(): Uint8Array {
	return new Uint8Array([
		0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20
	]);
}

/** Pads a valid header out to `bytes` total, so byte-size rules can be exercised. */
function sized(header: Uint8Array, bytes: number): Uint8Array {
	const padded = new Uint8Array(bytes);
	padded.set(header, 0);
	return padded;
}

function problems(result: ReturnType<typeof validateCover>): string[] {
	return result.ok ? [] : result.problems;
}

describe('readImageHeader', () => {
	it('reads width and height from a PNG IHDR chunk', () => {
		expect(readImageHeader(png(1000, 1500))).toEqual({ format: 'png', width: 1000, height: 1500 });
	});

	it('reads width and height from a baseline JPEG start-of-frame', () => {
		expect(readImageHeader(jpeg(600, 900))).toEqual({ format: 'jpeg', width: 600, height: 900 });
	});

	it('reads a progressive JPEG (SOF2), which would otherwise look unrecognised', () => {
		expect(readImageHeader(jpeg(600, 900, 0xc2))).toEqual({
			format: 'jpeg',
			width: 600,
			height: 900
		});
	});

	it('skips intermediate segments to reach the start-of-frame', () => {
		// The APP0 segment sits between SOI and SOF; reading it as a frame would give garbage.
		expect(readImageHeader(jpeg(800, 1200))?.width).toBe(800);
	});

	it('returns null for a RIFF/WebP header', () => {
		expect(readImageHeader(webp())).toBeNull();
	});

	it('returns null for a truncated PNG whose IHDR never arrives', () => {
		expect(readImageHeader(png(1000, 1500).slice(0, 16))).toBeNull();
	});

	it('returns null for a JPEG that reaches start-of-scan without a frame', () => {
		expect(readImageHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
	});

	it('returns null for empty input', () => {
		expect(readImageHeader(new Uint8Array(0))).toBeNull();
	});
});

describe('validateCover', () => {
	it('accepts a 1000x1500 PNG — exactly the 2:3 frame', () => {
		const result = validateCover(SLUG, png(1000, 1500));
		expect(result).toEqual({
			ok: true,
			image: { format: 'png', width: 1000, height: 1500, bytes: 24 }
		});
	});

	it('accepts a 600x900 JPEG', () => {
		const bytes = jpeg(600, 900);
		expect(validateCover(SLUG, bytes)).toEqual({
			ok: true,
			image: { format: 'jpeg', width: 600, height: 900, bytes: bytes.length }
		});
	});

	it('accepts a progressive JPEG', () => {
		expect(validateCover(SLUG, jpeg(800, 1200, 0xc2)).ok).toBe(true);
	});

	it('rejects an empty file', () => {
		expect(problems(validateCover(SLUG, new Uint8Array(0)))).toEqual([
			'pride-and-prejudice: cover file is empty.'
		]);
	});

	it('rejects a WebP by content, naming content rather than extension as the test', () => {
		expect(problems(validateCover(SLUG, webp()))).toEqual([
			'pride-and-prejudice: cover is not a PNG or JPEG (recognised by content, not by file extension).'
		]);
	});

	it('rejects a WebP renamed .png — the manifest name is never the claim', () => {
		// `coverObjectPath` would happily call this `<slug>.png`; only the bytes decide.
		const result = validateCover(SLUG, webp());
		expect(result.ok).toBe(false);
		expect(problems(result)[0]).toContain('not by file extension');
	});

	it('rejects a truncated header', () => {
		expect(problems(validateCover(SLUG, png(1000, 1500).slice(0, 16)))).toEqual([
			'pride-and-prejudice: cover is not a PNG or JPEG (recognised by content, not by file extension).'
		]);
	});

	it('rejects a file over the byte limit, and says the script will not resize it', () => {
		const bytes = sized(png(1000, 1500), 812 * 1024);
		expect(problems(validateCover(SLUG, bytes))).toEqual([
			'pride-and-prejudice: cover is 812 KB; the limit is 512 KB. Re-export it smaller — ingestion never resizes.'
		]);
	});

	it('accepts a file exactly at the byte limit', () => {
		expect(validateCover(SLUG, sized(png(1000, 1500), COVER_MAX_BYTES)).ok).toBe(true);
	});

	it('rejects a ratio outside the tolerance, and says the script will not crop it', () => {
		expect(problems(validateCover(SLUG, png(800, 900)))).toEqual([
			'pride-and-prejudice: cover is 800x900 (ratio 0.889); the frame is 2:3 (0.667) ±3%. Crop it — ingestion never transforms.'
		]);
	});

	it('rejects 1024x1600 (0.640) — just outside the ±3% band, deliberately', () => {
		const result = validateCover(SLUG, png(1024, 1600));
		expect(result.ok).toBe(false);
		expect(problems(result)[0]).toContain('ratio 0.640');
	});

	it('accepts 800x1200, which is 2:3 exactly', () => {
		expect(validateCover(SLUG, png(800, 1200)).ok).toBe(true);
	});

	it('rejects an image narrower than the minimum width', () => {
		// 300x450 is a perfect 2:3 and well under the byte limit; only width fails.
		expect(problems(validateCover(SLUG, png(300, 450)))).toEqual([
			`pride-and-prejudice: cover is 300x450; the minimum width is ${COVER_MIN_WIDTH}px. Re-export it larger — ingestion never upscales.`
		]);
	});

	it('accepts an image exactly at the minimum width', () => {
		expect(validateCover(SLUG, png(COVER_MIN_WIDTH, 600)).ok).toBe(true);
	});

	it('collects every problem rather than throwing on the first', () => {
		const result = validateCover(SLUG, sized(png(800, 900), 812 * 1024));
		expect(problems(result)).toHaveLength(2);
		expect(problems(result).join('\n')).toContain('the limit is 512 KB');
		expect(problems(result).join('\n')).toContain('ratio 0.889');
	});

	it('prefixes every problem with the slug, like the manifest validator', () => {
		for (const bytes of [new Uint8Array(0), webp(), png(800, 900), png(300, 450)]) {
			for (const problem of problems(validateCover('don-quijote', bytes))) {
				expect(problem.startsWith('don-quijote: ')).toBe(true);
			}
		}
	});

	it('never throws, whatever the bytes are', () => {
		const garbage = new Uint8Array([0xff, 0xd8, 0xff]);
		expect(() => validateCover(SLUG, garbage)).not.toThrow();
		expect(validateCover(SLUG, garbage).ok).toBe(false);
	});
});

describe('coverObjectPath', () => {
	it('derives the object key from the slug, so a re-ingest can only overwrite its own cover', () => {
		expect(coverObjectPath('pride-and-prejudice', 'png')).toBe('pride-and-prejudice.png');
		expect(coverObjectPath('don-quijote', 'jpeg')).toBe('don-quijote.jpg');
	});
});

describe('coverContentType', () => {
	it('maps each format to the MIME type the bucket allows', () => {
		expect(coverContentType('png')).toBe('image/png');
		expect(coverContentType('jpeg')).toBe('image/jpeg');
	});
});

describe('the constants', () => {
	it('states the frame BookCard renders and a small relative tolerance around it', () => {
		expect(COVER_ASPECT).toBeCloseTo(2 / 3, 10);
		expect(COVER_MAX_BYTES).toBe(512 * 1024);
	});
});
