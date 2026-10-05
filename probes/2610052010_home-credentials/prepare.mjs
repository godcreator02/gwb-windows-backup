import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const homeName = process.argv[2];
assert(homeName?.startsWith('stores-cred-'));
const home = path.join(process.env.APPDATA, 'gwb-kernel', 'homes', homeName);
assert(existsSync(home));
const data = path.join(home, 'data', 'windows-backup');
const credentials = path.join(data, 'credentials');
mkdirSync(credentials, { recursive: true });
writeFileSync(path.join(credentials, 'restic-password.txt'), Buffer.from('\ufefffixture-restic-home-password\r\n', 'utf16le'));
writeFileSync(path.join(credentials, 'oss-credentials.txt'), 'AWS_ACCESS_KEY_ID=fixture-access-home-id\nAWS_SECRET_ACCESS_KEY=fixture-access-home-secret\n');
mkdirSync(path.join(home, 'fixture-input'), { recursive: true });
writeFileSync(path.join(home, 'fixture-input', 'hello.txt'), 'fixture backup content');
writeFileSync(path.join(home, 'fixture-source-password.txt'), 'fixture-source-password');
if (process.argv[3]) {
  mkdirSync(path.join(data, 'bin'), { recursive: true });
  copyFileSync(process.argv[3], path.join(data, 'bin', 'restic.exe'));
}
console.log(JSON.stringify({ home: homeName, fixtures: 'ready', realCredentials: false }));
