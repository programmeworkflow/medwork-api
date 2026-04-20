/**
 * eSocial Certificate Service
 *
 * Handles A1 digital certificate (.pfx/.p12) encryption, decryption,
 * and metadata extraction (CNPJ, titular name, expiry).
 */
const crypto = require('crypto');
const forge = require('node-forge');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Derive a 32-byte key from the env secret using SHA-256.
 * Prefers ESOCIAL_ENCRYPTION_KEY, falls back to JWT_SECRET.
 */
function getEncryptionKey() {
  const secret = process.env.ESOCIAL_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('ESOCIAL_ENCRYPTION_KEY or JWT_SECRET must be set');
  }
  return crypto.createHash('sha256').update(String(secret)).digest();
}

/**
 * Encrypt certificate buffer and its password using AES-256-GCM.
 * Returns the encrypted buffer (iv + authTag + ciphertext concatenated),
 * the encrypted password (base64, with own authTag and iv), and the cert IV (hex).
 */
function encryptCertificate(buffer, password) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('Certificate must be a Buffer');
  }
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string');
  }

  const key = getEncryptionKey();

  // Encrypt the certificate
  const certIv = crypto.randomBytes(IV_LENGTH);
  const certCipher = crypto.createCipheriv(ALGORITHM, key, certIv);
  const certEnc = Buffer.concat([certCipher.update(buffer), certCipher.final()]);
  const certTag = certCipher.getAuthTag();

  // certificate_encrypted = [authTag(16)] + [ciphertext]
  const certificateEncrypted = Buffer.concat([certTag, certEnc]);

  // Encrypt the password (use a fresh IV, embed it in the ciphertext)
  const pwdIv = crypto.randomBytes(IV_LENGTH);
  const pwdCipher = crypto.createCipheriv(ALGORITHM, key, pwdIv);
  const pwdEnc = Buffer.concat([pwdCipher.update(password, 'utf8'), pwdCipher.final()]);
  const pwdTag = pwdCipher.getAuthTag();

  // password_encrypted stores "pwdIv(hex):pwdTag(hex):pwdCiphertext(hex)"
  const passwordEncrypted =
    pwdIv.toString('hex') + ':' + pwdTag.toString('hex') + ':' + pwdEnc.toString('hex');

  return {
    certificateEncrypted,          // BYTEA for DB
    passwordEncrypted,             // TEXT for DB
    iv: certIv.toString('hex'),    // TEXT for DB (cert IV only)
  };
}

/**
 * Decrypt a certificate that was encrypted with encryptCertificate.
 * @param {Buffer} encryptedBuffer - the certificate_encrypted column value (authTag + ciphertext)
 * @param {string} encryptedPassword - the password_encrypted column value (iv:tag:cipher)
 * @param {string} iv - the cert IV (hex)
 * @returns {{ certificate: Buffer, password: string }}
 */
function decryptCertificate(encryptedBuffer, encryptedPassword, iv) {
  if (!Buffer.isBuffer(encryptedBuffer)) {
    encryptedBuffer = Buffer.from(encryptedBuffer);
  }
  const key = getEncryptionKey();

  // Split auth tag from ciphertext for the certificate
  const certTag = encryptedBuffer.slice(0, AUTH_TAG_LENGTH);
  const certCipher = encryptedBuffer.slice(AUTH_TAG_LENGTH);
  const certIv = Buffer.from(iv, 'hex');

  const certDecipher = crypto.createDecipheriv(ALGORITHM, key, certIv);
  certDecipher.setAuthTag(certTag);
  const certificate = Buffer.concat([certDecipher.update(certCipher), certDecipher.final()]);

  // Password: "iv:tag:ciphertext"
  const parts = String(encryptedPassword).split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted password format');
  }
  const [pwdIvHex, pwdTagHex, pwdCipherHex] = parts;
  const pwdIv = Buffer.from(pwdIvHex, 'hex');
  const pwdTag = Buffer.from(pwdTagHex, 'hex');
  const pwdCipher = Buffer.from(pwdCipherHex, 'hex');

  const pwdDecipher = crypto.createDecipheriv(ALGORITHM, key, pwdIv);
  pwdDecipher.setAuthTag(pwdTag);
  const password = Buffer.concat([pwdDecipher.update(pwdCipher), pwdDecipher.final()]).toString('utf8');

  return { certificate, password };
}

/**
 * Extract CNPJ, titular name, and expiry from a .pfx/.p12 buffer.
 * @param {Buffer} buffer - the raw .pfx/.p12 bytes
 * @param {string} password - the certificate password
 * @returns {{ cnpj: string|null, nome: string|null, validUntil: Date|null, validFrom: Date|null, subject: string|null }}
 */
function parseCertificateInfo(buffer, password) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('Certificate must be a Buffer');
  }

  // Convert Node Buffer -> Forge binary string
  const der = forge.util.createBuffer(buffer.toString('binary'));
  const p12Asn1 = forge.asn1.fromDer(der);

  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);
  } catch (err) {
    // Common causes: wrong password, corrupt file
    throw new Error(
      err.message && err.message.toLowerCase().includes('mac')
        ? 'Senha do certificado incorreta'
        : `Não foi possível ler o certificado: ${err.message}`
    );
  }

  // Locate the user certificate bag
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const bags = certBags[forge.pki.oids.certBag] || [];
  if (!bags.length || !bags[0].cert) {
    throw new Error('Certificado de usuário não encontrado no arquivo PFX');
  }
  const cert = bags[0].cert;

  // Subject: typical ICP-Brasil CN: "NOME DA EMPRESA:CNPJ"
  const cnAttr = cert.subject.getField('CN');
  const cn = cnAttr ? cnAttr.value : null;

  let cnpj = null;
  let nome = null;

  if (cn) {
    // Match any 14-digit sequence (with or without punctuation) at the end
    const cnpjMatch = cn.replace(/[^0-9:]/g, '').match(/(\d{14})$/);
    if (cnpjMatch) cnpj = cnpjMatch[1];

    // Name is the part before the ":" or the whole CN if no colon
    const colonIdx = cn.indexOf(':');
    nome = colonIdx > 0 ? cn.slice(0, colonIdx).trim() : cn.trim();
  }

  // Fallback: search in serialNumber or OID 2.5.4.5
  if (!cnpj) {
    try {
      const serial = cert.subject.getField({ name: 'serialName' }) || cert.subject.getField({ type: '2.5.4.5' });
      if (serial && serial.value) {
        const m = String(serial.value).replace(/\D/g, '').match(/(\d{14})/);
        if (m) cnpj = m[1];
      }
    } catch (_) { /* ignore */ }
  }

  // Fallback: scan subjectAltName / extensions for CNPJ (OID 2.16.76.1.3.3)
  if (!cnpj) {
    const altExt = cert.getExtension({ name: 'subjectAltName' });
    if (altExt && altExt.altNames) {
      for (const alt of altExt.altNames) {
        const val = String(alt.value || '');
        const digits = val.replace(/\D/g, '');
        const m = digits.match(/(\d{14})/);
        if (m) { cnpj = m[1]; break; }
      }
    }
  }

  const validFrom = cert.validity.notBefore || null;
  const validUntil = cert.validity.notAfter || null;

  // Serialise full subject for debugging
  const subject = cert.subject.attributes
    .map(a => `${a.shortName || a.name}=${a.value}`)
    .join(', ');

  return { cnpj, nome, validUntil, validFrom, subject };
}

module.exports = {
  encryptCertificate,
  decryptCertificate,
  parseCertificateInfo,
};
