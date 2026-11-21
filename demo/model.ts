import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall
} from '@earendil-works/pi-ai/providers/faux';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function demoModel(pi: ExtensionAPI): void {
	const model = createFauxCore({
		provider: 'demo',
		models: [{ id: 'scripted', name: 'Scripted demo' }]
	});

	model.setResponses([
		fauxAssistantMessage(
			fauxToolCall('edit', {
				path: 'CHANGELOG.md',
				edits: [{ oldText: 'CSV export (preview)', newText: 'CSV export' }]
			}),
			{ stopReason: 'toolUse' }
		),
		({ messages }) => {
			const result = messages.at(-1);

			if (result?.role !== 'toolResult' || result.isError) {
				throw new Error('The changelog edit failed.');
			}

			return fauxAssistantMessage('Updated CHANGELOG.md.');
		},
		fauxAssistantMessage(
			fauxToolCall('edit', {
				path: '.envrc',
				edits: [{ oldText: 'CHANNEL=preview', newText: 'CHANNEL=stable' }]
			}),
			{ stopReason: 'toolUse' }
		),
		({ messages }) => {
			const result = messages.at(-1);

			if (
				result?.role !== 'toolResult' ||
				!result.isError ||
				result.content.every(
					(block) => !(block.type === 'text' && block.text.includes('EPERM'))
				)
			) {
				throw new Error('Expected the sandbox to refuse the .envrc edit.');
			}

			return fauxAssistantMessage(
				'MXC blocked the edit. The shell configuration is protected.'
			);
		}
	]);

	pi.registerProvider('demo', {
		api: model.api,
		apiKey: 'demo',
		baseUrl: model.models[0].baseUrl,
		models: model.models,
		streamSimple: model.streamSimple
	});
}
