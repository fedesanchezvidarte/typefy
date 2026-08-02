/**
 * Cover validation (spec #19 §2).
 *
 * Ingestion **validates and uploads; it never transforms**. There is no image library here
 * and there is not meant to be one: twelve covers are prepared by hand once, and an image
 * pipeline is a dependency — and a class of bug — owned forever. Every rejection below
 * therefore names the fix *and* says the script will not do it, so the first person to hit
 * one does not reach for `sharp`.
 *
 * Pure by construction (`lib-patterns` tier 1): the input is a `Uint8Array`, so the module is
 * Node-free, its spec builds headers inline as byte arrays, and everything filesystem,
 * network and storage stays in `scripts/ingest.ts`.
 *
 * Problems are **collected, never thrown on first**, matching `parseManifest`: fixing one
 * problem per run to discover the next is a miserable loop.
 */

/** The frame `BookCard` renders (`aspect-2/3`). */
export const COVER_ASPECT = 2 / 3;

/**
 * ±3%, **relative** to the aspect — an accepted band of 0.647–0.687. `1000x1500`, `600x900`
 * and `800x1200` pass exactly; `1024x1600` (0.640) does not, which is intended: covers are
 * prepared by hand and a tight band is what keeps the shelf visually regular.
 */
export const COVER_ASPECT_TOLERANCE = 0.03;

/**
 * 512 KB. The frame is ~158 px wide (~316 px at 2×), lazily loaded, twelve of them — this is
 * already generous. Mirrored by the `covers` bucket's `file_size_limit`, deliberately: the
 * readable refusal comes from here first, the bucket is the backstop for anything uploaded
 * outside the script. Change one and change the other.
 */
export const COVER_MAX_BYTES = 512 * 1024;

/**
 * A 120x180 image passes the ratio and the byte limit and still looks terrible in the frame.
 * Upscaling is a transform, so the answer is a re-export, not a resize.
 */
export const COVER_MIN_WIDTH = 400;

/**
 * PNG and JPEG only. WebP and AVIF are rejected not because browsers cannot render them but
 * because RIFF is a third parse path, and this module's whole value is being small enough to
 * be obviously correct. Exporting PNG or JPEG is free.
 */
export const COVER_FORMATS = ['png', 'jpeg'] as const;

export type CoverFormat = (typeof COVER_FORMATS)[number];

export interface CoverImage {
	format: CoverFormat;
	width: number;
	height: number;
	bytes: number;
}

export type CoverResult = { ok: true; image: CoverImage } | { ok: false; problems: string[] };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** `IHDR`, which must be the first PNG chunk — width and height live inside it. */
const PNG_IHDR = [0x49, 0x48, 0x44, 0x52];
/** Signature (8) + chunk length (4) + type (4) + width (4) + height (4). */
const PNG_HEADER_BYTES = 24;

function matches(bytes: Uint8Array, expected: readonly number[], offset: number): boolean {
	if (bytes.length < offset + expected.length) {
		return false;
	}
	return expected.every((byte, index) => bytes[offset + index] === byte);
}

function uint32(bytes: Uint8Array, offset: number): number {
	return (
		((bytes[offset] << 24) >>> 0) +
		(bytes[offset + 1] << 16) +
		(bytes[offset + 2] << 8) +
		bytes[offset + 3]
	);
}

function uint16(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] << 8) + bytes[offset + 1];
}

/**
 * A JPEG start-of-frame marker: `C0`–`CF` **excluding** `C4` (DHT), `C8` (JPG) and `CC` (DAC),
 * which are Huffman/arithmetic tables rather than frames. Including `C2` matters — progressive
 * JPEGs are common and would otherwise read as "unrecognised".
 */
function isStartOfFrame(marker: number): boolean {
	return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readJpegHeader(bytes: Uint8Array): Omit<CoverImage, 'bytes'> | null {
	let index = 2;
	while (index + 3 < bytes.length) {
		if (bytes[index] !== 0xff) {
			return null;
		}
		let marker = bytes[index + 1];
		// `FF` is also the padding byte between segments; skip runs of it.
		while (marker === 0xff && index + 2 < bytes.length) {
			index += 1;
			marker = bytes[index + 1];
		}
		// SOS and EOI end the metadata: past here there is only entropy-coded data.
		if (marker === 0xda || marker === 0xd9) {
			return null;
		}
		// Standalone markers carry no length field.
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			index += 2;
			continue;
		}
		const length = uint16(bytes, index + 2);
		if (length < 2) {
			return null;
		}
		if (isStartOfFrame(marker)) {
			if (index + 8 >= bytes.length) {
				return null;
			}
			return {
				format: 'jpeg',
				width: uint16(bytes, index + 7),
				height: uint16(bytes, index + 5)
			};
		}
		index += 2 + length;
	}
	return null;
}

/**
 * Format and dimensions from the header alone, or `null` when the bytes are neither PNG nor
 * JPEG — or are truncated before the dimensions arrive.
 *
 * **Format comes from the magic bytes, never the file extension.** A `.webp` renamed `.png`
 * is rejected here; the manifest's `cover` string is a name, not a claim.
 */
export function readImageHeader(bytes: Uint8Array): Omit<CoverImage, 'bytes'> | null {
	let header: Omit<CoverImage, 'bytes'> | null = null;

	if (matches(bytes, PNG_SIGNATURE, 0)) {
		if (bytes.length < PNG_HEADER_BYTES || !matches(bytes, PNG_IHDR, 12)) {
			return null;
		}
		header = { format: 'png', width: uint32(bytes, 16), height: uint32(bytes, 20) };
	} else if (matches(bytes, [0xff, 0xd8], 0)) {
		header = readJpegHeader(bytes);
	}

	// A zero dimension is a corrupt header, not an image — and it would divide by zero below.
	if (!header || header.width <= 0 || header.height <= 0) {
		return null;
	}
	return header;
}

function kilobytes(bytes: number): number {
	return Math.round(bytes / 1024);
}

/**
 * Every problem with this cover, or the image the uploader may use. Never throws: the caller
 * is a CLI that should print what is wrong rather than a stack trace.
 */
export function validateCover(slug: string, bytes: Uint8Array): CoverResult {
	if (bytes.length === 0) {
		return { ok: false, problems: [`${slug}: cover file is empty.`] };
	}

	const problems: string[] = [];

	if (bytes.length > COVER_MAX_BYTES) {
		problems.push(
			`${slug}: cover is ${kilobytes(bytes.length)} KB; the limit is ${kilobytes(COVER_MAX_BYTES)} KB. ` +
				'Re-export it smaller — ingestion never resizes.'
		);
	}

	const header = readImageHeader(bytes);
	if (!header) {
		problems.push(
			`${slug}: cover is not a PNG or JPEG (recognised by content, not by file extension).`
		);
		return { ok: false, problems };
	}

	const { width, height } = header;
	const ratio = width / height;
	if (Math.abs(ratio - COVER_ASPECT) / COVER_ASPECT > COVER_ASPECT_TOLERANCE) {
		problems.push(
			`${slug}: cover is ${width}x${height} (ratio ${ratio.toFixed(3)}); the frame is 2:3 ` +
				`(${COVER_ASPECT.toFixed(3)}) ±${Math.round(COVER_ASPECT_TOLERANCE * 100)}%. ` +
				'Crop it — ingestion never transforms.'
		);
	}

	if (width < COVER_MIN_WIDTH) {
		problems.push(
			`${slug}: cover is ${width}x${height}; the minimum width is ${COVER_MIN_WIDTH}px. ` +
				'Re-export it larger — ingestion never upscales.'
		);
	}

	if (problems.length > 0) {
		return { ok: false, problems };
	}
	return { ok: true, image: { ...header, bytes: bytes.length } };
}

/**
 * The Storage object key, derived from the slug. This is what makes "a re-ingest overwrites
 * its own cover and can never touch another's" a structural property rather than a
 * convention. A format change orphans the previous object; that costs bytes and nothing else.
 */
export function coverObjectPath(slug: string, format: CoverFormat): string {
	return `${slug}.${format === 'png' ? 'png' : 'jpg'}`;
}

/** The MIME type to upload with — and the one the bucket's `allowed_mime_types` permits. */
export function coverContentType(format: CoverFormat): string {
	return `image/${format}`;
}
