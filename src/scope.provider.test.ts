import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { ProcessResult } from 'pi-bring-your-own-sandbox/api';
import {
	getSandbox,
	initialiseSandboxHost
} from 'pi-bring-your-own-sandbox/api';
import { assert, expect, it } from 'vitest';

import mxc from './extension.js';
import { CommandChecks } from './fixtures/command-checks.js';
import { nodeReadonlyPaths } from './fixtures/node-runtime.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { ScopedChild } from './fixtures/scoped-child.js';

const nodePaths = await nodeReadonlyPaths();

async function observeExecution(
	running: Promise<ProcessResult>
): Promise<
	| { readonly kind: 'resolved'; readonly result: ProcessResult }
	| { readonly kind: 'rejected'; readonly error: unknown }
> {
	try {
		return { kind: 'resolved', result: await running };
	} catch (error) {
		return { kind: 'rejected', error };
	}
}

it('preserves the declared boundary when a waiting child changes session across disposal', async () => {
	const canaries = await mkdtemp(path.join(tmpdir(), 'pi-byos-mxc-scope-'));
	const outside = path.join(canaries, 'outside');
	const readonly = path.join(canaries, 'readonly');
	const checks = new CommandChecks();
	let agentDirectory = '';
	let probe: ScopedChild | undefined;
	let oldRoot: string | undefined;
	let oldBackend: string | undefined;

	await writeFile(outside, 'private');
	await writeFile(readonly, 'read-only');

	try {
		await withPiRuntime(
			[
				{
					name: 'host',
					factory(pi) {
						initialiseSandboxHost(pi, { agentDirectory });
					}
				},
				{ name: 'mxc', factory: mxc },
				{
					name: 'scope-consumer',
					factory(pi) {
						pi.registerCommand('verify-scope', {
							description:
								'Verify scoped termination across session replacement.',
							handler: (phase, context) =>
								checks.run(async () => {
									const sandbox = await getSandbox(pi, context, {
										terminationScope: 'process-group',
										timeoutMs: 10_000
									});

									if (phase === 'next') {
										expect({
											scope: sandbox.capabilities.terminationScope,
											reused: sandbox.backendId === oldBackend
										}).toStrictEqual({ scope: 'process-group', reused: false });

										return;
									}

									expect(phase).toBe('start');
									assert.isDefined(probe);
									assert.isDefined(sandbox.workspace.home);

									oldRoot = path.dirname(sandbox.workspace.home);
									oldBackend = sandbox.backendId;

									const controller = new AbortController();
									const ready = Promise.withResolvers<'ready'>();
									let output = '';

									const running = sandbox.exec(
										{ kind: 'shell', dialect: 'sh', command: probe.command },
										{
											signal: controller.signal,
											timeoutMs: 5000,
											onOutput(chunk) {
												if (chunk.stream !== 'stdout') {
													return;
												}

												output += new TextDecoder().decode(chunk.data);

												if (output.includes('ready')) {
													ready.resolve('ready');
												}
											}
										}
									);
									const completion = observeExecution(running);

									expect(await Promise.race([ready.promise, completion])).toBe(
										'ready'
									);

									const id: unknown = expect.any(Number);

									expect(await probe.liveIds()).toStrictEqual([id]);
									controller.abort();
									expect(await completion).toMatchObject({
										kind: 'rejected',
										error: {
											name: 'SandboxCancelledError',
											completion: 'confirmed'
										}
									});
								})
						});
					}
				}
			],
			async (runtime, errors) => {
				await runtime.session.prompt('/verify-scope start');
				checks.verify(1);

				assert.isDefined(oldRoot);
				assert.isDefined(probe);

				const before = await probe.snapshot();

				await runtime.newSession();
				await expect(access(oldRoot)).rejects.toMatchObject({ code: 'ENOENT' });
				await runtime.session.prompt('/verify-scope next');
				checks.verify(2);

				const live = await probe.liveIds();

				if (live.length > 0) {
					await delay(250);

					const after = await probe.snapshot();

					expect({
						continued: after.heartbeat > before.heartbeat,
						restrictions: after.restrictions
					}).toStrictEqual({
						continued: true,
						restrictions: {
							readable: 'read-only',
							readDenied: true,
							writeDenied: true
						}
					});
				}

				expect({
					errors,
					outside: await readFile(outside, 'utf8'),
					readonly: await readFile(readonly, 'utf8'),
					initialRestrictions: before.restrictions
				}).toStrictEqual({
					errors: [],
					outside: 'private',
					readonly: 'read-only',
					initialRestrictions: {
						readable: 'read-only',
						readDenied: true,
						writeDenied: true
					}
				});
			},
			{
				async prepare(workspace, personal) {
					agentDirectory = personal;
					probe = new ScopedChild(workspace, outside, readonly);
					await writeFile(
						path.join(personal, 'byos.json'),
						JSON.stringify({
							provider: 'mxc',
							providerConfig: {
								readonlyPaths: [...nodePaths, readonly]
							},
							cleanup: {
								cancellationGraceMs: 10_000,
								disposalTimeoutMs: 15_000
							}
						})
					);
				}
			}
		);
	} finally {
		try {
			await probe?.waitForExit();
		} finally {
			await rm(canaries, { recursive: true, force: true });
		}
	}
}, 45_000);
