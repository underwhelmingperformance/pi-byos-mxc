import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition
} from '@earendil-works/pi-coding-agent';
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition
} from '@earendil-works/pi-coding-agent';
import { getSandbox } from 'pi-bring-your-own-sandbox/api';
import shellTools from 'pi-bring-your-own-sandbox/pi-tools';
import type { TSchema } from 'typebox';

import { editResult, toolResult } from './pi-tool-results.js';
import { quote } from './shell.js';

const worker = fileURLToPath(
	new URL('../dist/tools/worker.js', import.meta.url)
);

class PiTools {
	readonly #pi: ExtensionAPI;
	#context: ExtensionContext | undefined;
	#mutations: Promise<void> = Promise.resolve();

	constructor(pi: ExtensionAPI) {
		this.#pi = pi;
		pi.on('session_start', (_event, context) => {
			this.#context = context;
		});
		pi.on('session_shutdown', () => {
			this.#context = undefined;
		});
	}

	async #execute(
		name: string,
		input: unknown,
		context: ExtensionContext,
		signal?: AbortSignal
	): Promise<unknown> {
		const isMutation = name === 'write' || name === 'edit';
		const sandbox = await getSandbox(this.#pi, context, {
			capabilities: isMutation ? ['exec', 'files.write'] : ['exec'],
			shells: ['sh']
		});

		if (sandbox.providerId !== 'mxc') {
			throw new Error(
				'Select the MXC provider to use its Pi file and search tools.'
			);
		}

		const json = JSON.stringify({
			name,
			input,
			autoResizeImages: this.#pi.getSettings().images?.autoResize ?? true,
			...(context.model && {
				model: {
					input: context.model.input,
					inputLimits: context.model.inputLimits
				}
			})
		});
		const options = signal ? { signal } : {};
		let payload = json;
		let source = 'json';

		if (isMutation || name === 'preview' || Buffer.byteLength(json) > 32_768) {
			if (!sandbox.workspace.home) {
				throw new Error('MXC supplied no private scratch directory.');
			}

			payload = path.join(sandbox.workspace.home, randomUUID());
			await sandbox.files.writeFile(payload, Buffer.from(json), options);
			source = 'file';
		}

		const chunks: Buffer[] = [];
		const result = await sandbox.exec(
			{
				kind: 'shell',
				dialect: 'sh',
				command: `exec ${quote(process.execPath)} ${quote(worker)} ${source} ${quote(payload)}`,
				env: {
					PI_PACKAGE_DIR: path.dirname(worker),
					NODE_OPTIONS: '',
					NODE_PATH: ''
				}
			},
			{
				...options,
				onOutput({ stream, data }) {
					if (stream === 'stdout') {
						chunks.push(Buffer.from(data));
					}
				}
			}
		);

		if (result.exit.kind !== 'code' || result.exit.code !== 0) {
			throw new Error(
				Buffer.from(result.stderr).toString() ||
					`The sandbox could not run Pi's ${name} tool.`
			);
		}

		return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
	}

	async run(
		name: string,
		input: unknown,
		context: ExtensionContext,
		signal?: AbortSignal
	): Promise<unknown> {
		const execute = () => this.#execute(name, input, context, signal);

		if (name !== 'edit' && name !== 'write') {
			return execute();
		}

		const previous = this.#mutations;
		const turn = Promise.withResolvers<undefined>();

		this.#mutations = turn.promise;
		await previous;

		try {
			return await execute();
		} finally {
			turn.resolve(undefined);
		}
	}

	register<T extends TSchema, D>(
		definition: ToolDefinition<T, D>,
		parse: (
			data: unknown
		) => Awaited<ReturnType<ToolDefinition<T, D>['execute']>>
	) {
		this.#pi.registerTool({
			...definition,
			defaultActive: false,
			execute: async (_id, input, signal, _update, context) =>
				parse(await this.run(definition.name, input, context, signal))
		});
	}

	registerEdit() {
		const definition = createEditToolDefinition('/unused');
		const render = definition.renderCall;

		if (render) {
			definition.renderCall = (arguments_, theme, context) => {
				const component = render(arguments_, theme, {
					...context,
					argsComplete: false
				});
				const call = context.state.callComponent;

				if (
					!this.#context ||
					!context.argsComplete ||
					!call?.previewArgsKey ||
					call.preview ||
					call.previewPending
				) {
					return component;
				}

				const key = call.previewArgsKey;

				call.previewPending = true;
				void this.run('preview', arguments_, this.#context)
					.then(editResult)
					.then(({ details }) => ({
						diff: details.diff,
						firstChangedLine: details.firstChangedLine
					}))
					.catch((error: unknown) => ({
						error:
							error instanceof Error ? error.message : 'Edit preview failed.'
					}))
					.then((preview) => {
						if (
							!(call.previewArgsKey === key && call.previewPending) ||
							call.preview
						) {
							return;
						}

						call.preview = preview;
						call.previewPending = false;
						context.invalidate();
					});

				return component;
			};
		}

		this.#pi.registerTool({
			...definition,
			defaultActive: false,
			execute: async (_id, input, signal, _update, context) =>
				editResult(await this.run('edit', input, context, signal))
		});
	}
}

export default function mxcTools(pi: ExtensionAPI): void {
	shellTools(pi);

	const tools = new PiTools(pi);

	tools.register(createReadToolDefinition('/unused'), toolResult);
	tools.register(createWriteToolDefinition('/unused'), (data) => ({
		...toolResult(data),
		details: undefined
	}));
	tools.registerEdit();
	tools.register(createLsToolDefinition('/unused'), toolResult);
	tools.register(createFindToolDefinition('/unused'), toolResult);
	tools.register(createGrepToolDefinition('/unused'), toolResult);
}
