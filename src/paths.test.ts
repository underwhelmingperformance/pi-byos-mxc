import { expect, it } from 'vitest';

import { assertDisjointPaths, isPathWithin } from './paths.js';

it.each([
	{ parent: '/project', child: '/project/file', expected: true },
	{ parent: '/project', child: '/project', expected: true },
	{ parent: '/project', child: '/project-other', expected: false }
])(
	'checks canonical path containment without prefix confusion',
	({ parent, child, expected }) => {
		expect(isPathWithin(parent, child)).toBe(expected);
	}
);

it.each([
	{ writable: '/project', protectedPath: '/project/dist' },
	{ writable: '/project/subdirectory', protectedPath: '/project' },
	{ writable: '/project', protectedPath: '/project' }
])(
	'rejects overlapping writable and protected paths',
	({ writable, protectedPath }) => {
		expect(() => {
			assertDisjointPaths(writable, [protectedPath]);
		}).toThrow();
	}
);

it('accepts disjoint writable and protected paths', () => {
	expect(() => {
		assertDisjointPaths('/workspace', ['/runtime', '/control']);
	}).not.toThrow();
});
