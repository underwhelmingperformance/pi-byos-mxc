import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Sandbox } from 'pi-bring-your-own-sandbox/api';
import {
	getSandbox,
	initialiseSandboxHost
} from 'pi-bring-your-own-sandbox/api';
import sandboxTools from 'pi-bring-your-own-sandbox/pi-tools';
import { expect, it } from 'vitest';

import mxc from './extension.js';
import { CommandChecks } from './fixtures/command-checks.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { ScriptedModel } from './fixtures/scripted-model.js';
import { EFFECTIVE_POLICY } from './policy.js';

async function configure(
	_directory: string,
	agentDirectory: string
): Promise<void> {
	await writeFile(
		path.join(agentDirectory, 'byos.json'),
		JSON.stringify({
			provider: 'mxc',
			cleanup: { cancellationGraceMs: 10_000, disposalTimeoutMs: 15_000 }
		})
	);
}

it('uses real shell consumers and releases the old allocation on session replacement', async () => {
	let agentDirectory = '';
	let previous: Sandbox | undefined;
	let oldRoot = '';
	const checks = new CommandChecks();

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
				name: 'consumer',
				factory(pi) {
					pi.registerCommand('verify-mxc', {
						description: 'Verify the real MXC workspace.',
						async handler(_arguments, context) {
							await checks.run(async () => {
								const sandbox = await getSandbox(pi, context, {
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
										operations: ['exec'],
										processKinds: ['shell'],
										shells: ['sh', 'bash'],
										exitStatus: 'optional',
										terminationScope: 'process-group'
									}
								});
								await expect(
									getSandbox(pi, context, { processKinds: ['argv'] })
								).rejects.toMatchObject({
									name: 'UnsupportedSandboxCapabilityError'
								});
								await expect(
									getSandbox(pi, context, { terminationScope: 'workload' })
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
				agentDirectory = personal;
				await configure(directory, personal);
			}
		}
	);

	await expect(access(oldRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retains a valid default shell when the Bash probe fails', async () => {
	let agentDirectory = '';
	const checks = new CommandChecks();

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
				name: 'consumer',
				factory(pi) {
					pi.registerCommand('verify-sh', {
						description: 'Verify shell fallback metadata.',
						async handler(_arguments, context) {
							await checks.run(async () => {
								const sandbox = await getSandbox(pi, context, {
									shells: ['sh']
								});

								expect({
									capabilities: sandbox.capabilities,
									defaultShell: sandbox.workspace.defaultShell
								}).toStrictEqual({
									capabilities: {
										operations: ['exec'],
										processKinds: ['shell'],
										shells: ['sh'],
										exitStatus: 'optional',
										terminationScope: 'process-group'
									},
									defaultShell: 'sh'
								});
							});
						}
					});
				}
			}
		],
		async (runtime, errors) => {
			await runtime.session.prompt('/verify-sh');
			checks.verify(1);
			expect(errors).toStrictEqual([]);
		},
		{
			async prepare(_directory, personal) {
				agentDirectory = personal;
				await writeFile(
					path.join(personal, 'byos.json'),
					JSON.stringify({
						provider: 'mxc',
						policy: EFFECTIVE_POLICY,
						providerConfig: {
							shells: { sh: '/bin/sh', bash: '/usr/bin/false' }
						}
					})
				);
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
		expected:
			process.platform === 'darwin'
				? 'target\n\nCommand terminated without an exit code'
				: 'target\n\nCommand exited with code 143',
		isError: true
	}
])(
	'preserves Pi hooks and results for $label',
	async ({ command, isAllowed, expected, isError }) => {
		let agentDirectory = '';
		const model = new ScriptedModel([
			{ type: 'toolCall', id: 'shell', name: 'bash', arguments: { command } }
		]);
		const calls: string[] = [];

		await withPiRuntime(
			[
				{
					name: 'host',
					factory(pi) {
						initialiseSandboxHost(pi, { agentDirectory });
					}
				},
				{ name: 'mxc', factory: mxc },
				{ name: 'byos-tools', factory: sandboxTools },
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
				runtime.session.setActiveToolsByName(['bash']);

				const selected = runtime.session.modelRuntime.getModel(
					'scripted',
					'scripted'
				);

				if (selected === undefined) {
					throw new Error('The scripted model was not registered.');
				}

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
					results: [{ content: [{ type: 'text', text: expected }], isError }]
				});
			},
			{
				async prepare(directory, personal) {
					agentDirectory = personal;
					await configure(directory, personal);
				}
			}
		);
	}
);
