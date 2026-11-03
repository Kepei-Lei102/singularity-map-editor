// NPC 角色密档：浏览器里只在内存里解。不落盘、不进 world.json、不进 localStorage。
// 格式与 爱丽丝模组/人物卡/工具/密档.mjs 一致：qdz-npc-enc/v1，
// PBKDF2-HMAC-SHA512（60 万次，16 字节盐）+ AES-256-GCM（12 字节 IV，tag 单独存）。
// 纯 JS、只用 WebCrypto，所以 node 测试和 vite 都能直接 import。

export const VAULT_FORMAT = 'qdz-npc-enc/v1';
export const VAULT_MIN_ITERATIONS = 100000;

const decodeB64 = (s) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

/** 读进密档信封并检查结构；不碰口令，也不碰密文内容。 */
export function parseVault(input) {
  let env;
  if (typeof input === 'string') {
    try { env = JSON.parse(input); } catch { throw new Error('这不是密档：文件内容不是 JSON'); }
  } else env = input;
  if (!env || typeof env !== 'object') throw new Error('这不是密档：内容是空的');
  if (env.format !== VAULT_FORMAT) throw new Error(`不认识的文件格式：${String(env.format ?? '（缺 format）')}`);
  if (env.cipher !== 'aes-256-gcm') throw new Error(`不认识的加密方式：${String(env.cipher)}`);
  const kdf = env.kdf;
  if (!kdf || typeof kdf.salt !== 'string' || !Number.isInteger(kdf.iterations)) throw new Error('密档的密钥参数不完整');
  if (kdf.iterations < VAULT_MIN_ITERATIONS) throw new Error('密档的密钥参数不可信（迭代次数过低）');
  if (typeof env.iv !== 'string' || typeof env.tag !== 'string' || typeof env.ct !== 'string') throw new Error('密档的密文段不完整');
  return env;
}

/** 给界面看的元信息：只有格式，没有内容。 */
export function vaultInfo(env) {
  const bytes = Math.round((env.ct.length * 3) / 4);
  return {
    format: env.format,
    cipher: env.cipher,
    kdf: `${env.kdf.name} · ${env.kdf.iterations.toLocaleString('en-US')} 次`,
    bytes,
  };
}

/** 用口令解开密档，返回明文。失败一律抛错，绝不返回半截内容。 */
export async function unlockVault(input, passphrase) {
  const env = parseVault(input);
  if (!passphrase) throw new Error('口令不能为空');
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('这个环境不支持 WebCrypto，解不了密档');

  let key;
  try {
    const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    key = await subtle.deriveKey(
      { name: 'PBKDF2', salt: decodeB64(env.kdf.salt), iterations: env.kdf.iterations, hash: 'SHA-512' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
  } catch { throw new Error('密钥派生失败：这个浏览器的 WebCrypto 不支持该参数'); }

  const ct = decodeB64(env.ct);
  const tag = decodeB64(env.tag);
  const data = new Uint8Array(ct.length + tag.length);
  data.set(ct, 0);
  data.set(tag, ct.length);

  let plain;
  try { plain = await subtle.decrypt({ name: 'AES-GCM', iv: decodeB64(env.iv) }, key, data); }
  catch { throw new Error('口令不对，或者密档被改过'); }
  return new TextDecoder().decode(plain);
}
