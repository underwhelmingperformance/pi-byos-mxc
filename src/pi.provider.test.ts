import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Sandbox } from 'pi-bring-your-own-sandbox/consumer';
import { createSandboxClient } from 'pi-bring-your-own-sandbox/consumer';
import { initialiseSandboxHost } from 'pi-bring-your-own-sandbox/host';
import { assert, expect, it } from 'vitest';

import mxc from './extension.js';
import { CommandChecks } from './fixtures/command-checks.js';
import { withNativeSandbox } from './fixtures/native-sandbox.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { ScriptedModel } from './fixtures/scripted-model.js';
import mxcPackage from './mxc.js';

async function configure(
	_directory: string,
	agentDirectory: string
): Promise<void> {
	await writeFile(
		path.join(agentDirectory, 'mxc-sandbox.json'),
		JSON.stringify({
			cleanup: { cancellationGraceMs: 10_000, disposalTimeoutMs: 15_000 }
		})
	);
}

it('uses real shell consumers and releases the old allocation on session replacement', async () => {
	let previous: Sandbox | undefined;
	let oldRoot = '';
	const checks = new CommandChecks();

	await withPiRuntime(
		[
			{
				name: 'host',
				factory(pi) {
					initialiseSandboxHost(pi, import.meta.filename, {});
				}
			},
			{ name: 'mxc', factory: mxc },
			{
				name: 'consumer',
				factory(pi) {
					const client = createSandboxClient(pi, import.meta.filename);

					pi.registerCommand('verify-mxc', {
						description: 'Verify the real MXC workspace.',
						async handler(_arguments, context) {
							await checks.run(async () => {
								const sandbox = await client.get(context, {
									processKinds: ['shell'],
									shells: ['bash'],
									terminationScope: 'process-group'
								});
								const result = await sandbox.exec({
									kind: 'shell',
									dialect: 'bash',
									command: 'printf shared > shared.txt; printf target'
								});
								const contents = await readFile(
									path.join(context.cwd, 'shared.txt'),
									'utf8'
								);

								expect({
									exit: result.exit,
									stdout: new TextDecoder().decode(result.stdout),
									contents,
									capabilities: sandbox.capabilities
								}).toStrictEqual({
									exit: { kind: 'code', code: 0 },
									stdout: 'target',
									contents: 'shared',
									capabilities: {
										operations: [
											'exec',
											'files.read',
											'files.list',
											'files.write',
											'search.find',
											'search.grep',
											...(process.platform === 'darwin' ? ['copy'] : [])
										],
										processKinds: ['shell'],
										shells: ['sh', 'bash'],
										exitStatus:
											process.platform === 'darwin' ? 'guaranteed' : 'optional',
										terminationScope: 'process-group'
									}
								});
								await expect(
									client.get(context, { processKinds: ['argv'] })
								).rejects.toMatchObject({
									name: 'UnsupportedSandboxCapabilityError'
								});
								await expect(
									client.get(context, { terminationScope: 'workload' })
								).rejects.toMatchObject({
									name: 'UnsupportedSandboxCapabilityError'
								});

								if (previous !== undefined) {
									await expect(
										previous.exec({
											kind: 'shell',
											dialect: 'sh',
											command: ':'
										})
									).rejects.toMatchObject({ name: 'StaleSandboxHandleError' });
									await expect(access(oldRoot)).rejects.toMatchObject({
										code: 'ENOENT'
									});
								}

								previous = sandbox;
								oldRoot = path.dirname(sandbox.workspace.home ?? '');
							});
						}
					});
				}
			}
		],
		async (runtime, errors) => {
			await runtime.session.prompt('/verify-mxc');
			await runtime.newSession();
			await runtime.session.prompt('/verify-mxc');
			checks.verify(2);
			expect(errors).toStrictEqual([]);
		},
		{
			async prepare(directory, personal) {
				await configure(directory, personal);
			}
		}
	);

	await expect(access(oldRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reports a startup error when the Bash probe exits non-zero', async () => {
	await withNativeSandbox(
		{ shells: { sh: '/bin/sh', bash: '/usr/bin/false' } },
		() => expect.unreachable(),
		{
			async verifyOpening(opening) {
				await expect(opening).rejects.toMatchObject({
					name: 'SandboxStartupError',
					cause: { cause: { name: 'ShellStartupError' } }
				});
			}
		}
	);
});

it.each([
	{
		label: 'approved shell',
		command: 'printf target',
		isAllowed: true,
		expected: 'target',
		isError: false
	},
	{
		label: 'denied shell',
		command: 'printf target',
		isAllowed: false,
		expected: 'Denied by the fixture.',
		isError: true
	},
	{
		label: 'signal-terminated shell',
		command: 'printf target; kill -TERM $$',
		isAllowed: true,
		expected: 'target\n\nCommand exited with code 143',
		isError: true
	}
])(
	'preserves Pi hooks and results for $label',
	async ({ command, isAllowed, expected, isError }) => {
		const model = new ScriptedModel([
			{ type: 'toolCall', id: 'shell', name: 'bash', arguments: { command } }
		]);
		const calls: string[] = [];

		await withPiRuntime(
			[
				{
					name: 'host',
					factory(pi) {
						initialiseSandboxHost(pi, import.meta.filename, {});
					}
				},
				{ name: 'mxc', factory: mxcPackage },
				model.extension,
				{
					name: 'approval',
					factory(pi) {
						pi.on('tool_call', (event) => {
							calls.push(event.toolName);

							return isAllowed
								? undefined
								: { block: true, reason: 'Denied by the fixture.' };
						});
					}
				}
			],
			async (runtime, errors) => {
				const selected = runtime.session.modelRuntime.getModel(
					'scripted',
					'scripted'
				);

				assert.isDefined(selected);

				await runtime.session.setModel(selected);
				await runtime.session.prompt('Run the shell.');

				const results = model.requests
					.at(1)
					?.messages.filter((message) => message.role === 'toolResult')
					.map((message) => ({
						content: message.content,
						isError: message.isError
					}));

				expect({ errors, calls, results }).toStrictEqual({
					errors: [],
					calls: ['bash'],
					results: [
						{
							content: [
								{ type: 'text', text: expected },
								...(isAllowed
									? [
											{
												type: 'text',
												text: 'Effective restrictions: Host workspace writes allowed, network denied, host user data denied, host system files read-only'
											}
										]
									: [])
							],
							isError
						}
					]
				});
			},
			{
				includeBuiltins: true,
				async prepare(directory, personal) {
					await configure(directory, personal);
				}
			}
		);
	}
);
