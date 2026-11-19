import { existsSync } from 'node:fs';
import path from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
	configureExecutionApproval,
	configureOutsideExecution,
	registerSandboxProvider
} from 'pi-bring-your-own-sandbox/api';

import { systemHost } from './host.js';
import { legacySettings } from './legacy-settings.js';
import { provider } from './provider.js';
import { readSettings, SETTINGS_FILE } from './settings.js';

export default function mxc(pi: ExtensionAPI): void {
	const directory = getAgentDir();
	let legacy: ReturnType<typeof legacySettings>;

	try {
		legacy = legacySettings(directory);

		if (legacy && existsSync(path.join(directory, SETTINGS_FILE))) {
			throw new Error(
				`Choose either byos.json or ${SETTINGS_FILE} in the Pi agent directory.`
			);
		}
	} catch (error) {
		// Throwing from the extension factory would leave BYOS free to select passthrough.
		registerSandboxProvider(pi, provider, {
			configure: () => {
				throw error;
			}
		});

		return;
	}

	if (!legacy) {
		registerSandboxProvider(pi, provider, {
			configure: () => readSettings(systemHost.fs, directory)
		});

		return;
	}

	const { approval, outsideSandbox, ...settings } = legacy;

	registerSandboxProvider(pi, provider, { configure: () => settings });

	if (approval) {
		configureExecutionApproval(pi, () => approval);
	}

	if (!outsideSandbox) {
		return;
	}

	configureOutsideExecution(pi, () => outsideSandbox);
}
