import { cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rolldown } from 'rolldown';

const destination = 'dist/tools';
const build = await rolldown({
	input: { search: 'script/search-worker.ts' },
	platform: 'node'
});

try {
	await build.write({
		dir: destination,
		format: 'esm',
		entryFileNames: '[name].mjs'
	});
} finally {
	await build.close();
}

const re2jsRoot = fileURLToPath(new URL('..', import.meta.resolve('re2js')));

await cp(
	path.join(re2jsRoot, 'LICENSE'),
	path.join(destination, 'LICENSE-re2js')
);
