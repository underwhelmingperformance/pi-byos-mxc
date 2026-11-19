import { expect, it } from 'vitest';

import { ProtectedSymbolicLinkError } from './errors.js';
import { memoryHost } from './fixtures/host.js';
import { compareText } from './paths.js';
import { PlaceholderRegistry } from './placeholders.js';

const envrc = '/workspace/.envrc';
const idea = '/workspace/.idea';

function registry() {
	const { host, memory } = memoryHost({ '/workspace/src': {} });

	return { placeholders: new PlaceholderRegistry(host.fs), memory };
}

function state(memory: ReturnType<typeof memoryHost>['memory']) {
	return memory
		.readdirSync('/workspace')
		.map(String)
		.toSorted(compareText)
		.map((name) => {
			const metadata = memory.lstatSync(`/workspace/${name}`);

			return {
				name,
				kind: metadata.isDirectory() ? 'directory' : 'file',
				size: metadata.size,
				mode: metadata.mode & 0o777
			};
		});
}

it('creates empty read-only placeholders and removes them on release', async () => {
	const { placeholders, memory } = registry();
	const lease = await placeholders.acquire([envrc, idea]);
	const during = state(memory);

	await lease.release();

	expect({
		paths: lease.paths,
		created: lease.created,
		during,
		after: state(memory)
	}).toStrictEqual({
		paths: [envrc, idea],
		created: [envrc, idea],
		during: [
			{ name: '.envrc', kind: 'file', size: 0, mode: 0o644 },
			{ name: '.idea', kind: 'file', size: 0, mode: 0o644 },
			{ name: 'src', kind: 'directory', size: 0, mode: 0o777 }
		],
		after: [{ name: 'src', kind: 'directory', size: 0, mode: 0o777 }]
	});
});

it('keeps a shared placeholder until its last lease is released', async () => {
	const { placeholders, memory } = registry();
	const first = await placeholders.acquire([envrc]);
	const second = await placeholders.acquire([envrc]);

	await first.release();

	const isPresentAfterFirst = memory.existsSync(envrc);

	await second.release();

	expect({
		created: [first.created, second.created],
		isPresentAfterFirst,
		afterSecond: memory.existsSync(envrc)
	}).toStrictEqual({
		created: [[envrc], []],
		isPresentAfterFirst: true,
		afterSecond: false
	});
});

it('grants an entry that the host created after planning without removing it', async () => {
	const { placeholders, memory } = registry();

	memory.writeFileSync(envrc, 'use nix');

	const lease = await placeholders.acquire([envrc]);

	await lease.release();

	expect({
		paths: lease.paths,
		created: lease.created,
		contents: String(memory.readFileSync(envrc, 'utf8'))
	}).toStrictEqual({ paths: [envrc], created: [], contents: 'use nix' });
});

it('leaves a placeholder that the host replaced', async () => {
	const { placeholders, memory } = registry();
	const lease = await placeholders.acquire([envrc]);

	memory.unlinkSync(envrc);
	memory.writeFileSync(envrc, 'use nix');
	await lease.release();

	expect(String(memory.readFileSync(envrc, 'utf8'))).toBe('use nix');
});

it('rejects a symbolic link that appeared at a placeholder path', async () => {
	const { placeholders, memory } = registry();

	memory.symlinkSync('/outside', envrc);

	await expect(placeholders.acquire([idea, envrc])).rejects.toStrictEqual(
		new ProtectedSymbolicLinkError(envrc)
	);
	expect(state(memory).map(({ name }) => name)).toStrictEqual([
		'.envrc',
		'src'
	]);
});

it('releases a lease only once', async () => {
	const { placeholders, memory } = registry();
	const first = await placeholders.acquire([envrc]);
	const second = await placeholders.acquire([envrc]);

	await first.release();
	await first.release();

	expect(memory.existsSync(envrc)).toBe(true);
	await second.release();
});
