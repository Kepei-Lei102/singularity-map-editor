// 双击入口共用：检查环境、准备依赖，再交给现有启动器打开浏览器。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fail(message) { console.error(`\n${message}`); process.exit(1); }
if (Number(process.versions.node.split('.')[0]) < 22) {
  fail('需要 Node.js 22 或更新版本。请安装 https://nodejs.org/ 的 LTS 版本，然后重新启动。');
}
if (process.argv.length > 3) fail('一次只能打开一个工程。路径含空格时请用双引号括起来。');
const project = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (project && !fs.existsSync(project)) fail(`找不到工程：${project}`);

// Windows 的 npm 是 .cmd；命令内容固定，工程路径不会拼进 shell。
const npm = (args, stdio = 'inherit', registry) => {
  const env = { ...process.env, ...(registry ? { npm_config_registry: registry,
    npm_config_fetch_retries: '1', npm_config_fetch_timeout: '45000' } : {}) };
  return process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`], { cwd: root, stdio, env })
    : spawnSync('npm', args, { cwd: root, stdio, env });
};
if (npm(['--version'], 'ignore').status !== 0) fail('找不到 npm。请重新安装 Node.js LTS（包含 npm），再重新打开终端。');
const lock = fs.readFileSync(path.join(root, 'package-lock.json'));
const fingerprint = createHash('sha256').update(lock).update(process.versions.node.split('.')[0]).update(process.platform).update(process.arch).digest('hex');
const stamp = path.join(root, 'node_modules', '.launcher-lock');
const installed = fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === fingerprint;
if (!installed || npm(['ls', '--depth=0'], 'ignore').status !== 0) {
  console.log('首次运行或依赖有变更，正在安装依赖（需要联网）……');
  const sources = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];
  const success = sources.some(registry => {
    console.log(`依赖来源：${registry}`);
    return npm(['ci', '--include=dev', '--no-audit', '--no-fund'], 'inherit', registry).status === 0;
  });
  if (!success) fail('两个依赖来源均安装失败。请检查上面的网络或文件权限错误；修复后再次运行启动脚本。');
  fs.writeFileSync(stamp, fingerprint);
}
console.log('正在打开地图编辑器。使用时请保留此窗口，结束后按 Ctrl+C。');
const child = spawnSync(process.execPath, [path.join(root, 'scripts', 'open.mjs'), ...(project ? [project] : [])], {
  cwd: root, stdio: 'inherit', env: { ...process.env, INIT_CWD: process.cwd() },
});
if (child.error) fail(`启动失败：${child.error.message}`);
process.exit(child.status ?? (child.signal === 'SIGINT' ? 0 : 1));
