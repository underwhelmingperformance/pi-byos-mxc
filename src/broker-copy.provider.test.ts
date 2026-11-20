import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Sandbox } from 'pi-bring-your-own-sandbox/api';
import { getSandbox, negotiateSandbox } from 'pi-bring-your-own-sandbox/api';
import { assert, expect, it } from 'vitest';

import { CommandChecks } from './fixtures/command-checks.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { ScriptedModel } from './fixtures/scripted-model.js';

it.runIf(process.platform === 'darwin')(
	'opens a private review for a pending shell call from the installed MXC package',
	async () => {
		const model = new ScriptedModel([
			{
				type: 'toolCall',
				id: 'shell',
				name: 'bash',
				arguments: { command: 'cat notes' }
			}
		]);
		const checks = new CommandChecks();

		await withPiRuntime(
			[
				model.extension,
				{
					name: 'reviewer',
					factory(pi) {
						pi.on('tool_call', (event, context) =>
							checks.run(async () => {
								const shared = await getSandbox(pi, context, {
									workspaceRelationship: 'shared'
								});
								const copied = await negotiateSandbox(pi, context, {
									workspaceRelationship: 'copied'
								});

								expect({
									ordinary: shared.workspace.relationship,
									copied: copied.ok
								}).toStrictEqual({ ordinary: 'shared', copied: false });

								const routes: Pick<Sandbox, 'copy'>[] = [];

								pi.events.emit('pi-byos:review:tool-call:v2', {
									sessionId: context.sessionManager.getSessionId(),
									toolName: event.toolName,
									toolCallId: event.toolCallId,
									reply: (open: Pick<Sandbox, 'copy'>) => {
										routes.push(open);
									}
								});

								const [open] = routes;

								expect(routes).toHaveLength(1);
								assert.isDefined(open);

								const signal = new AbortController().signal;

								await expect(
									open.copy({ signal, guarantees: ['no-host-system-files'] })
								).rejects.toMatchObject({
									name: 'UnsupportedSandboxPolicyError'
								});

								const review = await open.copy({ signal });

								try {
									await writeFile(path.join(context.cwd, 'notes'), 'edited');

									const evidence = await review.sandbox.exec({
										kind: 'shell',
										dialect: 'sh',
										command: 'cat notes'
									});

									expect({
										policy: review.sandbox.policy.filesystemScope,
										relationship: review.sandbox.workspace.relationship,
										text: Buffer.from(evidence.stdout).toString()
									}).toStrictEqual({
										policy: 'system-read-only',
										relationship: 'copied',
										text: 'draft'
									});
								} finally {
									const report = await review.close();

									expect(report.confirmed).toBe(true);
								}
							})
						);
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
				await runtime.session.prompt('Read the notes.');
				checks.verify(1);

				const result = model.requests
					.at(1)
					?.messages.find((message) => message.role === 'toolResult');

				expect({ result: result?.content, errors }).toStrictEqual({
					result: [{ type: 'text', text: 'edited' }],
					errors: []
				});
			},
			{
				includeBuiltins: true,
				extensionPaths: [fileURLToPath(new URL('..', import.meta.url))],
				prepare: (workspace) =>
					writeFile(path.join(workspace, 'notes'), 'draft')
			}
		);
	}
);
