export interface Clock {
	/**
	Milliseconds from an arbitrary origin that never moves backwards. Use it to
	measure elapsed time.
	*/
	monotonicTime(): number;

	/**
	Runs `callback` after `delayMs` and returns a function that cancels it.
	*/
	schedule(callback: () => void, delayMs: number): () => void;
}

const MAX_TIMER_MS = 2_147_483_647;

export const systemClock: Clock = Object.freeze({
	monotonicTime: () => performance.now(),
	schedule(callback: () => void, delayMs: number) {
		const timer = setTimeout(
			callback,
			Math.min(Math.max(0, delayMs), MAX_TIMER_MS)
		);

		return () => {
			clearTimeout(timer);
		};
	}
});
