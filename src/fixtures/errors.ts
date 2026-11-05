/**
A failure that a test injects to check how the provider handles it.
*/
export class InjectedFailure extends Error {
	override readonly name = 'InjectedFailure';
	readonly point: 'output' | 'record';

	constructor(point: 'output' | 'record') {
		super(`The test injected a failure into the ${point} callback.`);
		this.point = point;
	}
}

/**
A Node system error, such as the one `fs` reports for a denied access.
*/
export class FileSystemError extends Error {
	override readonly name = 'FileSystemError';
	readonly code: string;
	readonly syscall: string;
	readonly path: string;

	constructor(code: string, syscall: string, path: string) {
		super(`${code}: ${syscall} ${path}`);
		this.code = code;
		this.syscall = syscall;
		this.path = path;
	}
}

/**
A failure inside a Pi runtime fixture, with the versions under test.
*/
export class PiRuntimeError extends Error {
	override readonly name = 'PiRuntimeError';
	readonly piVersion: string;
	readonly nodeVersion: string;

	constructor(piVersion: string, nodeVersion: string, options: ErrorOptions) {
		super(
			`The Pi ${piVersion} runtime failed on Node ${nodeVersion}.`,
			options
		);
		this.piVersion = piVersion;
		this.nodeVersion = nodeVersion;
	}
}

export class ScriptedModelExhaustedError extends Error {
	override readonly name = 'ScriptedModelExhaustedError';
	readonly requests: number;

	constructor(requests: number) {
		super(
			`Pi requested turn ${String(requests)}, but the scripted model provides 2.`
		);
		this.requests = requests;
	}
}

/**
An environment variable that an external test needs is missing or invalid.
*/
export class InvalidFixtureSettingError extends Error {
	override readonly name = 'InvalidFixtureSettingError';
	readonly variable: string;
	readonly value: string | undefined;
	readonly requirement: string;

	constructor(
		variable: string,
		value: string | undefined,
		requirement: string
	) {
		super(`Set ${variable} to ${requirement}.`);
		this.variable = variable;
		this.value = value;
		this.requirement = requirement;
	}
}
