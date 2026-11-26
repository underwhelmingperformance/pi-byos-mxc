import { expect, it } from 'vitest';

import { libraryGrants, linkedLibraryGrants } from './linked-libraries.js';

it.each([
	[
		'/nix/store/arspcb0pa15f9f2b079k1kpqik297fxz-zlib-1.3.2/lib/libz.dylib',
		'/nix/store/arspcb0pa15f9f2b079k1kpqik297fxz-zlib-1.3.2'
	],
	[
		'/opt/homebrew/Cellar/openssl@3/3.5.9/lib/libssl.3.dylib',
		'/opt/homebrew/Cellar/openssl@3/3.5.9'
	],
	['/home/user/lib/libssl.so.3', '/home/user/lib/libssl.so.3'],
	['/usr/local/lib/libz.dylib', '/usr/local/lib/libz.dylib']
])('grants %s through %s', (filename, grantedPath) => {
	expect(libraryGrants(filename)).toStrictEqual([grantedPath]);
});

it.each([
	{
		filename: '/home/user/lib/libssl.so.3.5.9',
		lookup: '/home/user/lib/libssl.so.3',
		grants: ['/home/user/lib/libssl.so.3.5.9', '/home/user/lib/libssl.so.3']
	},
	{
		filename: '/opt/homebrew/Cellar/zlib/1.3.2/lib/libz.so.1.3.2',
		lookup: '/opt/homebrew/Cellar/zlib/1.3.2/lib/libz.so.1',
		grants: ['/opt/homebrew/Cellar/zlib/1.3.2']
	}
])(
	'grants the lookup path $lookup when needed',
	({ filename, lookup, grants }) => {
		expect(libraryGrants(filename, lookup)).toStrictEqual(grants);
	}
);

it('omits a Linux lookup bind already covered by another library package', async () => {
	const packagePath = '/nix/store/arspcb0pa15f9f2b079k1kpqik297fxz-zlib-1.3.2';
	const lookup = `${packagePath}/lib/libssl.so.3`;
	const filename = '/home/user/lib/libssl.so.3.5.9';
	const grants = await linkedLibraryGrants('/node/bin/node', {
		platform: 'linux',
		workspace: '/workspace',
		inspect: () => Promise.resolve([lookup, `${packagePath}/lib/libz.so.1`]),
		realpath: (candidate) =>
			Promise.resolve(candidate === lookup ? filename : candidate)
	});

	expect(grants).toStrictEqual([filename, packagePath]);
});
