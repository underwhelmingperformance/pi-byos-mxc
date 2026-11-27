import { expect, it } from 'vitest';

import { ProtectedSymbolicLinkError } from './errors.js';
import { memoryHost } from './fixtures/host.js';
import { compareText } from './paths.js';
import { PlaceholderRegistry } from './placeholders.js';
import { planProtection } from './protection.js';

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
		owned: lease.owned,
		during,
		after: state(memory)
	}).toStrictEqual({
		owned: [envrc, idea],
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
		owned: [first.owned, second.owned],
		isPresentAfterFirst,
		afterSecond: memory.existsSync(envrc)
	}).toStrictEqual({
		owned: [[envrc], [envrc]],
		isPresentAfterFirst: true,
		afterSecond: false
	});
});

it('leases a placeholder while another command creates it', async () => {
	const { host, memory } = memoryHost({ '/workspace': {} });
	const written = Promise.withResolvers<undefined>();
	const resume = Promise.withResolvers<undefined>();
	const placeholders = new PlaceholderRegistry({
		...host.fs,
		async writeFile(filename, data, options) {
			await host.fs.writeFile(filename, data, options);
			written.resolve(undefined);
			await resume.promise;
		}
	});
	const first = placeholders.acquire([envrc]);

	await written.promise;

	const second = placeholders.acquire([envrc]);

	resume.resolve(undefined);

	const [firstLease, secondLease] = await Promise.all([first, second]);

	await firstLease.release();

	const isAfterFirst = memory.existsSync(envrc);

	await secondLease.release();

	expect({
		afterFirst: isAfterFirst,
		afterSecond: memory.existsSync(envrc)
	}).toStrictEqual({
		afterFirst: true,
		afterSecond: false
	});
});

it('attempts independent removals and retries each residue', async () => {
	const { host, memory } = memoryHost({ '/workspace': {} });
	const blocked = new Set([envrc, idea]);
	const third = '/workspace/.bashrc';
	const placeholders = new PlaceholderRegistry({
		...host.fs,
		async unlink(filename) {
			if (blocked.has(filename)) {
				throw new Error('injected unlink failure');
			}

			await host.fs.unlink(filename);
		}
	});
	const lease = await placeholders.acquire([envrc, third, idea]);

	await expect(lease.release()).rejects.toMatchObject({
		errors: [
			{ message: `Could not remove MXC placeholder ${envrc}.` },
			{ message: `Could not remove MXC placeholder ${idea}.` }
		]
	});
	expect(state(memory).map(({ name }) => name)).toStrictEqual([
		'.envrc',
		'.idea'
	]);

	blocked.clear();
	await lease.release();

	expect(state(memory)).toStrictEqual([]);
});

it('plans around an active placeholder at an ancestor of a protected path', async () => {
	const { host } = memoryHost({ '/workspace': {} });
	const placeholders = new PlaceholderRegistry(host.fs);
	const lease = await placeholders.acquire([idea]);

	try {
		const request = {
			workspace: '/workspace',
			backend: 'bubblewrap',
			workspaceAccess: 'read-write',
			resources: [{ kind: 'path', path: '.idea/tasks.xml' }],
			inspectEntry: (filename: string) => placeholders.inspect(filename)
		} as const;

		await expect(planProtection(host, request)).resolves.toStrictEqual({
			readonlyPaths: [],
			placeholders: [idea],
			pins: []
		});
	} finally {
		await lease.release();
	}
});

it('grants an entry that the host created after planning without removing it', async () => {
	const { placeholders, memory } = registry();

	memory.writeFileSync(envrc, 'use nix');

	const lease = await placeholders.acquire([envrc]);

	await lease.release();

	expect({
		owned: lease.owned,
		contents: String(memory.readFileSync(envrc, 'utf8'))
	}).toStrictEqual({ owned: [], contents: 'use nix' });
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
