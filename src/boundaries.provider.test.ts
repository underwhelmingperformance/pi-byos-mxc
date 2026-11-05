import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { nodeCommand, withNativeSandbox } from './fixtures/native-sandbox.js';

const nodeConfig = { readonlyPaths: [path.dirname(process.execPath)] };
const execute = promisify(execFile);

it('drains binary output beyond the shared capture limit', async () => {
	await withNativeSandbox(nodeConfig, async (sandbox) => {
		let streamed = 0;
		const result = await sandbox.exec(
			{
				kind: 'shell',
				dialect: 'sh',
				command: nodeCommand('process.stdout.write(Buffer.alloc(70000,255))')
			},
			{
				maxCaptureBytes: 128,
				onOutput(chunk) {
					streamed += chunk.data.byteLength;
				}
			}
		);

		expect({ result: { ...result, durationMs: 0 }, streamed }).toStrictEqual({
			result: {
				exit: { kind: 'code', code: 0 },
				stdout: new Uint8Array(128).fill(255),
				stderr: new Uint8Array(),
				omittedBytes: { stdout: 69_872, stderr: 0 },
				durationMs: 0
			},
			streamed: 70_000
		});
	});
});

it('keeps confirmed output-callback cancellation distinct from lost termination', async () => {
	await withNativeSandbox({}, async (sandbox) => {
		await expect(
			sandbox.exec(
				{ kind: 'shell', dialect: 'sh', command: 'printf ready; sleep 5' },
				{
					onOutput() {
						throw new Error('Stop the consumer.');
					}
				}
			)
		).rejects.toMatchObject({
			name: 'SandboxOutputCallbackError',
			completion: 'confirmed'
		});

		const result = await sandbox.exec({
			kind: 'shell',
			dialect: 'sh',
			command: ':'
		});

		expect(result.exit).toStrictEqual({ kind: 'code', code: 0 });
	});
});

it.each(['', '>/dev/null 2>&1'])(
	'stops same-group descendants after normal shell exit: %s',
	async (redirection) => {
		await withNativeSandbox({}, async (sandbox, workspace) => {
			await sandbox.exec({
				kind: 'shell',
				dialect: 'sh',
				command: `sleep 5 ${redirection} & printf '%s' "$!" > descendant.pid; exit 0`
			});

			const saved = await readFile(
				path.join(workspace, 'descendant.pid'),
				'utf8'
			);

			try {
				const result = await execute(
					'/bin/ps',
					['-p', saved.trim(), '-o', 'stat='],
					{ timeout: 1000 }
				);

				expect(result.stdout.trimStart().startsWith('Z')).toBe(true);
			} catch (error) {
				if (!(error instanceof Error && 'code' in error && error.code === 1)) {
					throw error;
				}
			}
		});
	}
);

it('does not convert a target HOME override into a writable host grant', async () => {
	const outside = await mkdtemp(path.join(tmpdir(), 'pi-byos-mxc-sentinel-'));
	const sentinel = path.join(outside, 'sentinel');

	await writeFile(sentinel, 'unchanged');

	try {
		await withNativeSandbox({}, async (sandbox) => {
			const result = await sandbox.exec({
				kind: 'shell',
				dialect: 'sh',
				command: 'printf changed > "$HOME/sentinel"',
				env: { HOME: outside }
			});
			const denied: unknown = expect.stringContaining('sentinel');

			expect({
				result: {
					...result,
					durationMs: 0,
					exit:
						result.exit.kind === 'code' && result.exit.code > 0
							? 'nonzero'
							: result.exit,
					stderr: new TextDecoder().decode(result.stderr)
				},
				contents: await readFile(sentinel, 'utf8')
			}).toStrictEqual({
				result: {
					exit: 'nonzero',
					stdout: new Uint8Array(),
					stderr: denied,
					omittedBytes: { stdout: 0, stderr: 0 },
					durationMs: 0
				},
				contents: 'unchanged'
			});
		});
	} finally {
		await rm(outside, { recursive: true, force: true });
	}
});

it('blocks direct host-loopback TCP despite a host-reachable listener', async () => {
	const server = createServer((socket) => {
		socket.end();
	});

	const listening = once(server, 'listening');

	server.listen(0, '127.0.0.1');
	await listening;

	const address = server.address();

	if (typeof address !== 'object' || !address) {
		throw new Error('The TCP fixture did not open a port.');
	}

	try {
		await new Promise<void>((resolve, reject) => {
			const socket = createConnection(
				{ host: '127.0.0.1', port: address.port },
				() => {
					socket.end();
					resolve();
				}
			);

			socket.on('error', reject);
		});
		await withNativeSandbox(nodeConfig, async (sandbox) => {
			const script = `const net=require('node:net');const s=net.createConnection({host:'127.0.0.1',port:${String(address.port)}});s.once('connect',()=>{console.log('connected');s.end();});s.once('error',()=>console.log('blocked'));s.setTimeout(1000,()=>{s.destroy();console.log('blocked');});`;
			const result = await sandbox.exec({
				kind: 'shell',
				dialect: 'sh',
				command: nodeCommand(script)
			});

			expect({ ...result, durationMs: 0 }).toStrictEqual({
				exit: { kind: 'code', code: 0 },
				stdout: new TextEncoder().encode('blocked\n'),
				stderr: new Uint8Array(),
				omittedBytes: { stdout: 0, stderr: 0 },
				durationMs: 0
			});
		});
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);

					return;
				}

				resolve();
			});
		});
	}
});

it('discloses the filesystem-accessible UNIX socket relay exception', async () => {
	await withNativeSandbox(nodeConfig, async (sandbox, workspace) => {
		const socketPath = path.join(workspace, 'relay.sock');
		const server = createServer((socket) => socket.end('relay'));
		const listening = once(server, 'listening');

		server.listen(socketPath);
		await listening;

		try {
			const script = `const s=require('node:net').createConnection(${JSON.stringify(socketPath)});s.on('data',d=>process.stdout.write(d));s.on('error',e=>{console.error(e.message);process.exitCode=1;});`;
			const result = await sandbox.exec({
				kind: 'shell',
				dialect: 'sh',
				command: nodeCommand(script)
			});

			expect({ ...result, durationMs: 0 }).toStrictEqual({
				exit: { kind: 'code', code: 0 },
				stdout: new TextEncoder().encode('relay'),
				stderr: new Uint8Array(),
				omittedBytes: { stdout: 0, stderr: 0 },
				durationMs: 0
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);

						return;
					}

					resolve();
				});
			});
		}
	});
});
