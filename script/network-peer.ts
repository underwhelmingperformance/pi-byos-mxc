import type { Socket } from 'node:dgram';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { isIP } from 'node:net';

interface Ports {
	readonly http: number;
	readonly udp: number;
	readonly dns: number;
}

interface Counts {
	readonly tcp: number;
	readonly udp: number;
	readonly dns: number;
}

type Protocol = keyof Counts;

const defaultPorts: Ports = { http: 18_080, udp: 18_081, dns: 18_082 };
const tokenPattern = /^[0-9a-f]{32}$/;

export class NetworkPeer {
	static async open(
		host: string,
		ports: Ports = defaultPorts
	): Promise<NetworkPeer> {
		if (host === '0.0.0.0' || isIP(host) !== 4) {
			throw new Error('Use a specific IPv4 bind address.');
		}

		const peer = new NetworkPeer();
		const http = once(peer.#http, 'listening');

		peer.#http.listen(ports.http, host);

		const results = await Promise.allSettled([
			http,
			peer.#bind(peer.#udp, host, ports.udp),
			peer.#bind(peer.#dns, host, ports.dns)
		]);
		const failure = results.find((result) => result.status === 'rejected');

		if (failure !== undefined) {
			await peer.close();

			throw new Error('The network peer could not open its listeners.', {
				cause: failure.reason
			});
		}

		return peer;
	}

	static dnsAnswer(
		packet: Buffer
	): { readonly token: string; readonly reply: Buffer } | undefined {
		if (
			packet.length < 12 ||
			packet.length > 512 ||
			packet.readUInt16BE(4) !== 1 ||
			(packet.readUInt16BE(2) & 0x80_00) !== 0
		) {
			return;
		}

		const labels: string[] = [];
		let offset = 12;

		while (offset < packet.length) {
			const size = packet.readUInt8(offset);

			offset++;

			if (size === 0) {
				break;
			}

			if (size > 63 || offset + size >= packet.length) {
				return;
			}

			labels.push(packet.subarray(offset, offset + size).toString('ascii'));
			offset += size;
		}

		const token = labels[0];

		if (
			token === undefined ||
			!tokenPattern.test(token) ||
			labels.length !== 3 ||
			labels[1] !== 'mxc' ||
			labels[2] !== 'test' ||
			offset + 4 > packet.length ||
			packet.readUInt16BE(offset) !== 1 ||
			packet.readUInt16BE(offset + 2) !== 1
		) {
			return;
		}

		const header = Buffer.from('000081800001000100000000', 'hex');

		packet.copy(header, 0, 0, 2);

		return {
			token,
			reply: Buffer.concat([
				header,
				packet.subarray(12, offset + 4),
				Buffer.from('c00c00010001000000000004cb007107', 'hex')
			])
		};
	}

	readonly #seen = new Map<string, Counts>();
	readonly #bound = new Set<Socket>();
	readonly #http = createServer((request, response) => {
		this.#request(request, response);
	});
	readonly #udp = createSocket('udp4');
	readonly #dns = createSocket('udp4');
	#closing: Promise<void> | undefined;

	private constructor() {
		this.#udp.on('message', (message, remote) => {
			this.#record(message.toString('ascii'), 'udp');
			this.#udp.send(message, remote.port, remote.address);
		});
		this.#dns.on('message', (message, remote) => {
			const answer = NetworkPeer.dnsAnswer(message);

			if (answer === undefined) {
				return;
			}

			this.#record(answer.token, 'dns');
			this.#dns.send(answer.reply, remote.port, remote.address);
		});
	}

	async #bind(socket: Socket, host: string, port: number): Promise<void> {
		const listening = once(socket, 'listening');

		socket.bind(port, host);
		await listening;
		this.#bound.add(socket);
	}

	async #close(): Promise<void> {
		const closing = [...this.#bound].map(
			(socket) =>
				new Promise<void>((resolve) => {
					socket.close(() => {
						resolve();
					});
				})
		);

		if (this.#http.listening) {
			closing.push(
				new Promise((resolve) => {
					this.#http.close(() => {
						resolve();
					});
					this.#http.closeAllConnections();
				})
			);
		}

		await Promise.all(closing);
	}

	#record(token: string, protocol: Protocol): void {
		if (
			!tokenPattern.test(token) ||
			(!this.#seen.has(token) && this.#seen.size >= 4096)
		) {
			return;
		}

		const counts = this.#seen.get(token) ?? { tcp: 0, udp: 0, dns: 0 };

		this.#seen.set(token, { ...counts, [protocol]: counts[protocol] + 1 });
	}

	#request(request: IncomingMessage, response: ServerResponse): void {
		const parts = request.url?.split('/') ?? [];
		const token = parts[2];

		if (
			token === undefined ||
			request.method !== 'GET' ||
			parts.length !== 3 ||
			!tokenPattern.test(token)
		) {
			response.writeHead(404).end();

			return;
		}

		if (parts[1] === 'probe') {
			this.#record(token, 'tcp');
			response.end('fixture');

			return;
		}

		if (parts[1] === 'seen') {
			response.setHeader('Content-Type', 'application/json');
			response.end(
				JSON.stringify(this.#seen.get(token) ?? { tcp: 0, udp: 0, dns: 0 })
			);

			return;
		}

		response.writeHead(404).end();
	}

	get ports(): Ports {
		const http = this.#http.address();

		if (http === null || typeof http === 'string') {
			throw new Error('The network peer HTTP listener is not open.');
		}

		return {
			http: http.port,
			udp: this.#udp.address().port,
			dns: this.#dns.address().port
		};
	}

	close(): Promise<void> {
		this.#closing ??= this.#close();

		return this.#closing;
	}
}

if (import.meta.main) {
	const host = process.argv[2];

	if (host === undefined || process.argv.length !== 3) {
		throw new Error('Usage: node script/network-peer.ts IPV4_BIND_ADDRESS');
	}

	const peer = await NetworkPeer.open(host);
	const timer = setTimeout(stop, 30 * 60 * 1000);

	function stop(): void {
		clearTimeout(timer);
		void peer.close().catch((error: unknown) => {
			console.error(error);
			process.exitCode = 1;
		});
	}

	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
}
