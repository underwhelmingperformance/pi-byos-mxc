import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { InvalidFixtureSettingError } from './fixtures/errors.js';
import { nodeCommand, withNativeSandbox } from './fixtures/native-sandbox.js';
import { nodeReadonlyPaths } from './fixtures/node-runtime.js';

const nodePaths = await nodeReadonlyPaths();

type Protocol = 'tcp' | 'udp' | 'dns' | 'dig';
type Network = 'ip-denied' | 'open-egress';

const execute = promisify(execFile);
const protocols: readonly Protocol[] =
	process.platform === 'darwin'
		? ['tcp', 'udp', 'dns', 'dig']
		: ['tcp', 'udp', 'dns'];
const cases = (['ip-denied', 'open-egress'] as const).flatMap((network) =>
	protocols.map((protocol) => ({ network, protocol }))
);

// Seatbelt checks receives on an unconnected UDP socket against
// network-inbound, which MXC denies with ingress. Apple's dig sends its query
// from such a socket, so the query reaches the peer but the reply is refused.
function outcome(network: Network, protocol: Protocol): string {
	if (network === 'ip-denied') {
		return 'blocked';
	}

	return protocol === 'dig' ? 'receive-denied' : 'received';
}

function script(
	host: string,
	protocol: Exclude<Protocol, 'dig'>,
	token: string
): string {
	const peer = JSON.stringify(host);
	const nonce = JSON.stringify(token);

	if (protocol === 'tcp') {
		return `const r=require('node:http').get({host:${peer},port:18080,path:'/probe/'+${nonce},agent:false},s=>{s.resume();s.on('end',()=>console.log(s.statusCode===200?'received':'bad-status'));});r.setTimeout(1000,()=>r.destroy(new Error('timeout')));r.on('error',()=>console.log('blocked'));`;
	}

	if (protocol === 'udp') {
		return `const d=require('node:dgram').createSocket('udp4');let done=false;const finish=s=>{if(done)return;done=true;console.log(s);clearTimeout(t);d.close();};const t=setTimeout(()=>finish('blocked'),1000);d.on('error',()=>finish('blocked'));d.on('message',b=>finish(b.toString()===${nonce}?'received':'bad-echo'));d.send(Buffer.from(${nonce}),18081,${peer},e=>{if(e)finish('blocked');});`;
	}

	return `const d=new(require('node:dns').Resolver)({timeout:1000,tries:1});d.setServers([${peer}+':18082']);d.resolve4(${nonce}+'.mxc.test',(e,a)=>console.log(e?'blocked':JSON.stringify(a)==='["203.0.113.7"]'?'received':'bad-answer'));`;
}

function command(host: string, protocol: Protocol, token: string): string {
	if (protocol === 'dig') {
		return String.raw`output="$(/usr/bin/dig @${host} -p 18082 ${token}.mxc.test A +short +time=1 +tries=1 2>&1)"; case "$output" in '203.0.113.7') printf 'received\n' ;; *'communications error'*'permission denied'*) printf 'receive-denied\n' ;; *) printf 'blocked\n' ;; esac`;
	}

	if (process.platform !== 'darwin') {
		return nodeCommand(script(host, protocol, token));
	}

	const probes = {
		tcp: `/usr/bin/curl --noproxy '*' -fsS --max-time 2 http://${host}:18080/probe/${token}`,
		udp: `printf '%s' ${token} | /usr/bin/nc -u -w 1 ${host} 18081`,
		dns: `/usr/bin/dig +tcp @${host} -p 18082 ${token}.mxc.test A +short +time=1 +tries=1`
	};
	const expected = { tcp: 'fixture', udp: token, dns: '203.0.113.7' };

	return String.raw`if [ "$( ${probes[protocol]} 2>/dev/null )" = '${expected[protocol]}' ]; then printf 'received\n'; else printf 'blocked\n'; fi`;
}

function counts(protocol?: Protocol) {
	return {
		tcp: protocol === 'tcp' ? 1 : 0,
		udp: protocol === 'udp' ? 1 : 0,
		dns: protocol === 'dns' || protocol === 'dig' ? 1 : 0
	};
}

async function observations(host: string, token: string): Promise<unknown> {
	const result = await execute(
		process.platform === 'darwin' ? '/usr/bin/curl' : 'curl',
		[
			'--noproxy',
			'*',
			'-fsS',
			'--max-time',
			'3',
			`http://${host}:18080/seen/${token}`
		],
		{ timeout: 5000, maxBuffer: 4096 }
	);

	const observed: unknown = JSON.parse(result.stdout);

	return observed;
}

async function positive(host: string, protocol: Protocol): Promise<void> {
	const token = randomUUID().replaceAll('-', '');
	const result = await execute(
		'/bin/sh',
		['-c', command(host, protocol, token)],
		{
			timeout: 5000,
			maxBuffer: 4096
		}
	);

	expect({ stdout: result.stdout, stderr: result.stderr }).toStrictEqual({
		stdout: 'received\n',
		stderr: ''
	});
	expect(await observations(host, token)).toStrictEqual(counts(protocol));
}

it.each(cases)(
	'checks observed IPv4 $protocol egress with $network',
	async ({ network, protocol }) => {
		const host = process.env.MXC_MATRIX_HOST;

		if (host === undefined || isIP(host) !== 4 || host.startsWith('127.')) {
			throw new InvalidFixtureSettingError(
				'MXC_MATRIX_HOST',
				host,
				'a distinct IPv4 peer with the controlled TCP/UDP/DNS fixture'
			);
		}

		await positive(host, protocol);

		const token = randomUUID().replaceAll('-', '');

		await withNativeSandbox(
			{
				network,
				readonlyPaths: [...nodePaths]
			},
			async (sandbox) => {
				const result = await sandbox.exec(
					{
						kind: 'shell',
						dialect: 'sh',
						command: command(host, protocol, token)
					},
					{ timeoutMs: 5000 }
				);

				const observed = await observations(host, token);

				await positive(host, protocol);
				expect({
					result: { ...result, durationMs: 0 },
					observed
				}).toStrictEqual({
					result: {
						exit: { kind: 'code', code: 0 },
						stdout: new TextEncoder().encode(`${outcome(network, protocol)}\n`),
						stderr: new Uint8Array(),
						omittedBytes: { stdout: 0, stderr: 0 },
						durationMs: 0
					},
					observed: counts(network === 'open-egress' ? protocol : undefined)
				});
			}
		);
	}
);
