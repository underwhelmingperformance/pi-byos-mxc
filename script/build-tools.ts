import { cp, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rolldown } from 'rolldown';

const pi = import.meta.resolve('@earendil-works/pi-coding-agent');
const requirePi = createRequire(pi);
const root = path.dirname(fileURLToPath(pi));
const destination = 'dist/tools';
const names = ['read', 'write', 'edit', 'ls', 'find', 'grep'];
const proxyExports = names
	.map((name) => {
		const initial = name.charAt(0).toUpperCase();
		const symbol = `create${initial}${name.slice(1)}ToolDefinition`;
		const filename = path.join(root, 'core/tools', name + '.js');

		return `export {${symbol}} from ${JSON.stringify(filename)};`;
	})
	.join('\n');

await mkdir(destination, { recursive: true });

const build = await rolldown({
	input: {
		worker: 'script/tool-worker.ts',
		'image-resize-worker': path.join(root, 'utils/image-resize-worker.js')
	},
	platform: 'node',
	plugins: [
		{
			name: 'pi-headless-tools',
			resolveId(id) {
				if (id === '@earendil-works/pi-coding-agent') {
					return '\0pi-tools';
				}

				const renderer =
					/^\.\/renderers\/(read|write|edit|ls|grep|find)\.js$/u.exec(id);

				if (renderer?.[1]) {
					return '\0renderer-' + renderer[1];
				}

				if (id === '@silvia-odwyer/photon-node') {
					return { id: './photon.cjs', external: true };
				}

				return;
			},
			load(id) {
				if (id === '\0pi-tools') {
					return proxyExports;
				}

				if (id.startsWith('\0renderer-')) {
					return `export const ${id.slice(10)}Renderers = {};`;
				}

				return;
			}
		}
	]
});

try {
	await build.write({
		dir: destination,
		format: 'esm',
		entryFileNames: '[name].js',
		codeSplitting: true
	});
} finally {
	await build.close();
}

const photon = path.dirname(requirePi.resolve('@silvia-odwyer/photon-node'));

await cp(
	path.join(photon, 'photon_rs.js'),
	path.join(destination, 'photon.cjs')
);
await cp(
	path.join(photon, 'photon_rs_bg.wasm'),
	path.join(destination, 'photon_rs_bg.wasm')
);
await cp('script/LICENSE-pi', path.join(destination, 'LICENSE-pi'));
await cp(
	path.join(requirePi.resolve('diff/package.json'), '../LICENSE'),
	path.join(destination, 'LICENSE-diff')
);

const typeboxEntry = fileURLToPath(import.meta.resolve('typebox'));

await cp(
	path.join(path.dirname(typeboxEntry), '../license'),
	path.join(destination, 'LICENSE-typebox')
);
await cp(
	path.join(photon, 'LICENSE.md'),
	path.join(destination, 'LICENSE-photon.md')
);
await writeFile(
	path.join(destination, 'package.json'),
	JSON.stringify({ type: 'module', version: '1.5.0' })
);
