/**
Returns the value that `action` throws, so a test can compare the whole error
with `toStrictEqual`. Returns `undefined` when `action` does not throw.
*/
export function thrown(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}

	return undefined;
}
