import { expect, it } from 'vitest';

import { InvalidFixtureSettingError } from './fixtures/errors.js';
import { nodeCommand, withNativeSandbox } from './fixtures/native-sandbox.js';
import { nodeReadonlyPaths } from './fixtures/node-runtime.js';

const nodePaths = await nodeReadonlyPaths();

it.each(['ip-denied', 'open-egress'] as const)(
	'checks external HTTPS with %s',
	async (network) => {
		const fixture = process.env.MXC_EGRESS_TEST_URL;

		if (fixture === undefined) {
			throw new InvalidFixtureSettingError(
				'MXC_EGRESS_TEST_URL',
				fixture,
				'a reachable external HTTPS fixture that returns status 200'
			);
		}

		const url = new URL(fixture);

		if (
			url.protocol !== 'https:' ||
			url.username !== '' ||
			url.password !== ''
		) {
			throw new InvalidFixtureSettingError(
				'MXC_EGRESS_TEST_URL',
				fixture,
				'an HTTPS URL without credentials'
			);
		}

		await withNativeSandbox(
			{ network, readonlyPaths: [...nodePaths] },
			async (sandbox) => {
				const script = `const r=require('node:https').get(${JSON.stringify(url.href)},s=>{s.resume();s.on('end',()=>console.log(s.statusCode));});r.setTimeout(5000,()=>r.destroy(new Error('timeout')));r.on('error',()=>console.log('blocked'));`;
				const result = await sandbox.exec(
					{ kind: 'shell', dialect: 'sh', command: nodeCommand(script) },
					{ timeoutMs: 10_000 }
				);

				expect({ ...result, durationMs: 0 }).toStrictEqual({
					exit: { kind: 'code', code: 0 },
					stdout: new TextEncoder().encode(
						network === 'open-egress' ? '200\n' : 'blocked\n'
					),
					stderr: new Uint8Array(),
					omittedBytes: { stdout: 0, stderr: 0 },
					durationMs: 0
				});
			}
		);
	}
);
