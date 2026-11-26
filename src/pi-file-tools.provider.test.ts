import { readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assert, expect, it } from 'vitest';

import { withPiRuntime } from './fixtures/pi-runtime.js';
import { compareText } from './paths.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

it.each([
	{
		label: 'default',
		tools: undefined,
		active: ['bash', 'edit', 'read', 'write']
	},
	{ label: 'restricted', tools: ['read'], active: ['read'] }
])(
	'sandboxes the $label Pi tool selection when the package is loaded once',
	async ({ tools, active }) => {
		await withPiRuntime(
			[],
			async (runtime) => {
				const selected = runtime.session.state.tools;
				const read = selected.find((tool) => tool.name === 'read');

				expect(
					selected.map((tool) => tool.name).toSorted(compareText)
				).toStrictEqual(active);
				assert.isDefined(read);

				const result = await read.execute('allowed', { path: 'inside' });

				expect(result.content).toStrictEqual([
					{ type: 'text', text: 'inside' }
				]);
				await expect(
					read.execute('probe', { path: 'outside' })
				).rejects.toThrow();
			},
			{
				includeBuiltins: true,
				extensionPaths: [packageRoot],
				...(tools && { tools }),
				async prepare(workspace) {
					await writeFile(path.join(workspace, 'inside'), 'inside');
					await symlink(
						new URL('../package.json', import.meta.url),
						path.join(workspace, 'outside')
					);
				}
			}
		);
	}
);

it.runIf(process.platform === 'darwin')(
	'runs the six Pi file and search tools in the native offline workspace',
	async () => {
		const names = ['read', 'write', 'edit', 'ls', 'grep', 'find'];
		let workspace = '';
		const large = 'x'.repeat(1_100_000);

		await withPiRuntime(
			[],
			async (runtime, errors) => {
				const exec = async (name: string, input: Record<string, unknown>) => {
					const tool = runtime.session.state.tools.find(
						(item) => item.name === name
					);

					if (!tool) {
						throw new Error(`Missing ${name} tool.`);
					}

					const result = await tool.execute(name, input);

					return result.content;
				};

				await exec('write', {
					path: 'nested/sample.txt',
					content: large + '\nfirst\n'
				});
				await exec('edit', {
					path: 'nested/sample.txt',
					edits: [{ oldText: 'first', newText: 'second' }]
				});

				const read = await exec('read', {
					path: 'nested/sample.txt',
					offset: 2,
					limit: 1
				});
				const ls = await exec('ls', { path: 'nested' });
				const find = await exec('find', { pattern: '*.txt', path: 'nested' });
				const grep = await exec('grep', { pattern: 'second', path: 'nested' });

				const contents = await readFile(
					path.join(workspace, 'nested/sample.txt'),
					'utf8'
				);

				expect({
					read,
					ls,
					find,
					grep,
					contents: contents.endsWith('\nsecond\n'),
					errors
				}).toStrictEqual({
					read: [
						{
							type: 'text',
							text: 'second\n\n[1 more lines in file. Use offset=3 to continue.]'
						}
					],
					ls: [{ type: 'text', text: 'sample.txt' }],
					find: [{ type: 'text', text: 'sample.txt' }],
					grep: [{ type: 'text', text: 'sample.txt:2: second' }],
					contents: true,
					errors: []
				});
				await expect(
					exec('edit', {
						path: 'locked',
						edits: [{ oldText: 'original', newText: 'changed' }]
					})
				).rejects.toThrow();
				expect(await readFile(path.join(workspace, 'locked'), 'utf8')).toBe(
					'original'
				);
				await expect(exec('read', { path: 'outside' })).rejects.toThrow();

				const image = await exec('read', { path: 'pixel.png' });

				expect(
					image.map((block) =>
						block.type === 'text'
							? block.text.split('\n', 1)[0]
							: block.mimeType
					)
				).toStrictEqual(['Read image file [image/png]', 'image/png']);
			},
			{
				includeBuiltins: true,
				tools: names,
				extensionPaths: [packageRoot],
				async prepare(directory, agentDirectory) {
					workspace = directory;
					await writeFile(
						path.join(directory, 'pixel.png'),
						Buffer.from(
							'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP47xIKAAPeAZmiSZheAAAAAElFTkSuQmCC',
							'base64'
						)
					);
					await writeFile(path.join(directory, 'locked'), 'original');
					await symlink(
						new URL('../package.json', import.meta.url),
						path.join(directory, 'outside')
					);

					await writeFile(
						path.join(agentDirectory, 'mxc-sandbox.json'),
						JSON.stringify({
							protectPaths: ['locked']
						})
					);
				}
			}
		);
	},
	60_000
);
