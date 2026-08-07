#!/usr/bin/env node
/**
 * CI gate: spec #26's E2E coverage floor.
 *
 * `e2e/coverage-manifest.json` is the audit — one entry per glossary promise decomposed
 * against the E2E suite — reproduced as data so it can be checked mechanically rather than
 * trusted on the strength of a comment. Every entry must be either:
 *
 *   - `"covered"`, with at least one citation whose `file` exists under `e2e/` and whose
 *     content contains `testTitleContains` as a plain substring (no AST parsing — the same
 *     "good enough, catches drift" bar `check-i18n-parity.js` sets for its own gate); or
 *   - `"deferred"`, with a non-empty `reason` explaining why E2E is not where it belongs.
 *
 * This catches the one failure mode an audit-as-a-comment cannot: a citation that was true
 * the day the audit was written and silently went stale — a test renamed, a file moved, a
 * `test.skip` swapped in — with nobody noticing because nothing ever re-checked it.
 *
 * Usage: node scripts/check-e2e-coverage.js
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repoRoot, 'e2e', 'coverage-manifest.json');

/** @typedef {{ file: string, testTitleContains: string }} Citation */
/**
 * @typedef {{
 *   id: string,
 *   glossaryTerm: string,
 *   status: string,
 *   citations?: Citation[],
 *   reason?: string
 * }} Promise
 */

/** @type {Promise[]} */
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (!Array.isArray(manifest) || manifest.length === 0) {
	console.error(`[e2e-coverage] ${manifestPath} must be a non-empty array`);
	process.exit(1);
}

/** File contents, read once per file no matter how many entries cite it. */
const fileCache = new Map();

/** @param {string} relativePath */
function readCited(relativePath) {
	if (fileCache.has(relativePath)) return fileCache.get(relativePath);
	const fullPath = join(repoRoot, relativePath);
	const content = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : null;
	fileCache.set(relativePath, content);
	return content;
}

let failed = false;

/** @param {string} id @param {string} problem */
function fail(id, problem) {
	failed = true;
	console.error(`[e2e-coverage] ${id}: ${problem}`);
}

const seenIds = new Set();

for (const promise of manifest) {
	const { id, status } = promise;

	if (!id || typeof id !== 'string') {
		fail(String(id), 'missing or non-string id');
		continue;
	}
	if (seenIds.has(id)) {
		fail(id, 'duplicate id in the manifest');
	}
	seenIds.add(id);

	if (status === 'covered') {
		const citations = promise.citations;
		if (!Array.isArray(citations) || citations.length === 0) {
			fail(id, 'status is "covered" but has no citations');
			continue;
		}
		for (const citation of citations) {
			const { file, testTitleContains } = citation ?? {};
			if (!file || !file.startsWith('e2e/')) {
				fail(id, `citation file "${file}" must live under e2e/`);
				continue;
			}
			const content = readCited(file);
			if (content === null) {
				fail(id, `cited file does not exist: ${file}`);
				continue;
			}
			if (!testTitleContains || typeof testTitleContains !== 'string') {
				fail(id, `citation in ${file} has no testTitleContains string`);
				continue;
			}
			if (!content.includes(testTitleContains)) {
				fail(
					id,
					`stale citation — ${file} no longer contains the substring: "${testTitleContains}"`
				);
			}
		}
	} else if (status === 'deferred') {
		if (!promise.reason || typeof promise.reason !== 'string' || promise.reason.trim() === '') {
			fail(id, 'status is "deferred" but has no non-empty reason');
		}
	} else {
		fail(id, `status must be exactly "covered" or "deferred", got: ${JSON.stringify(status)}`);
	}
}

if (failed) {
	process.exit(1);
}

console.log(`[e2e-coverage] ${manifest.length} glossary promises accounted for — floor holds.`);
