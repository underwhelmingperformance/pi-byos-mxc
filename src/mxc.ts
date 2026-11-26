import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import registerProvider from './extension.js';
import registerTools from './pi-tools.js';

export default function mxc(pi: ExtensionAPI): void {
	registerProvider(pi, import.meta.filename);
	registerTools(pi, import.meta.filename);
}
