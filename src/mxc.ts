import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import registerTools from 'pi-bring-your-own-sandbox/pi-tools';

import registerProvider from './extension.js';

export default function mxc(pi: ExtensionAPI): void {
	registerProvider(pi, import.meta.filename);
	registerTools(pi, import.meta.filename);
}
