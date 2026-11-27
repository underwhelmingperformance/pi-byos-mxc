import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtempDisposable, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SandboxTransportError } from 'pi-bring-your-own-sandbox/provider';
import { expect, it } from 'vitest';

import { cleanupControl } from '../fixtures/cleanup.js';
import { systemHost } from '../host.js';
import {
	generatedSystemMounts,
	systemReadonlyPaths
} from '../platform/system-paths.js';
import { quote } from '../shell.js';

import { SupervisorJob } from './client.js';

const entry = fileURLToPath(
	new URL('../../dist/supervisor/entry.js', import.meta.url)
);
const userRuntime = `/run/user/${String(process.getuid?.())}`;

it('ends the supervisor after an invalid start message', async () => {
	const job = new SupervisorJob({
		entry,
		request: {
			version: 1,
			kind: 'start',
			id: randomUUID(),
			backend: 'seatbelt',
			network: 'ip-denied',
			hostUserData: 'denied',
			systemRoots: [],
			command: 'true',
			shell: '/bin/sh',
			cwd: 'relative',
			readwritePaths: [],
			environment: {},
			readonlyPaths: [],
			deniedPaths: []
		},
		context: {
			operationId: randomUUID(),
			signal: new AbortController().signal,
			deadline: 10_000,
			remainingMs: () => 10_000,
			cleanup: cleanupControl().cleanup,
			reportDiagnostic() {
				return;
			},
			onOutput() {
				return;
			}
		},
		record: () => Promise.resolve()
	});

	await expect(job.run()).rejects.toStrictEqual(
		new SandboxTransportError({ operation: 'exec', providerId: 'mxc' })
	);
});

it.runIf(process.platform === 'linux' && existsSync(userRuntime))(
	'restores an injected Nix-style system root inside the runtime mask',
	async () => {
		await using runtime = await mkdtempDisposable(
			path.join(userRuntime, 'mxc-runtime-')
		);
		await using store = await mkdtempDisposable(
			path.join(tmpdir(), 'mxc-store-')
		);
		await using workspace = await mkdtempDisposable(
			path.join(tmpdir(), 'mxc-workspace-')
		);

		const root = path.join(runtime.path, 'current-system');
		const executable = path.join(root, 'probe');

		await symlink(store.path, root);
		await writeFile(
			path.join(store.path, 'probe'),
			'#!/bin/sh\nprintf restored',
			{ mode: 0o755 }
		);

		const mounts = await generatedSystemMounts(systemHost.fs, 'linux', false, [
			root
		]);
		const resolver = await systemReadonlyPaths('linux', systemHost.fs);
		const stdout: Uint8Array[] = [];
		const job = new SupervisorJob({
			entry,
			request: {
				version: 1,
				kind: 'start',
				id: randomUUID(),
				backend: 'bubblewrap',
				network: 'ip-denied',
				hostUserData: 'denied',
				systemRoots: [root],
				command: `[ ! -w ${quote(executable)} ] && ${quote(executable)}`,
				shell: '/bin/sh',
				cwd: workspace.path,
				environment: {},
				readwritePaths: [workspace.path],
				deniedPaths: mounts.deniedPaths,
				readonlyPaths: [...mounts.readonlyPaths, ...resolver]
			},
			context: {
				operationId: randomUUID(),
				signal: new AbortController().signal,
				deadline: 10_000,
				remainingMs: () => 10_000,
				cleanup: cleanupControl().cleanup,
				reportDiagnostic() {
					return;
				},
				onOutput(chunk) {
					if (chunk.stream === 'stdout') {
						stdout.push(chunk.data);
					}
				}
			},
			record: () => Promise.resolve()
		});

		const outcome = await job.run();

		expect({
			outcome,
			stdout: Buffer.concat(stdout).toString('utf8')
		}).toStrictEqual({
			outcome: { kind: 'exited', exit: { kind: 'code', code: 0 } },
			stdout: 'restored'
		});
	}
);
