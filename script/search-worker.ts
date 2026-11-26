import { isUtf8 } from 'node:buffer';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { GrepMatch } from 'pi-bring-your-own-sandbox/provider';
import { RE2JS } from 're2js';

import { compareText } from '../src/paths.js';

const execute = promisify(execFile);
const maxBytes = 8 * 1024 * 1024;

async function candidates(root: string): Promise<string[]> {
	const { stdout } = await execute(
		'/usr/bin/find',
		[
			'-P',
			'.',
			'(',
			'-name',
			'.git',
			'-o',
			'-name',
			'node_modules',
			')',
			'-prune',
			'-o',
			'-print0'
		],
		{ cwd: root, encoding: 'buffer', maxBuffer: maxBytes }
	);

	if (!isUtf8(stdout)) {
		throw new TypeError('Search requires UTF-8 paths.');
	}

	return stdout
		.toString()
		.split('\0')
		.filter((entry) => entry.startsWith('./'))
		.map((entry) => entry.slice(2))
		.toSorted(compareText);
}

async function linesOf(filename: string): Promise<string[]> {
	await using file = await open(
		filename,
		constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
	);

	const metadata = await file.stat();

	if (!metadata.isFile() || metadata.size > maxBytes) {
		return [];
	}

	const data = Buffer.alloc(metadata.size + 1);
	let offset = 0;

	while (offset < data.length) {
		const { bytesRead } = await file.read(data, offset, data.length - offset);

		if (!bytesRead) {
			break;
		}

		offset += bytesRead;
	}

	const bytes = data.subarray(0, offset);

	if (
		offset > metadata.size ||
		bytes.includes(0) ||
		!isUtf8(bytes) ||
		bytes.length === 0
	) {
		return [];
	}

	const lines = bytes.toString().split(/\r?\n/u);

	if (lines.at(-1) === '') {
		lines.pop();
	}

	return lines;
}

async function search() {
	const [operation, encoded] = process.argv.slice(2);
	const options = new URLSearchParams(encoded);
	const root = path.resolve(options.get('path') ?? '.');
	const metadata = await lstat(root);
	const isFind = operation === 'find';

	if (!metadata.isDirectory() && (isFind || !metadata.isFile())) {
		throw new TypeError(
			'Expected a search directory or a regular file for grep.'
		);
	}

	const limit = Number(options.get('limit') ?? (isFind ? 1000 : 100));
	const pattern = options.get('pattern') ?? '';
	const glob = isFind ? pattern : options.get('glob');
	const isIgnoreCase = options.get('ignoreCase') === 'true';
	const isLiteral = options.get('literal') === 'true';
	const needle = isIgnoreCase ? pattern.toLowerCase() : pattern;
	const regex =
		isFind || isLiteral
			? undefined
			: RE2JS.compile(pattern, isIgnoreCase ? RE2JS.CASE_INSENSITIVE : 0);
	const context = Number(options.get('context') ?? 0);
	const directory = metadata.isDirectory() ? root : path.dirname(root);
	const entries = metadata.isDirectory()
		? await candidates(root)
		: [path.basename(root)];
	const paths: string[] = [];
	const matches: GrepMatch[] = [];
	let isTruncated = false;
	let size = 0;

	entries: for (const relative of entries) {
		if (
			glob !== null &&
			!path.matchesGlob(
				glob.includes('/') ? relative : path.basename(relative),
				glob
			)
		) {
			continue;
		}

		const filename = path.join(directory, relative);
		const entry = await lstat(filename);

		if (isFind) {
			if (paths.length === limit) {
				isTruncated = true;
				break;
			}

			paths.push(entry.isDirectory() ? relative + '/' : relative);
			continue;
		}

		if (!entry.isFile()) {
			continue;
		}

		const lines = await linesOf(filename);

		for (const [index, text] of lines.entries()) {
			const isMatch = regex
				? regex.test(text)
				: (isIgnoreCase ? text.toLowerCase() : text).includes(needle);

			if (!isMatch) {
				continue;
			}

			if (matches.length === limit) {
				isTruncated = true;
				break entries;
			}

			const result = {
				path: relative,
				line: index + 1,
				text,
				before: lines.slice(Math.max(0, index - context), index),
				after: lines.slice(index + 1, index + 1 + context)
			};

			size += Buffer.byteLength(JSON.stringify(result)) + 1;

			if (size > maxBytes) {
				throw new RangeError('Search results exceed 8 MiB.');
			}

			matches.push(result);
		}
	}

	return isFind
		? { paths, truncated: isTruncated }
		: { matches, truncated: isTruncated };
}

try {
	process.stdout.write(JSON.stringify(await search()));
} catch (error) {
	const code =
		error instanceof Error && 'code' in error ? error.code : undefined;

	process.exitCode =
		code === 'ENOENT' || code === 'ENOTDIR'
			? 44
			: code === 'EACCES' || code === 'EPERM'
				? 43
				: 1;
}
