import type { Clock } from '../clock.js';

interface Timer {
	readonly at: number;
	readonly callback: () => void;
}

/**
A clock that moves only when a test calls `advance`. Timers fire in order of
monotonic time, including timers that earlier callbacks schedule within the
same advance.
*/
export class FakeClock implements Clock {
	readonly #timers = new Set<Timer>();
	#monotonic = 0;

	monotonicTime(): number {
		return this.#monotonic;
	}

	schedule(callback: () => void, delayMs: number): () => void {
		const timer = { at: this.#monotonic + Math.max(0, delayMs), callback };

		this.#timers.add(timer);

		return () => {
			this.#timers.delete(timer);
		};
	}

	advance(ms: number): void {
		const target = this.#monotonic + ms;

		for (;;) {
			const due = [...this.#timers]
				.filter((timer) => timer.at <= target)
				.toSorted((left, right) => left.at - right.at)[0];

			if (due === undefined) {
				break;
			}

			this.#timers.delete(due);
			this.#monotonic = due.at;
			due.callback();
		}

		this.#monotonic = target;
	}
}
