import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validKey = value => typeof value === 'string' && /^[!-~]{8,4096}$/.test(value);
const fail = () => { throw new Error('企业资料私密配置无效，请检查凭据格式、文件权限和运行用户'); };

function readProfile(file, { platform, io, uid }) {
  let descriptor;
  try {
    const fileStat = io.lstatSync(file);
    const directoryStat = io.lstatSync(path.dirname(file));
    if (fileStat.isSymbolicLink() || directoryStat.isSymbolicLink() || !fileStat.isFile() || !directoryStat.isDirectory()) fail();
    const restricted = stat => (stat.mode & 0o077) === 0 && (stat.uid === uid || stat.uid === 0);
    if (platform !== 'win32' && (!Number.isInteger(uid) || !restricted(directoryStat))) fail();
    descriptor = io.openSync(file, fs.constants.O_RDONLY | (platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW || 0));
    const opened = io.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > 65536 || (platform !== 'win32' && !restricted(opened))) fail();
    const profile = JSON.parse(io.readFileSync(descriptor, 'utf8').replace(/^\uFEFF/, ''));
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || profile.provider !== 'qcc-mcp') fail();
    return profile;
  } catch { fail(); }
  finally { if (descriptor !== undefined) io.closeSync(descriptor); }
}

function decryptWindows(file) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(projectRoot, 'local/read-company-profile-key.ps1'), '-ConfigPath', file, '-InternalPipe'], {
      encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 65536,
    }).trim();
  } catch { throw new Error('无法解密企业资料凭据，请使用保存配置的 Windows 用户运行'); }
}

// Startup-only configuration. The returned status never contains the credential.
// Tests inject a disposable filesystem/env; this module never opens a business DB.
export function prepareCompanyProfile(root, {
  env = process.env, platform = process.platform, configFile = path.join(root, '.private/company-profile.json'),
  io = fs, uid = process.getuid?.(), decryptKey = decryptWindows,
} = {}) {
  const selected = env.CRM_COMPANY_PROFILE_PROVIDER?.trim();
  if (selected && ['none', 'off', 'disabled'].includes(selected)) return { provider: null, configured: false, source: 'disabled' };
  // Preserve the existing paid QCC API adapter and its own credentials.
  if (selected === 'qcc') {
    const configured = !!env.QCC_APP_KEY && !!env.QCC_SECRET_KEY;
    return { provider: 'qcc', configured, source: configured ? 'environment' : 'none' };
  }
  if (selected && selected !== 'qcc-mcp') fail();
  const environmentKey = env.QCC_MCP_API_KEY;
  if (selected === 'qcc-mcp' && environmentKey) {
    if (!validKey(environmentKey)) fail();
    env.CRM_COMPANY_PROFILE_PROVIDER = 'qcc-mcp';
    return { provider: 'qcc-mcp', configured: true, source: 'environment' };
  }
  let profile;
  try {
    io.lstatSync(configFile);
    profile = readProfile(configFile, { platform, io, uid });
  } catch (error) {
    if (error.code !== 'ENOENT') fail();
  }
  if (!selected && !profile) return { provider: null, configured: false, source: 'none' };
  if (!profile && !environmentKey) return { provider: 'qcc-mcp', configured: false, source: 'none' };
  let key = environmentKey;
  if (!key && platform === 'win32') {
    if (profile.protection !== 'dpapi-current-user' || typeof profile.protected_key !== 'string' || !profile.protected_key || 'apiKey' in profile) fail();
    try { key = decryptKey(configFile); } catch { throw new Error('无法解密企业资料凭据，请使用保存配置的 Windows 用户运行'); }
  } else if (!key) {
    if (profile.protection !== 'file-permissions' || 'protected_key' in profile) fail();
    key = profile.apiKey;
  }
  if (!validKey(key)) fail();
  env.CRM_COMPANY_PROFILE_PROVIDER = 'qcc-mcp';
  env.QCC_MCP_API_KEY = key;
  return { provider: 'qcc-mcp', configured: true, source: environmentKey ? 'environment' : 'private-file' };
}

// Safe command-line inspection: no raw configuration or credential output.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--status') throw new Error('仅支持 --status；保存凭据请使用隐藏输入工具');
    console.log(JSON.stringify(prepareCompanyProfile(projectRoot)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
