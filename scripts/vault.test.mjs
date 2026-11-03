import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { parseVault, unlockVault, vaultInfo, VAULT_FORMAT } from '../src/vault.js';

const TEXT = '# 测试密档\n\n这一段只应该出现在内存里。\n';

function envelope(pass, text = TEXT, iterations = 600000) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = pbkdf2Sync(Buffer.from(pass, 'utf8'), salt, iterations, 32, 'sha512');
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return {
    format: VAULT_FORMAT,
    cipher: 'aes-256-gcm',
    kdf: { name: 'pbkdf2-hmac-sha512', iterations, keylen: 32, digest: 'sha512', salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

test('正确口令能解开，内容一字符不差', async () => {
  const env = envelope('正确的口令');
  assert.equal(await unlockVault(env, '正确的口令'), TEXT);
});

test('口令错了就报错，不吐半截内容', async () => {
  const env = envelope('正确的口令');
  await assert.rejects(() => unlockVault(env, '错误的'), /口令不对/);
});

test('密文被改过一个字节就报错', async () => {
  const env = envelope('正确的口令');
  const raw = Buffer.from(env.ct, 'base64');
  raw[0] ^= 0xff;
  await assert.rejects(() => unlockVault({ ...env, ct: raw.toString('base64') }, '正确的口令'), /口令不对|被改过/);
});

test('不是密档的输入被拒，并说清是哪儿不对', () => {
  assert.throws(() => parseVault('not json'), /不是 JSON/);
  assert.throws(() => parseVault({}), /不认识的文件格式/);
  assert.throws(() => parseVault({ format: 'other', cipher: 'aes-256-gcm' }), /不认识的文件格式/);
});

test('迭代次数低得离谱的密档被拒', () => {
  const env = envelope('口令', TEXT, 1000);
  assert.throws(() => parseVault(env), /迭代次数过低/);
});

test('info 只报格式，不碰内容', () => {
  const env = envelope('口令');
  const info = vaultInfo(env);
  assert.equal(info.cipher, 'aes-256-gcm');
  assert.match(info.kdf, /600,000/);
  assert.ok(info.bytes > 0);
  assert.equal(JSON.stringify(info).includes('测试密档'), false);
});
