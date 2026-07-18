#!/usr/bin/env node
/**
 * CI gate: every locale message bundle must expose the same message keys as the
 * base (EN) bundle. Exits non-zero and lists the offending keys otherwise.
 *
 * Usage: node scripts/check-i18n-parity.js
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffMessageKeys } from '../src/lib/i18n/parity.js';

const messagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'messages');
const baseLocale = 'en';

/** @param {string} locale */
const readBundle = (locale) =>
	JSON.parse(readFileSync(join(messagesDir, `${locale}.json`), 'utf8'));

const base = readBundle(baseLocale);
const otherLocales = readdirSync(messagesDir)
	.filter((file) => file.endsWith('.json'))
	.map((file) => file.replace(/\.json$/, ''))
	.filter((locale) => locale !== baseLocale);

let failed = false;

for (const locale of otherLocales) {
	const { missingInA, missingInB } = diffMessageKeys(readBundle(locale), base);

	if (missingInA.length > 0) {
		failed = true;
		console.error(
			`[i18n] ${locale}.json is missing keys present in ${baseLocale}.json: ${missingInA.join(', ')}`
		);
	}
	if (missingInB.length > 0) {
		failed = true;
		console.error(
			`[i18n] ${baseLocale}.json is missing keys present in ${locale}.json: ${missingInB.join(', ')}`
		);
	}
}

if (failed) {
	process.exit(1);
}

console.log(`[i18n] Message key parity OK across: ${[baseLocale, ...otherLocales].join(', ')}`);
