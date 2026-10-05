import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// Synthetic fixtures only. Never pass default as the target of this probe.
const homeName = process.argv[2];
assert(homeName?.startsWith('stores-cred-'));
const homes = path.join(process.env.APPDATA, 'gwb-kernel', 'homes');
const home = path.join(homes, homeName);
const driver = path.join(homes, 'default', 'node_modules', '@godcreator', 'gwb-devkit', 'bin', 'cdp.mjs');
const receipts = [];
function command(name, args = {}, ok = true) {
  const run = spawnSync(process.execPath, [driver, homeName, 'cmd', name, JSON.stringify(args)], { encoding: 'utf8', windowsHide: true });
  const packet = JSON.parse(run.stdout);
  const reply = packet['回执'];
  assert.equal(reply.ok, ok, `${name} unexpected status`);
  for (const secret of ['fixture-restic-home-password', 'fixture-access-home-id', 'fixture-access-home-secret', 'fixture-source-password']) {
    assert(!JSON.stringify(reply).includes(secret), `${name} echoed a fixture credential`);
  }
  receipts.push({ command: name, ok: reply.ok });
  return reply.data;
}
const set = (key, value) => command('settings.set', { section: 'windows-backup', key, value });

const credentials = command('credentials.list', { section: 'windows-backup' });
assert.equal(credentials.length, 2);
if (!credentials.find((row) => row.key === 'restic-password').isSet) {
  const file = path.join(home, 'fixture-restic-password.txt');
  writeFileSync(file, 'fixture-restic-home-password');
  command('credentials.import', { from: { file, format: 'text' }, to: { section: 'windows-backup', key: 'restic-password' } });
  credentials.find((row) => row.key === 'restic-password').isSet = true;
}
assert(credentials.every((row) => row.isSet && !('value' in row)));
const ordinary = command('settings.all', { section: 'windows-backup' });
assert(ordinary.every((row) => row.type !== 'secret'));
command('settings.get', { section: 'windows-backup', key: 'restic-password' }, false);
const locations = command('windows-backup.paths');
assert(locations.homeRecoveryFiles.some((file) => file.endsWith('credentials.json')));
assert(existsSync(locations.legacyPasswordFile));
assert(existsSync(locations.legacyOssCredentialsFile));

set('toast', false);
const repository = path.join(home, 'fixture-repo-legacy');
set('local-repo', repository);
set('frequency-minutes', 100000);
if (!existsSync(path.join(repository, 'config'))) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AWS_|RESTIC_|MINIO_)/i.test(key)));
  const legacy = spawnSync(path.join(locations.binDir, 'restic.exe'), ['--repo', repository, '--password-file', locations.legacyPasswordFile, 'init'], { encoding: 'utf8', windowsHide: true, env });
  assert.equal(legacy.status, 0, 'legacy password file initialization');
  receipts.push({ command: 'legacy restic --password-file init', ok: true });
}
set('sources', [path.join(home, 'fixture-input')]);
const backup = command('windows-backup.run');
assert.equal(backup.lastRunOk, true);
const snapshots = command('windows-backup.restic', { args: ['snapshots', '--json'] });
assert(JSON.parse(snapshots.stdout).length >= 1);
const legacyRead = spawnSync(path.join(locations.binDir, 'restic.exe'), ['--repo', repository, '--password-file', locations.legacyPasswordFile, 'snapshots', '--json'], {
  encoding: 'utf8', windowsHide: true,
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AWS_|RESTIC_|MINIO_)/i.test(key))),
});
assert.equal(legacyRead.status, 0);
assert(JSON.parse(legacyRead.stdout).length >= 1);
receipts.push({ command: 'legacy restic --password-file snapshots', ok: true });
command('windows-backup.check');
const restored = path.join(home, 'fixture-restored-subtree');
const snapshotPath = path.join(home, 'fixture-input').replaceAll('\\', '/').replace(/^([A-Za-z]):/, '/$1');
command('windows-backup.restic', { args: ['restore', `latest:${snapshotPath}`, '--target', restored, '--verify'] });
function restoredFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? restoredFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
assert(restoredFiles(restored).some((file) => file.endsWith('hello.txt') && readFileSync(file, 'utf8') === 'fixture backup content'));

const configured = command('sources.configure', { id: 'fixture-rss', label: 'Fixture RSS', kind: 'freshrss', endpoint: 'https://fixture.invalid', username: 'fixture-user' });
command('credentials.import', { from: { file: path.join(home, 'fixture-source-password.txt'), format: 'text' }, to: { section: 'sources', key: configured.credentialKey } });
command('sources.connect', { source: 'fixture-rss' });
assert.equal(command('sources.status').sources[0].configured, true);
command('sources.configure', { id: 'fixture-rss', label: 'Fixture RSS', kind: 'freshrss', endpoint: 'https://different.invalid', username: 'fixture-user' }, false);
command('sources.disconnect', { source: 'fixture-rss' });
assert.equal(command('sources.status').sources[0].configured, false);
command('credentials.delete', { section: 'windows-backup', key: 'restic-password' });
assert.equal(command('credentials.status', { section: 'windows-backup', key: 'restic-password' }).isSet, false);
const reload = spawnSync(process.execPath, [driver, homeName, 'reload'], { encoding: 'utf8', windowsHide: true });
assert.equal(reload.status, 0);
// Remount the plugin, not merely its renderer, to exercise the persisted migration marker.
command('plugin-manager.disable', { entryId: 'home:windows-backup' });
command('plugin-manager.enable', { entryId: 'home:windows-backup' });
assert.equal(command('credentials.status', { section: 'windows-backup', key: 'restic-password' }).isSet, false);
command('windows-backup.restic', { args: ['snapshots'] }, false);
assert(existsSync(locations.legacyPasswordFile));
const log = readFileSync(path.join(home, 'gwb.log'), 'utf8');
assert(!log.includes('fixture-restic-home-password'));
assert(!log.includes('fixture-access-home-secret'));
assert(!log.includes('fixture-source-password'));
const result = { home: homeName, checks: receipts.length, passed: true, credentials: 'synthetic only; no credential content recorded', receipts };
writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ home: homeName, checks: receipts.length, passed: true }));
