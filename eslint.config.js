import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	},
	{
		// Spec #7: fixtures left the runtime path when the database became the source of
		// typeable text. They survive as Vitest data and as the input that generates the
		// seed migration — but a route importing them would reinstate exactly the silent
		// fallback the phase removed, masking the database failures it must expose.
		// The spec requires this to be enforced by a lint rule rather than checked by hand.
		files: ['src/routes/**'],
		rules: {
			'@typescript-eslint/no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['$lib/fixtures', '$lib/fixtures/*', '**/lib/fixtures', '**/lib/fixtures/*'],
							message:
								'Routes must read typeable text from the database via $lib/server/books. Fixtures are test/seed data only (spec #7).'
						}
					]
				}
			]
		}
	},
	{
		// Override or add rule settings here, such as:
		// 'svelte/button-has-type': 'error'
		rules: {}
	}
);
