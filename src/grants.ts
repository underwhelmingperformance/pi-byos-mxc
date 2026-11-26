import path from 'node:path';

import type {
	GrantedPath,
	SandboxOpenContext,
	SandboxOpenRequest,
	SandboxPolicy
} from 'pi-bring-your-own-sandbox/provider';
import { UnsupportedSandboxPolicyError } from 'pi-bring-your-own-sandbox/provider';

import type { MxcConfig } from './config.js';
import type { HostFileSystem } from './host.js';
import { isPathWithin } from './paths.js';

const credentialLocations = [
	'.ssh',
	'.aws',
	'.gnupg',
	'.netrc',
	'.git-credentials',
	'.config/gh',
	'.docker/config.json',
	'.kube',
	'.config/gcloud',
	'.azure',
	'.pypirc',
	'.password-store',
	'Library/Keychains',
	'.local/share/keyrings',
	'Library/Application Support/Google/Chrome',
	'Library/Application Support/Firefox',
	'Library/Safari',
	'Library/Cookies',
	'.mozilla',
	'.config/google-chrome',
	'.config/chromium'
];

function isMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function canonicalGrantPath(
	fs: HostFileSystem,
	filename: string
): Promise<string> {
	try {
		return await fs.realpath(filename);
	} catch (error) {
		if (!isMissing(error)) {
			throw error;
		}

		const parent = path.dirname(filename);

		return path.join(
			await canonicalGrantPath(fs, parent),
			path.basename(filename)
		);
	}
}

export async function credentialPaths(
	fs: HostFileSystem,
	home: string
): Promise<readonly string[]> {
	const paths = credentialLocations.map((location) =>
		path.join(home, location)
	);
	const canonical = await Promise.all(
		paths.map((filename) => canonicalGrantPath(fs, filename))
	);

	return [...new Set([...paths, ...canonical])];
}

function hasOverlap(left: string, right: string): boolean {
	return isPathWithin(left, right) || isPathWithin(right, left);
}

interface GrantPlan {
	readonly hostWorkspace: string;
	readonly mappings: readonly GrantedPath[];
	readonly extraReads: readonly string[];
	readonly extraWrites: readonly string[];
}

export async function planPathGrants(
	fs: HostFileSystem,
	request: Pick<SandboxOpenRequest<MxcConfig>, 'paths'>,
	context: SandboxOpenContext,
	{
		hostWorkspace,
		workspace,
		hostHome,
		targetHome,
		denied,
		protectedWrites,
		policy
	}: {
		readonly hostWorkspace: string;
		readonly workspace: string;
		readonly hostHome: string;
		readonly targetHome: string;
		readonly denied: readonly string[];
		readonly protectedWrites: readonly string[];
		readonly policy: SandboxPolicy;
	}
): Promise<GrantPlan> {
	const mappings: GrantedPath[] = [];
	const extras: Record<GrantedPath['kind'], string[]> = { read: [], write: [] };
	const linked = new Set<string>();

	const entries = (['read', 'write'] as const)
		.flatMap((kind) =>
			(request.paths?.[kind] ?? []).map((hostPath) => ({ kind, hostPath }))
		)
		.toSorted((left, right) => left.hostPath.length - right.hostPath.length);

	for (const { kind, hostPath } of entries) {
		const refusal = () =>
			new UnsupportedSandboxPolicyError({
				operation: 'open',
				providerId: 'mxc',
				detail: {
					kind: 'path',
					path: hostPath,
					access: kind,
					reason: 'unreachable'
				}
			});

		if (denied.some((entry) => hasOverlap(entry, hostPath))) {
			context.reportDiagnostic({
				level: 'warning',
				message: 'MXC cannot grant access to credential locations.'
			});

			throw refusal();
		}

		if (isPathWithin(hostWorkspace, hostPath)) {
			if (
				kind === 'write' &&
				workspace === hostWorkspace &&
				!policy.hostWorkspaceWrites
			) {
				throw refusal();
			}

			mappings.push({
				kind,
				hostPath,
				targetPath: path.join(workspace, path.relative(hostWorkspace, hostPath))
			});

			continue;
		}

		if (
			hostPath === hostHome ||
			(kind === 'write' &&
				(workspace !== hostWorkspace ||
					[hostWorkspace, ...protectedWrites].some((entry) =>
						hasOverlap(entry, hostPath)
					)))
		) {
			throw refusal();
		}

		const targetPath = isPathWithin(hostHome, hostPath)
			? path.join(targetHome, path.relative(hostHome, hostPath))
			: hostPath;

		extras[kind].push(hostPath);
		mappings.push({ kind, hostPath, targetPath });

		if (
			targetPath === hostPath ||
			linked.values().some((entry) => isPathWithin(entry, targetPath))
		) {
			continue;
		}

		await fs.mkdir(path.dirname(targetPath), { mode: 0o700, recursive: true });
		await fs.symlink(hostPath, targetPath);
		linked.add(targetPath);
	}

	return {
		hostWorkspace,
		mappings,
		extraReads: extras.read.filter((filename) =>
			extras.write.every((entry) => !isPathWithin(entry, filename))
		),
		extraWrites: extras.write
	};
}
