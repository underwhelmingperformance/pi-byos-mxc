import { expect } from 'vitest';

export class CommandChecks {
	readonly #failures: unknown[] = [];
	#runs = 0;

	async run(check: () => Promise<void>): Promise<void> {
		try {
			await check();
		} catch (error) {
			this.#failures.push(error);
		} finally {
			this.#runs++;
		}
	}

	verify(runs: number): void {
		expect({ runs: this.#runs, failures: this.#failures }).toStrictEqual({
			runs,
			failures: []
		});
	}
}
