import { mkdir, writeFile, chmod, readFile, unlink, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const folder = join(homedir(), 'Library/LaunchAgents'), label = 'com.fusjlab.codex-usage';
const plist = join(folder, label + '.plist'), service = `gui/${process.getuid()}/${label}`;
const configPath = join(homedir(), 'Library/Application Support/FusjLab/codex-usage.json');
const logs = join(homedir(), 'Library/Logs/FusjLab');
const runtime = join(homedir(), 'Library/Application Support/FusjLab/runtime');
const xml = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));

async function main() {
  if (process.platform !== 'darwin') throw new Error('这个安装器仅用于 macOS；其他系统可直接运行同步程序。');
  let registered = false;
  try { await exec('/bin/launchctl', ['print', service]); registered = true; } catch {}
  if (process.argv.includes('--uninstall')) {
    if (registered) await exec('/bin/launchctl', ['bootout', service]);
    await unlink(plist).catch(error => { if (error.code !== 'ENOENT') throw error; });
    console.log('已停止并移除自动同步；私有设置与日志仍保留。'); return;
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(config.syncToken || '')) throw new Error('请先配置本机同步密钥。');
  await mkdir(folder, { recursive: true }); await mkdir(logs, { recursive: true, mode: 0o700 });
  // Run outside Desktop so moving the repository or macOS folder privacy cannot interrupt syncing.
  await mkdir(join(runtime, 'tools'), { recursive: true, mode: 0o700 });
  await mkdir(join(runtime, 'js'), { recursive: true, mode: 0o700 });
  await copyFile(join(root, 'tools/codex-usage-sync.mjs'), join(runtime, 'tools/codex-usage-sync.mjs'));
  await copyFile(join(root, 'js/usage-data.js'), join(runtime, 'js/usage-data.js'));
  await writeFile(join(runtime, 'package.json'), '{"type":"module","private":true}\n', { mode: 0o600 });
  const out = join(logs, 'usage.log'), err = join(logs, 'usage-error.log');
  for (const path of [out, err]) { await writeFile(path, '', { flag: 'a', mode: 0o600 }); await chmod(path, 0o600); }
  const args = [process.execPath, join(runtime, 'tools/codex-usage-sync.mjs'), '--config', configPath];
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(runtime)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>60</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(out)}</string>
<key>StandardErrorPath</key><string>${xml(err)}</string>
</dict></plist>\n`;
  await writeFile(plist, source, { mode: 0o600 }); await chmod(plist, 0o600);
  await exec('/usr/bin/plutil', ['-lint', plist]);
  if (registered) await exec('/bin/launchctl', ['bootout', service]);
  // launchd can still be unloading the previous process after bootout returns.
  for (let attempt = 0; ; attempt++) {
    try { await exec('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]); break; }
    catch (error) { if (attempt >= 3) throw error; await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1))); }
  }
  console.log('本机自动同步已启用，登录 macOS 后会自动运行。');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
