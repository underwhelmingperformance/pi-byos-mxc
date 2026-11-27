import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { registerSandboxProviderFactory } from 'pi-bring-your-own-sandbox/provider';

import type { MxcConfig, MxcSettings } from './config.js';
import { systemHost } from './host.js';
import { createProvider, providerDeclaration } from './provider.js';
import { readSettings } from './settings.js';

export default function mxc(
	pi: ExtensionAPI,
	extensionSource = import.meta.filename
): void {
	registerSandboxProviderFactory<MxcConfig, MxcSettings>(
		pi,
		extensionSource,
		providerDeclaration(),
		createProvider,
		{
			configure: (_context, sharedSettingsSchema) =>
				readSettings(systemHost.fs, getAgentDir(), sharedSettingsSchema)
		}
	);
}
