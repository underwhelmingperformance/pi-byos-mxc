import { expect, it } from 'vitest';

import { withNativeSandbox } from './fixtures/native-sandbox.js';
import { systemHost } from './host.js';
import { resolverSockets } from './platform/system-paths.js';
import { quote } from './shell.js';

const sockets = await resolverSockets(process.platform, systemHost.fs);

it.skipIf(sockets.length === 0)(
	'hides the host resolver sockets that MXC mounts',
	async () => {
		await withNativeSandbox({}, async (sandbox) => {
			const checks = sockets
				.map(
					(socket) =>
						String.raw`[ -S ${quote(socket)} ] && printf '%s\n' ${quote(socket)}`
				)
				.join('; ');
			const result = await sandbox.exec({
				kind: 'shell',
				dialect: 'sh',
				command: `${checks}; true`
			});

			expect({
				exit: result.exit,
				reachable: new TextDecoder().decode(result.stdout)
			}).toStrictEqual({ exit: { kind: 'code', code: 0 }, reachable: '' });
		});
	}
);
