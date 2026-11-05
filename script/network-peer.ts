import type { Socket } from 'node:dgram';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { Socket as Stream } from 'node:net';
import { createServer as createStreamServer, isIP } from 'node:net';

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

interface OpenPorts extends Ports {
	readonly dnsTcp: number;
}

type Protocol = keyof Counts;

const defaultPorts: Ports = { http: 18_080, udp: 18_081, dns: 18_082 };

class InvalidBindAddressError extends Error {
	override readonly name = 'InvalidBindAddressError';
	readonly host: string;

	constructor(host: string) {
		super(`${host} is not a specific IPv4 bind address.`);
		this.host = host;
	}
}

class ListenersClosedError extends Error {
	override readonly name = 'ListenersClosedError';

	constructor() {
		super('The network peer TCP listeners are not open.');
	}
}

class UsageError extends Error {
	override readonly name = 'UsageError';
	readonly arguments: readonly string[];

	constructor(commandArguments: readonly string[]) {
		super('Usage: node script/network-peer.ts IPV4_BIND_ADDRESS');
		this.arguments = commandArguments;
	}
}

const tokenPattern = /^[0-9a-f]{32}$/;

export class NetworkPeer {
	static async open(
		host: string,
		ports: Ports = defaultPorts
	): Promise<NetworkPeer> {
		if (host === '0.0.0.0' || isIP(host) !== 4) {
			throw new InvalidBindAddressError(host);
		}

		const peer = new NetworkPeer();
		const http = once(peer.#http, 'listening');
		const dnsTcp = once(peer.#dnsTcp, 'listening');

		peer.#http.listen(ports.http, host);
		peer.#dnsTcp.listen(ports.dns, host);

		const results = await Promise.allSettled([
			http,
			dnsTcp,
			peer.#bind(peer.#udp, host, ports.udp),
			peer.#bind(peer.#dns, host, ports.dns)
		]);
		const failure = results.find((result) => result.status === 'rejected');

		if (failure !== undefined) {
			await peer.close();

			throw failure.reason;
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
	readonly #streams = new Set<Stream>();
	readonly #dnsTcp = createStreamServer((stream) => {
		this.#answerStream(stream);
	});
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

	#answerStream(stream: Stream): void {
		let received = Buffer.alloc(0);

		this.#streams.add(stream);
		stream.setTimeout(5000, () => stream.destroy());
		stream.on('close', () => this.#streams.delete(stream));
		stream.on('error', () => stream.destroy());
		stream.on('end', () => stream.end());
		stream.on('data', (chunk: Buffer) => {
			received = Buffer.concat([received, chunk]);

			if (received.length > 514) {
				stream.destroy();

				return;
			}

			if (received.length < 2) {
				return;
			}

			const size = received.readUInt16BE(0);

			if (received.length < 2 + size) {
				return;
			}

			const answer = NetworkPeer.dnsAnswer(received.subarray(2, 2 + size));

			received = received.subarray(2 + size);

			if (answer === undefined) {
				stream.destroy();

				return;
			}

			const length = Buffer.alloc(2);

			length.writeUInt16BE(answer.reply.length);
			this.#record(answer.token, 'dns');
			stream.write(Buffer.concat([length, answer.reply]));
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

		if (this.#dnsTcp.listening) {
			closing.push(
				new Promise((resolve) => {
					this.#dnsTcp.close(() => {
						resolve();
					});

					for (const stream of this.#streams) {
						stream.destroy();
					}
				})
			);
		}

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

	get ports(): OpenPorts {
		const http = this.#http.address();
		const dnsTcp = this.#dnsTcp.address();

		if (
			http === null ||
			typeof http === 'string' ||
			dnsTcp === null ||
			typeof dnsTcp === 'string'
		) {
			throw new ListenersClosedError();
		}

		return {
			http: http.port,
			udp: this.#udp.address().port,
			dns: this.#dns.address().port,
			dnsTcp: dnsTcp.port
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
		throw new UsageError(process.argv.slice(2));
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
