import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export class ExitObserver {
	readonly #child;
	readonly #lines;

	constructor(pid: number) {
		const executable = fileURLToPath(
			new URL('../native/status', import.meta.url)
		);

		this.#child = spawn(executable, [String(pid)], {
			stdio: ['pipe', 'pipe', 'ignore']
		});
		this.#lines = createInterface({ input: this.#child.stdout })[
			Symbol.asyncIterator
		]();
		this.#child.on('error', (error) => this.#child.stdout.destroy(error));
	}

	async ready(): Promise<void> {
		const event = await this.#lines.next();

		if (event.value !== 'ready') {
			throw new Error('Could not observe the sandbox process.');
		}
	}

	async status(): Promise<number> {
		const next = await this.#lines.next();

		if (next.done || !/^-?\d+$/u.test(next.value)) {
			throw new Error('The kernel did not report an exit status.');
		}

		return Number(next.value);
	}

	close(): void {
		this.#child.stdin.end();
	}
}
