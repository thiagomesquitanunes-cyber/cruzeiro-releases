// ─────────────────────────────────────────────────────────────
// crypto-utils.js
// Criptografia E2E para o Cruzeiro (Opção B).
//
// Algoritmo: XChaCha20-Poly1305 (autenticado, resistente a
//   replay, nonce de 24 bytes que praticamente nunca colide)
// Derivação de chave: PBKDF2-SHA256, 100.000 iterações
//
// Funciona identicamente em Node.js (desktop Electron) e
// React Native / Expo (mobile) — puro JavaScript, sem módulos
// nativos. Usa @stablelib/xchacha20poly1305 + @stablelib/pbkdf2.
//
// IMPORTANTE: este arquivo é idêntico no desktop e no mobile.
// Qualquer mudança aqui precisa ser replicada nos dois lados.
// ─────────────────────────────────────────────────────────────

// As dependências são puro JS — sem bindings nativos.
// Desktop:  npm install @stablelib/xchacha20poly1305 @stablelib/pbkdf2 @stablelib/sha256 @stablelib/random
// Mobile:   npm install @stablelib/xchacha20poly1305 @stablelib/pbkdf2 @stablelib/sha256 @stablelib/random

const { XChaCha20Poly1305 } = require('@stablelib/xchacha20poly1305');
const { deriveKey }          = require('@stablelib/pbkdf2');
const { SHA256 }             = require('@stablelib/sha256');
const { randomBytes }        = require('@stablelib/random');

// ─── Constantes ───────────────────────────────────────────────
const KEY_BYTES      = 32;   // 256 bits — chave XChaCha20-Poly1305
const SALT_BYTES     = 32;   // 256 bits — salt do PBKDF2
const NONCE_BYTES    = 24;   // XChaCha20 usa nonce de 24 bytes
const PBKDF2_ITERS   = 100_000;
const ENC_VERSION    = 1;    // prefixo de versão no payload cifrado

// Chave de dados em memória (nunca vai para disco em texto puro)
let _dataKey = null;

// ─── Utilitários de encoding ──────────────────────────────────

function toB64(bytes) {
  // Compatível com Node.js e React Native (usa btoa se disponível)
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  // React Native — converte Uint8Array para string binária e usa btoa
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromB64(str) {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(str, 'base64'));
  }
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeText(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  return new Uint8Array(Buffer.from(str, 'utf8'));
}

function decodeText(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  return Buffer.from(bytes).toString('utf8');
}

// ─── Derivação de chave ───────────────────────────────────────

/**
 * Deriva uma chave de 32 bytes a partir da senha + salt.
 * Usada para cifrar/decifrar a chave de dados.
 */
function deriveKeyFromPassword(password, saltBytes) {
  return deriveKey(SHA256, encodeText(password), saltBytes, PBKDF2_ITERS, KEY_BYTES);
}

// ─── Operações com a chave de dados ──────────────────────────

/**
 * Gera uma nova chave de dados aleatória (primeira vez do usuário).
 * Retorna { encryptedKey: string (base64), salt: string (base64) }
 */
function generateAndEncryptDataKey(password) {
  const salt        = randomBytes(SALT_BYTES);
  const dataKey     = randomBytes(KEY_BYTES);
  const derivedKey  = deriveKeyFromPassword(password, salt);
  const nonce       = randomBytes(NONCE_BYTES);
  const cipher      = new XChaCha20Poly1305(derivedKey);
  const encrypted   = cipher.seal(nonce, dataKey);

  // Payload: versão (1 byte) + nonce (24 bytes) + ciphertext
  const payload = new Uint8Array(1 + NONCE_BYTES + encrypted.length);
  payload[0] = ENC_VERSION;
  payload.set(nonce, 1);
  payload.set(encrypted, 1 + NONCE_BYTES);

  return {
    encryptedKey: toB64(payload),
    salt:         toB64(salt),
  };
}

/**
 * Decifra a chave de dados usando a senha do usuário.
 * Retorna true se sucesso, false se senha errada.
 */
function unlockDataKey(password, encryptedKeyB64, saltB64) {
  try {
    const salt       = fromB64(saltB64);
    const derivedKey = deriveKeyFromPassword(password, salt);
    const payload    = fromB64(encryptedKeyB64);

    // Lê versão
    const version = payload[0];
    if (version !== ENC_VERSION) throw new Error(`Versão de criptografia desconhecida: ${version}`);

    const nonce      = payload.slice(1, 1 + NONCE_BYTES);
    const ciphertext = payload.slice(1 + NONCE_BYTES);
    const cipher     = new XChaCha20Poly1305(derivedKey);
    const dataKey    = cipher.open(nonce, ciphertext);

    if (!dataKey) return false; // senha errada — open retorna null

    _dataKey = dataKey;
    return true;
  } catch (e) {
    console.error('[crypto] erro ao decifrar chave de dados:', e.message);
    return false;
  }
}

/**
 * Re-cifra a chave de dados com uma nova senha (troca de senha).
 * Requer que a chave já esteja desbloqueada (_dataKey != null).
 */
function reencryptDataKey(newPassword) {
  if (!_dataKey) throw new Error('[crypto] chave de dados não está desbloqueada');
  const salt        = randomBytes(SALT_BYTES);
  const derivedKey  = deriveKeyFromPassword(newPassword, salt);
  const nonce       = randomBytes(NONCE_BYTES);
  const cipher      = new XChaCha20Poly1305(derivedKey);
  const encrypted   = cipher.seal(nonce, _dataKey);

  const payload = new Uint8Array(1 + NONCE_BYTES + encrypted.length);
  payload[0] = ENC_VERSION;
  payload.set(nonce, 1);
  payload.set(encrypted, 1 + NONCE_BYTES);

  return {
    encryptedKey: toB64(payload),
    salt:         toB64(salt),
  };
}

/** Remove a chave de dados da memória (logout). */
function lockDataKey() {
  if (_dataKey) _dataKey.fill(0); // limpa da memória
  _dataKey = null;
}

/** Retorna true se a chave de dados está disponível para uso. */
function isUnlocked() {
  return _dataKey !== null;
}

// ─── Cifrar / Decifrar valores ────────────────────────────────

/**
 * Cifra um valor (number ou string) com a chave de dados.
 * Retorna string base64 com nonce + ciphertext.
 * Retorna null se a chave não estiver disponível.
 */
function encrypt(value) {
  if (!_dataKey) return null;
  try {
    const plaintext = encodeText(JSON.stringify(value));
    const nonce     = randomBytes(NONCE_BYTES);
    const cipher    = new XChaCha20Poly1305(_dataKey);
    const encrypted = cipher.seal(nonce, plaintext);

    const payload = new Uint8Array(NONCE_BYTES + encrypted.length);
    payload.set(nonce, 0);
    payload.set(encrypted, NONCE_BYTES);
    return toB64(payload);
  } catch (e) {
    console.error('[crypto] erro ao cifrar:', e.message);
    return null;
  }
}

/**
 * Decifra um valor cifrado por encrypt().
 * Retorna o valor original (number, string, object) ou null se falhar.
 */
function decrypt(encryptedB64) {
  if (!_dataKey || !encryptedB64) return null;
  try {
    const payload    = fromB64(encryptedB64);
    const nonce      = payload.slice(0, NONCE_BYTES);
    const ciphertext = payload.slice(NONCE_BYTES);
    const cipher     = new XChaCha20Poly1305(_dataKey);
    const plaintext  = cipher.open(nonce, ciphertext);
    if (!plaintext) return null;
    return JSON.parse(decodeText(plaintext));
  } catch (e) {
    return null;
  }
}

/**
 * Cifra um objeto JSON inteiro (para by_category, breakdown, etc).
 * Equivale a encrypt(JSON.stringify(obj)) mas mais semântico.
 */
function encryptJSON(obj) {
  return encrypt(obj);
}

function decryptJSON(encryptedB64) {
  return decrypt(encryptedB64);
}

// ─── Exports ──────────────────────────────────────────────────
module.exports = {
  // Gerenciamento de chave
  generateAndEncryptDataKey,
  unlockDataKey,
  reencryptDataKey,
  lockDataKey,
  isUnlocked,

  // Cripto de campo
  encrypt,
  decrypt,
  encryptJSON,
  decryptJSON,
};
