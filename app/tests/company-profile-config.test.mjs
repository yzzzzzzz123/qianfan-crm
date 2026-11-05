import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { prepareCompanyProfile } from '../../local/company-profile-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureKey = 'isolated-qcc-key-not-a-real-credential';
function fixture(t, profile) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-company-profile-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const privateDir = path.join(directory, '.private');
  fs.mkdirSync(privateDir, { mode: 0o700 });
  const file = path.join(privateDir, 'company-profile.json');
  if (profile) fs.writeFileSync(file, JSON.stringify(profile), { mode: 0o600 });
  return { directory, privateDir, file };
}
const windowsProfile = { provider: 'qcc-mcp', protection: 'dpapi-current-user', protected_key: 'isolated-ciphertext' };
function linuxIO(file, { fileMode = 0o100600, directoryMode = 0o40700, fileUid = 42, directoryUid = 42, symlink = false } = {}) {
  const patch = (stat, isDirectory) => Object.assign(Object.create(stat), { mode: isDirectory ? directoryMode : fileMode, uid: isDirectory ? directoryUid : fileUid, isSymbolicLink: () => symlink });
  return { ...fs,
    lstatSync: target => patch(fs.lstatSync(target), target !== file),
    openSync: target => fs.openSync(target, 'r'),
    fstatSync: descriptor => patch(fs.fstatSync(descriptor), false),
  };
}

test('企业资料 key 不隐式启用 provider，缺凭据不伪装已配置', t => {
  const f = fixture(t);
  const onlyKey = { QCC_MCP_API_KEY: fixtureKey };
  assert.deepEqual(prepareCompanyProfile(f.directory, { env: onlyKey }), { provider: null, configured: false, source: 'none' });
  assert.equal(onlyKey.CRM_COMPANY_PROFILE_PROVIDER, undefined);
  const selected = { CRM_COMPANY_PROFILE_PROVIDER: 'qcc-mcp' };
  assert.deepEqual(prepareCompanyProfile(f.directory, { env: selected }), { provider: 'qcc-mcp', configured: false, source: 'none' });
});

test('企业资料环境凭据优先且不会读取或解密旧私密文件', () => {
  const env = { CRM_COMPANY_PROFILE_PROVIDER: 'qcc-mcp', QCC_MCP_API_KEY: fixtureKey };
  const status = prepareCompanyProfile('unused', { env, io: { lstatSync() { throw new Error('must not read'); } }, decryptKey() { throw new Error('must not decrypt'); } });
  assert.deepEqual(status, { provider: 'qcc-mcp', configured: true, source: 'environment' });
  assert.equal(JSON.stringify(status).includes(fixtureKey), false);
});

test('显式关闭企业资料 provider 不读取配置、不改变已有环境', () => {
  for (const provider of ['none', 'off', 'disabled']) {
    const env = { CRM_COMPANY_PROFILE_PROVIDER: provider, QCC_MCP_API_KEY: fixtureKey };
    assert.equal(prepareCompanyProfile('unused', { env, io: { lstatSync() { throw new Error('must not read'); } } }).source, 'disabled');
    assert.equal(env.CRM_COMPANY_PROFILE_PROVIDER, provider);
  }
});

test('原企查查 qcc API 配置继续启动，不读取 MCP 文件也不改原凭据', () => {
  for (const configured of [true, false]) {
    const env = { CRM_COMPANY_PROFILE_PROVIDER: 'qcc', QCC_APP_KEY: 'isolated-existing-app', QCC_SECRET_KEY: configured ? 'isolated-existing-secret' : '', QCC_MCP_API_KEY: fixtureKey };
    const before = { ...env };
    const status = prepareCompanyProfile('unused', { env, io: { lstatSync() { throw new Error('must not read MCP config'); } } });
    assert.deepEqual(status, { provider: 'qcc', configured, source: configured ? 'environment' : 'none' });
    assert.deepEqual(env, before);
    assert.equal(JSON.stringify(status).includes('isolated'), false);
  }
});

test('Windows 企业资料只接受 DPAPI 密文，解密异常不泄漏子进程输出', t => {
  const f = fixture(t, windowsProfile);
  const env = {};
  assert.deepEqual(prepareCompanyProfile(f.directory, { env, platform: 'win32', decryptKey: file => { assert.equal(file, f.file); return fixtureKey; } }), { provider: 'qcc-mcp', configured: true, source: 'private-file' });
  assert.equal(env.QCC_MCP_API_KEY, fixtureKey);
  assert.throws(() => prepareCompanyProfile(f.directory, { env: {}, platform: 'win32', decryptKey() { throw new Error(fixtureKey); } }), error => !error.message.includes(fixtureKey) && /无法解密/.test(error.message));
  fs.writeFileSync(f.file, JSON.stringify({ provider: 'qcc-mcp', protection: 'file-permissions', apiKey: fixtureKey }));
  assert.throws(() => prepareCompanyProfile(f.directory, { env: {}, platform: 'win32' }), /私密配置无效/);
});

test('Linux 企业资料仅接受当前用户或 root 所有且无组/他人权限的独立 JSON', t => {
  const f = fixture(t, { provider: 'qcc-mcp', protection: 'file-permissions', apiKey: fixtureKey });
  for (const owner of [0, 42]) {
    const env = {};
    const status = prepareCompanyProfile(f.directory, { env, platform: 'linux', uid: 42, io: linuxIO(f.file, { fileUid: owner, directoryUid: owner }) });
    assert.equal(status.configured, true);
    assert.equal(env.QCC_MCP_API_KEY, fixtureKey);
  }
  for (const patch of [{ fileMode: 0o100644 }, { directoryMode: 0o40755 }, { fileUid: 84 }, { directoryUid: 84 }, { symlink: true }]) {
    assert.throws(() => prepareCompanyProfile(f.directory, { env: {}, platform: 'linux', uid: 42, io: linuxIO(f.file, patch) }), error => !error.message.includes(fixtureKey) && /私密配置无效/.test(error.message));
  }
});

test('无效企业资料 JSON、密钥与 provider 均脱敏失败且不部分写入环境', t => {
  const f = fixture(t);
  for (const content of [`{"apiKey":"${fixtureKey}"`, JSON.stringify({ ...windowsProfile, provider: fixtureKey }), JSON.stringify({ ...windowsProfile, protected_key: '' })]) {
    fs.writeFileSync(f.file, content);
    const env = {};
    assert.throws(() => prepareCompanyProfile(f.directory, { env, platform: 'win32', decryptKey: () => fixtureKey }), error => !error.message.includes(fixtureKey));
    assert.deepEqual(env, {});
  }
  const env = { CRM_COMPANY_PROFILE_PROVIDER: 'qcc-mcp', QCC_MCP_API_KEY: 'bad\ncredential' };
  assert.throws(() => prepareCompanyProfile(f.directory, { env }), error => !error.message.includes('credential'));
});

test('命令行企业资料检查仅输出脱敏状态，无外部请求和真实配置读取', () => {
  const module = path.join(root, 'local/company-profile-config.mjs');
  const options = { encoding: 'utf8', env: { ...process.env, CRM_COMPANY_PROFILE_PROVIDER: 'qcc-mcp', QCC_MCP_API_KEY: fixtureKey }, stdio: ['ignore', 'pipe', 'pipe'] };
  const output = execFileSync(process.execPath, [module, '--status'], options);
  assert.deepEqual(JSON.parse(output), { provider: 'qcc-mcp', configured: true, source: 'environment' });
  assert.equal(output.includes(fixtureKey), false);
  assert.throws(() => execFileSync(process.execPath, [module, '--status'], { ...options, env: { ...options.env, CRM_COMPANY_PROFILE_PROVIDER: fixtureKey } }), error => !String(error.stdout).includes(fixtureKey) && !String(error.stderr).includes(fixtureKey));
});

test('真实 Windows 隔离 DPAPI 保存/读取、拒绝覆盖、密文和回执不含 key', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const save = (key, replace = false) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'local/save-company-profile-key.ps1'), '-ConfigPath', f.file, '-FromStdin', ...(replace ? ['-Replace'] : [])], { input: key, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
  const receipt = save(fixtureKey);
  assert.equal(JSON.parse(receipt).saved, true);
  assert.equal(receipt.includes(fixtureKey), false);
  assert.equal(fs.readFileSync(f.file, 'utf8').includes(fixtureKey), false);
  const env = {};
  assert.equal(prepareCompanyProfile(f.directory, { env }).configured, true);
  assert.equal(env.QCC_MCP_API_KEY, fixtureKey);
  const before = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => save('isolated-replacement-key'), error => !String(error.stdout).includes(fixtureKey) && !String(error.stderr).includes(fixtureKey));
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  save('isolated-replacement-key', true);
  const replaced = {};
  prepareCompanyProfile(f.directory, { env: replaced });
  assert.equal(replaced.QCC_MCP_API_KEY, 'isolated-replacement-key');
});

test('Windows PowerShell 5.1 默认配置路径在执行体解析，隔离副本不依赖 cwd', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const isolatedLocal = path.join(f.directory, 'local');
  fs.mkdirSync(isolatedLocal);
  for (const script of ['save-company-profile-key.ps1', 'read-company-profile-key.ps1']) fs.copyFileSync(path.join(root, 'local', script), path.join(isolatedLocal, script));
  const options = { encoding: 'utf8', windowsHide: true, timeout: 15000, cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] };
  const receipt = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(isolatedLocal, 'save-company-profile-key.ps1'), '-FromStdin'], { ...options, input: fixtureKey });
  assert.equal(JSON.parse(receipt).saved, true);
  assert.equal(fs.existsSync(f.file), true);
  assert.equal(fs.readFileSync(f.file, 'utf8').includes(fixtureKey), false);
  const decrypted = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(isolatedLocal, 'read-company-profile-key.ps1'), '-InternalPipe'], options);
  assert.equal(decrypted, fixtureKey);
});
