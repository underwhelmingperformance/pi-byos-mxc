import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { SandboxAcquireOptions } from 'pi-bring-your-own-sandbox/api';
import { expect, it } from 'vitest';

import { nodeCommand, withNativeSandbox } from './fixtures/native-sandbox.js';

const execute = promisify(execFile);
const requirements: SandboxAcquireOptions = {
	policy: {
		workspaceAccess: 'read-only',
		filesystemScope: 'system-read-only',
		networkAccess: 'denied'
	},
	capabilities: ['exec', 'files.read'],
	processKinds: ['shell'],
	shells: ['sh'],
	exitStatus: 'guaranteed',
	terminationScope: 'process-group'
};

it.runIf(process.platform === 'darwin')(
	'opens the native reviewer backend and reads live workspace changes',
	async () => {
		await withNativeSandbox(
			{},
			async (sandbox, workspace) => {
				const file = path.join(workspace, 'evidence');

				await writeFile(file, 'changed');
				await sandbox.files.access(file, 'read');

				const stat = await sandbox.files.stat(file);
				const data = await sandbox.files.readFile(file);

				await expect(
					sandbox.files.writeFile(file, new Uint8Array(1_100_000))
				).rejects.toMatchObject({ name: 'SandboxPermissionDeniedError' });

				const result = await sandbox.exec({
					kind: 'shell',
					dialect: 'sh',
					command: 'kill -TERM $$'
				});

				expect({
					stat,
					data: Buffer.from(data).toString(),
					exit: result.exit,
					status: sandbox.capabilities.exitStatus
				}).toStrictEqual({
					stat: { kind: 'file', size: 7 },
					data: 'changed',
					exit: { kind: 'signal', signal: 'SIGTERM', signalNumber: 15 },
					status: 'guaranteed'
				});
			},
			{ requirements }
		);
	}
);
it
	.runIf(process.platform === 'darwin')
	.each(['read-only', 'read-write'] as const)(
	'denies socket connections and outside reads with a %s workspace',
	async (workspaceAccess) => {
		const outside = await mkdtemp(path.join(tmpdir(), 'mxc-outside-'));

		try {
			const secret = path.join(outside, 'private');

			await writeFile(secret, 'outside');
			await withNativeSandbox(
				{ network: 'open-egress' },
				async (sandbox, workspace) => {
					const socket = path.join(workspace, 'socket');
					const socketServer = createServer((client) =>
						client.end('reachable')
					);
					const tcp = createServer((client) => client.end('reachable'));

					try {
						socketServer.listen(socket);
						await once(socketServer, 'listening');
						tcp.listen(0, '127.0.0.1');
						await once(tcp, 'listening');

						const address = tcp.address();

						if (!address || typeof address === 'string') {
							throw new Error('No TCP fixture port');
						}

						const connect = (destination: object) =>
							`const s=require('node:net').createConnection(${JSON.stringify(destination)});s.on('data',data=>process.stdout.write(data));s.on('error',e=>{process.stderr.write(e.code);process.exitCode=1;});`;
						const unixProbe = connect({ path: socket });
						const ipProbe = connect({ host: '127.0.0.1', port: address.port });

						for (const script of [unixProbe, ipProbe]) {
							const control = await execute(process.execPath, ['-e', script], {
								timeout: 3000
							});

							expect(control.stdout).toBe('reachable');
						}

						const shell = async (command: string) =>
							sandbox.exec({ kind: 'shell', dialect: 'sh', command });

						await symlink(secret, path.join(workspace, 'alias'));
						await expect(sandbox.files.readFile('alias')).rejects.toMatchObject(
							{ name: 'SandboxPermissionDeniedError' }
						);
						await expect(
							sandbox.files.readFile('missing')
						).rejects.toMatchObject({ name: 'SandboxPathNotFoundError' });

						const unix = await shell(nodeCommand(unixProbe));
						const ip = await shell(nodeCommand(ipProbe));

						expect(
							[unix, ip].map((probe) => Buffer.from(probe.stderr).toString())
						).toStrictEqual(['EPERM', 'EPERM']);

						const write = await shell('printf data > sample');

						expect({
							unix: unix.exit,
							ip: ip.exit,
							write: write.exit.kind === 'code' && write.exit.code === 0,
							secret: await readFile(secret, 'utf8')
						}).toStrictEqual({
							unix: { kind: 'code', code: 1 },
							ip: { kind: 'code', code: 1 },
							write: workspaceAccess === 'read-write',
							secret: 'outside'
						});
					} finally {
						socketServer.close();
						tcp.close();
					}
				},
				{
					requirements: {
						...requirements,
						policy: { ...requirements.policy, workspaceAccess }
					}
				}
			);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	}
);
