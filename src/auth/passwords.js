const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

const INVALID_PASSWORD_HASH_OIDC = '!OIDC_ONLY';
const INVALID_PASSWORD_HASH_LOCAL_DISABLED = '!LOCAL_DISABLED';

function normalizePasswordInput(password, fieldName = 'password') {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return password;
}

function resolvePasswordPepper(authConfig = {}, env = process.env) {
  const localConfig = authConfig.local || {};
  const envVarName =
    typeof localConfig.passwordPepperEnvVar === 'string' && localConfig.passwordPepperEnvVar.trim() !== ''
      ? localConfig.passwordPepperEnvVar.trim()
      : null;

  if (envVarName && typeof env[envVarName] === 'string' && env[envVarName] !== '') {
    return env[envVarName];
  }

  return typeof localConfig.passwordPepper === 'string' ? localConfig.passwordPepper : '';
}

function isPasswordHashUsable(passwordHash) {
  return typeof passwordHash === 'string' && passwordHash.startsWith('scrypt$');
}

async function hashPassword(password, pepper = '') {
  const normalizedPassword = normalizePasswordInput(password);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derivedKey = await scryptAsync(normalizedPassword + String(pepper || ''), salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  });

  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64'),
    Buffer.from(derivedKey).toString('base64')
  ].join('$');
}

async function verifyPassword(password, passwordHash, pepper = '') {
  const normalizedPassword = normalizePasswordInput(password);
  if (!isPasswordHashUsable(passwordHash)) {
    return false;
  }

  const parts = String(passwordHash).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');

  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelization)) {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }

  const derivedKey = await scryptAsync(normalizedPassword + String(pepper || ''), salt, expected.length, {
    N: cost,
    r: blockSize,
    p: parallelization
  });

  const actual = Buffer.from(derivedKey);
  if (actual.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(actual, expected);
}

module.exports = {
  INVALID_PASSWORD_HASH_OIDC,
  INVALID_PASSWORD_HASH_LOCAL_DISABLED,
  isPasswordHashUsable,
  resolvePasswordPepper,
  hashPassword,
  verifyPassword
};
