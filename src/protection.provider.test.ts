import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { withNativeSandbox } from './fixtures/native-sandbox.js';
import { compareText } from './paths.js';

const execute = promisify(execFile);
const isLinux = process.platform === 'linux';

// These preset entries start absent, so Linux covers them with placeholders.
const ENTRIES = ['.direnv', '.vscode', '.idea', '.devcontainer'];
const OBSERVED = [
	'.git',
	'.git/config',
	'.git/HEAD',
	'.git/hooks',
	'.pi',
	'.pi/settings.json',
	'.envrc',
	...ENTRIES
];

const MUTATIONS = [
	'printf x >> .git/config',
	'printf x > .git/HEAD',
	'chmod 777 .git/config',
	'rm -f .git/config',
	'mv .git .git-moved',
	'rm -rf .git/hooks',
	'printf x > .git/hooks/pre-commit',
	'printf x > .pi/settings.json',
	'mv .pi .pi-moved',
	'printf x > replacement && mv replacement .envrc',
	'printf x > .envrc',
	'mkdir -p .idea/x .direnv/x .vscode/x .devcontainer/x',
	'ln -s .git/config link && printf x >> link',
	'ln .pi/settings.json hard && printf x >> hard',
	...(isLinux
		? []
		: ['printf x >> .GIT/config', 'mkdir .IDEA', 'printf x > .ENVRC'])
];

interface Observation {
	readonly inode: number;
	readonly mode: number;
	readonly contents: string | readonly string[];
}

async function observeEntry(filename: string): Promise<Observation | 'absent'> {
	try {
		const metadata = await lstat(filename);

		if (!metadata.isDirectory()) {
			const contents = await readFile(filename, 'utf8');

			return { inode: metadata.ino, mode: metadata.mode, contents };
		}

		const names = await readdir(filename);

		return {
			inode: metadata.ino,
			mode: metadata.mode,
			contents: names.toSorted(compareText)
		};
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return 'absent';
		}

		throw error;
	}
}

async function observe(workspace: string) {
	const entries = await Promise.all(
		OBSERVED.map(
			async (relative) =>
				[relative, await observeEntry(path.join(workspace, relative))] as const
		)
	);

	return Object.fromEntries(entries);
}

it('keeps host configuration immutable while ordinary workspace writes succeed', async () => {
	await withNativeSandbox(
		{},
		async (sandbox, workspace) => {
			const before = await observe(workspace);

			for (const command of MUTATIONS) {
				await sandbox.exec({ kind: 'shell', dialect: 'sh', command });
			}

			const ordinary = await sandbox.exec({
				kind: 'shell',
				dialect: 'sh',
				command: 'printf ok > ordinary'
			});

			expect({
				after: await observe(workspace),
				ordinary: ordinary.exit,
				written: await readFile(path.join(workspace, 'ordinary'), 'utf8')
			}).toStrictEqual({
				after: before,
				ordinary: { kind: 'code', code: 0 },
				written: 'ok'
			});
		},
		{
			async prepareWorkspace(workspace) {
				await execute('git', ['init', '--quiet', workspace]);
				await mkdir(path.join(workspace, '.pi'));
				await writeFile(
					path.join(workspace, '.pi', 'settings.json'),
					'original'
				);
			}
		}
	);
});

it.skipIf(!isLinux)(
	'protects a nested path by pinning the directories above it',
	async () => {
		await withNativeSandbox(
			{ protectPaths: ['tools/hooks', 'tools/generated/hook'] },
			async (sandbox, workspace) => {
				const before = await observeEntry(path.join(workspace, 'tools/hooks'));

				for (const command of [
					'mv tools tools-moved',
					'rm -rf tools',
					'printf x > tools/hooks',
					'mkdir -p tools/generated/x',
					'printf x > tools/generated/hook'
				]) {
					await sandbox.exec({ kind: 'shell', dialect: 'sh', command });
				}

				const sibling = await sandbox.exec({
					kind: 'shell',
					dialect: 'sh',
					command: 'printf ok > tools/sibling'
				});

				expect({
					hooks: await observeEntry(path.join(workspace, 'tools/hooks')),
					generated: await observeEntry(
						path.join(workspace, 'tools/generated')
					),
					sibling: sibling.exit
				}).toStrictEqual({
					hooks: before,
					generated: 'absent',
					sibling: { kind: 'code', code: 0 }
				});
			},
			{
				async prepareWorkspace(workspace) {
					await mkdir(path.join(workspace, 'tools'));
					await writeFile(path.join(workspace, 'tools', 'hooks'), 'original');
				}
			}
		);
	}
);
