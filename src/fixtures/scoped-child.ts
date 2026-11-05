import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { nodeCommand } from './native-sandbox.js';

const execute = promisify(execFile);

export class ScopedChild {
	readonly #nonce = `scope-child-${randomUUID()}`;
	readonly #heartbeat: string;
	readonly #status: string;
	readonly command: string;

	constructor(workspace: string, outside: string, readonly: string) {
		this.#heartbeat = path.join(workspace, 'scope-heartbeat');
		this.#status = path.join(workspace, 'scope-status.json');

		const child = `const fs=require('node:fs');const [heartbeat,status,outside,readonly]=process.argv.slice(1);const denied=f=>{try{f();return false;}catch(e){if(['EPERM','EACCES','ENOENT','EROFS'].includes(e.code))return true;throw e;}};const tick=()=>{const state={readable:fs.readFileSync(readonly,'utf8'),readDenied:denied(()=>fs.readFileSync(outside)),writeDenied:denied(()=>fs.writeFileSync(readonly,'changed'))};fs.writeFileSync(status+'.new',JSON.stringify(state));fs.renameSync(status+'.new',status);fs.appendFileSync(heartbeat,'x');};tick();const timer=setInterval(tick,100);setTimeout(()=>{clearInterval(timer);process.exit(0);},8000);`;
		const childArguments = [
			'-e',
			child,
			this.#heartbeat,
			this.#status,
			outside,
			readonly,
			this.#nonce
		];
		const parent = `const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,${JSON.stringify(childArguments)},{detached:true,stdio:'ignore'});child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(this.#heartbeat)})){clearInterval(timer);process.stdout.write('ready');}},10);`;

		this.command = nodeCommand(parent);
	}

	async liveIds(): Promise<number[]> {
		const snapshot = await execute('/bin/ps', ['-axo', 'pid=,stat=,args='], {
			timeout: 1000,
			maxBuffer: 2_097_152
		});

		return snapshot.stdout.split('\n').flatMap((line) => {
			const fields = /^\s*(?<pid>\d+)\s+(?<state>\S+)\s+(?<command>.+)$/u.exec(
				line
			)?.groups;

			return !fields?.command?.trimEnd().endsWith(this.#nonce) ||
				fields.state?.startsWith('Z')
				? []
				: Number(fields.pid);
		});
	}

	async snapshot(): Promise<{
		readonly heartbeat: number;
		readonly restrictions: unknown;
	}> {
		const heartbeat = await readFile(this.#heartbeat);
		let restrictions: unknown;

		try {
			restrictions = JSON.parse(await readFile(this.#status, 'utf8'));
		} catch (error) {
			throw new Error(
				'The scope fixture did not produce a readable JSON status.',
				{ cause: error }
			);
		}

		return { heartbeat: heartbeat.byteLength, restrictions };
	}

	async waitForExit(): Promise<void> {
		const deadline = performance.now() + 12_000;

		while (performance.now() < deadline) {
			const ids = await this.liveIds();

			if (ids.length === 0) {
				return;
			}

			await delay(100);
		}

		throw new Error(
			'The finite cross-session fixture did not stop within its cleanup deadline.'
		);
	}
}
