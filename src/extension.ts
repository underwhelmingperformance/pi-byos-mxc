import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSandboxProvider } from 'pi-bring-your-own-sandbox/api';

import { provider } from './provider.js';

export default function mxc(pi: ExtensionAPI): void {
	registerSandboxProvider(pi, provider);
}
