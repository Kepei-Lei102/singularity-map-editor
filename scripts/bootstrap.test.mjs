import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const mac = { skip: process.platform !== 'darwin' };
function fixture(t, mode = 'download') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '启动 空格-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'editor'), bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(bin);
  fs.copyFileSync(new URL('./bootstrap-macos.sh', import.meta.url), path.join(root, 'scripts/bootstrap-macos.sh'));
  const write = (file, text) => fs.writeFileSync(file, text, { mode: 0o755 });
  // Test-controlled executables: no network, dependency installation or server.
  const node = '#!/bin/bash\nif [ "$1" = "-e" ] || [[ "$1" = *npm-cli.js ]]; then exit 0; fi\nprintf "%s\\n" "$@" >> "$TEST_LOG"\n';
  const packageName = 'node-v22.99.0-darwin-arm64';
  const contents = path.join(dir, 'source', packageName);
  fs.mkdirSync(path.join(contents, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'lib/node_modules/npm/bin'), { recursive: true });
  write(path.join(contents, 'bin/node'), node);
  write(path.join(contents, 'lib/node_modules/npm/bin/npm-cli.js'), '');
  const archive = path.join(dir, 'fixture.tar.gz');
  assert.equal(spawnSync('/usr/bin/tar', ['-czf', archive, '-C', path.dirname(contents), packageName]).status, 0);
  const hash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(path.join(dir, 'sums'), `${hash}  ${packageName}.tar.gz\n`);
  write(path.join(bin, 'uname'), '#!/bin/bash\nprintf "arm64\\n"\n');
  write(path.join(bin, 'curl'), `#!/bin/bash
url=''; out=''
while [ "$#" -gt 0 ]; do
 case "$1" in https:*) url="$1";; -o) shift; out="$1";; esac
 shift
done
printf '%s\\n' "$url" >> "$TEST_DOWNLOADS"
if [ "$TEST_MODE" = fail ] || { [ "$TEST_MODE" = fallback ] && [[ "$url" = *npmmirror* ]]; }; then exit 22; fi
if [[ "$url" = *SHASUMS256.txt ]]; then /bin/cp "$TEST_DIR/sums" "$out"
elif [ "$TEST_MODE" = corrupt ]; then printf bad > "$out"
else /bin/cp "$TEST_DIR/fixture.tar.gz" "$out"; fi
`);
  if (mode === 'existing') {
    write(path.join(bin, 'node'), node);
    write(path.join(bin, 'npm'), '#!/bin/bash\nexit 0\n');
  }
  if (mode === 'old') {
    write(path.join(bin, 'node'), '#!/bin/bash\nexit 1\n');
    write(path.join(bin, 'npm'), '#!/bin/bash\nexit 0\n');
  }
  const log = path.join(dir, 'launch.log'), downloads = path.join(dir, 'downloads.log');
  const run = (nextMode = mode) => spawnSync('/bin/bash', [path.join(root, 'scripts/bootstrap-macos.sh'), '../中文 工程'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TEST_LOG: log, TEST_DOWNLOADS: downloads, TEST_DIR: dir, TEST_MODE: nextMode },
  });
  return { run, log, downloads, root };
}

test('macOS bootstrap reuses installed Node and preserves spaced Unicode project argument', mac, t => {
  const f = fixture(t, 'existing');
  assert.equal(f.run().status, 0);
  assert.match(fs.readFileSync(f.log, 'utf8'), /\n\.\.\/中文 工程\n$/);
  assert.equal(fs.existsSync(f.downloads), false);
});
test('macOS bootstrap downloads locally, falls back and reuses cached runtime offline', mac, t => {
  const f = fixture(t, 'fallback');
  const first = f.run(); assert.equal(first.status, 0, first.stderr);
  const downloads = fs.readFileSync(f.downloads, 'utf8');
  assert.match(downloads, /npmmirror/); assert.match(downloads, /nodejs.org\/dist\/v22.99.0/);
  assert.equal(f.run('fail').status, 0);
  assert.equal(fs.readFileSync(f.downloads, 'utf8'), downloads);
});
test('macOS bootstrap replaces unsupported system Node only in its private directory', mac, t => {
  const f = fixture(t, 'old');
  const r = f.run(); assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(f.root, '.runtime/node-darwin-arm64/bin/node')));
});
test('dependency installer falls back to official registry, preserves lockfile and then works offline', { skip: process.platform === 'win32' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '依赖 空格-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.copyFileSync(new URL('./launch.mjs', import.meta.url), path.join(dir, 'scripts/launch.mjs'));
  fs.writeFileSync(path.join(dir, 'scripts/open.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(dir, '中文 工程.json'), '{}');
  fs.writeFileSync(path.join(dir, 'bin/npm'), `#!/bin/sh
if [ "$1" = ci ]; then
 printf '%s\\n' "$npm_config_registry" >> "$INSTALL_LOG"
 [ "$npm_config_registry" = https://registry.npmjs.org ] || exit 1
 mkdir -p node_modules
fi
exit 0
`, { mode: 0o755 });
  const log = path.join(dir, 'install.log');
  const run = () => spawnSync(process.execPath, [path.join(dir, 'scripts/launch.mjs'), '中文 工程.json'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`, INSTALL_LOG: log },
  });
  const first = run(); assert.equal(first.status, 0, first.stderr);
  assert.ok(first.stdout.includes(path.join(dir, '中文 工程.json')));
  const sources = fs.readFileSync(log, 'utf8');
  assert.equal(sources, 'https://registry.npmmirror.com\nhttps://registry.npmjs.org\n');
  assert.equal(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'), '{}');
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(log, 'utf8'), sources);
});

for (const mode of ['corrupt', 'fail']) test(`macOS bootstrap refuses ${mode} download without launching`, mac, t => {
  const f = fixture(t, mode), result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(f.log), false);
  assert.deepEqual(fs.readdirSync(path.join(f.root, '.runtime')), []);
});
