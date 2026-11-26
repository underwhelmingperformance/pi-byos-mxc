import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSandboxDiagnostics } from 'pi-bring-your-own-sandbox/host';

export default function mxcDiagnostics(pi: ExtensionAPI): void {
	registerSandboxDiagnostics(pi, import.meta.filename);
}
