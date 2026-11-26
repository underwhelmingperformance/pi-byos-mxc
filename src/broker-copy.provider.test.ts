import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSandboxClient } from 'pi-bring-your-own-sandbox/consumer';
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
						const client = createSandboxClient(pi, import.meta.filename);

						pi.on('tool_call', (event, context) =>
							checks.run(async () => {
								const lookup = client.findShellReviewSource(context, event);

								assert(lookup.ok);

								const open = lookup.source;
								const negotiation = await open.negotiateCopy({
									access: {
										hostWorkspaceWrites: 'prevented',
										network: 'prevented'
									}
								});

								expect(negotiation.ok).toBe(true);

								const signal = new AbortController().signal;

								await expect(
									open.copy({
										signal,
										access: { hostSystemFiles: 'prevented' }
									})
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
										policy: review.sandbox.policy.hostSystemFiles,
										relationship: review.sandbox.workspace.relationship,
										text: Buffer.from(evidence.stdout).toString()
									}).toStrictEqual({
										policy: 'read-only',
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
					result: [
						{ type: 'text', text: 'edited' },
						{
							type: 'text',
							text: 'Effective restrictions: Host workspace writes allowed, network denied, host user data denied, host system files read-only'
						}
					],
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
