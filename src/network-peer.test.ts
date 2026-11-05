import { createSocket } from 'node:dgram';

import { expect, it } from 'vitest';

import { NetworkPeer } from '../script/network-peer.js';

const token = '0123456789abcdef0123456789abcdef';
const question = Buffer.concat([
	Buffer.from('12340100000100000000000020', 'hex'),
	Buffer.from(token),
	Buffer.from('036d786304746573740000010001', 'hex')
]);

async function datagram(port: number, message: Buffer): Promise<Buffer> {
	const socket = createSocket('udp4');

	const reply = Promise.withResolvers<Buffer>();
	const timeout = setTimeout(() => {
		reply.reject(new Error('The peer did not reply.'));
	}, 1000);

	socket.once('message', (data) => {
		reply.resolve(data);
	});
	socket.once('error', (error) => {
		reply.reject(error);
	});

	try {
		socket.send(message, port, '127.0.0.1');

		return await reply.promise;
	} finally {
		clearTimeout(timeout);
		socket.close();
	}
}

it('provides TCP, UDP and DNS responses with independent counters', async () => {
	const peer = await NetworkPeer.open('127.0.0.1', { http: 0, udp: 0, dns: 0 });

	try {
		const response = await fetch(
			`http://127.0.0.1:${String(peer.ports.http)}/probe/${token}`
		);
		const udp = await datagram(peer.ports.udp, Buffer.from(token));
		const dns = await datagram(peer.ports.dns, question);
		const observed = await fetch(
			`http://127.0.0.1:${String(peer.ports.http)}/seen/${token}`
		);
		const counts: unknown = await observed.json();

		expect({
			status: response.status,
			body: await response.text(),
			udp,
			dns,
			counts
		}).toStrictEqual({
			status: 200,
			body: 'fixture',
			udp: Buffer.from(token),
			dns: Buffer.concat([
				Buffer.from('123481800001000100000000', 'hex'),
				question.subarray(12),
				Buffer.from('c00c00010001000000000004cb007107', 'hex')
			]),
			counts: { tcp: 1, udp: 1, dns: 1 }
		});
	} finally {
		await peer.close();
	}
});

it.each([
	Buffer.alloc(0),
	Buffer.alloc(12),
	Buffer.from('123401000001000000000000c00c00010001', 'hex')
])('rejects malformed DNS packets: %s', (packet) => {
	expect(NetworkPeer.dnsAnswer(packet)).toBeUndefined();
});
