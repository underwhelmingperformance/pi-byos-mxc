import path from 'node:path';

import type {
	BackendFiles,
	BackendProcessContext,
	BackendProcessOutcome,
	DirectoryEntry,
	FileStat,
	SandboxOperationContext
} from 'pi-bring-your-own-sandbox/provider';
import {
	SandboxCancelledError,
	SandboxOperationError,
	SandboxPathNotFoundError,
	SandboxPermissionDeniedError
} from 'pi-bring-your-own-sandbox/provider';

import { quote } from './shell.js';

type RunFileCommand = (
	command: string,
	context: BackendProcessContext,
	input?: Uint8Array
) => Promise<BackendProcessOutcome>;

export function sandboxFiles(
	workspace: string,
	helper: string,
	run: RunFileCommand
): BackendFiles {
	type FileOperation =
		'readFile' | 'writeFile' | 'access' | 'stat' | 'mkdir' | 'listDirectory';

	async function perform(
		operation: FileOperation,
		filename: string,
		context: SandboxOperationContext,
		mode: string = operation,
		input?: Uint8Array
	): Promise<Buffer> {
		const chunks: Buffer[] = [];
		const command = [
			'exec',
			quote(helper),
			mode,
			quote(path.resolve(workspace, filename)),
			...(input ? [String(input.byteLength)] : [])
		].join(' ');
		const result = await run(
			command,
			{
				...context,
				onOutput({ stream, data }) {
					if (stream === 'stdout') {
						chunks.push(Buffer.from(data));
					}
				}
			},
			input
		);
		const identity = { operation, providerId: 'mxc' };

		if (result.kind === 'cancelled') {
			throw new SandboxCancelledError({
				...identity,
				reason: 'caller',
				completion:
					result.termination === 'unconfirmed' ? 'unknown' : result.termination
			});
		}

		if (result.exit.kind === 'code') {
			switch (result.exit.code) {
				case 0: {
					return Buffer.concat(chunks);
				}

				case 43: {
					throw new SandboxPermissionDeniedError(identity);
				}

				case 44: {
					throw new SandboxPathNotFoundError(identity);
				}
			}
		}

		throw new SandboxOperationError(identity);
	}

	async function stat(
		filename: string,
		context: SandboxOperationContext
	): Promise<FileStat> {
		const output = await perform('stat', filename, context);
		const [kind, length] = output.toString().split(' ', 2);
		const size = Number(length);

		if (
			(kind !== 'file' && kind !== 'other' && kind !== 'directory') ||
			!Number.isSafeInteger(size) ||
			size < 0
		) {
			throw new SandboxOperationError({ operation: 'stat', providerId: 'mxc' });
		}

		return { kind, size };
	}

	return {
		read: {
			readFile: async (filename, context) =>
				new Uint8Array(await perform('readFile', filename, context)),
			stat,
			async access(filename, context) {
				await perform('access', filename, context, 'readAccess');
			}
		},
		list: {
			stat,
			async listDirectory(filename, context) {
				const output = await perform('listDirectory', filename, context);
				const fields = output.toString().split('\0');
				const entries: DirectoryEntry[] = [];

				for (let index = 0; index < fields.length - 1; index += 2) {
					const kind = fields[index],
						name = fields[index + 1];

					if (
						!name ||
						(kind !== 'file' &&
							kind !== 'directory' &&
							kind !== 'symlink' &&
							kind !== 'other')
					) {
						throw new SandboxOperationError({
							operation: 'listDirectory',
							providerId: 'mxc'
						});
					}

					entries.push({ kind, name });
				}

				return entries.toSorted((a, b) =>
					Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
				);
			}
		},
		write: {
			async writeFile(filename, content, context) {
				await perform('writeFile', filename, context, 'writeFile', content);
			},
			async access(filename, context) {
				await perform('access', filename, context, 'writeAccess');
			},
			async mkdir(filename, context) {
				await perform('mkdir', filename, context);
			}
		}
	};
}
