import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${clean.length}`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

export function toBytes(data: Uint8Array | string): Uint8Array {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  return data;
}

/**
 * Ethereum-standard Keccak-256 hash
 */
export function keccak256Hash(data: Uint8Array | string): Uint8Array {
  return keccak_256(toBytes(data));
}

export function keccak256Hex(data: Uint8Array | string): string {
  return toHex(keccak256Hash(data));
}

// Aliases for unified hashing across the blockchain
export const sha256Hash = keccak256Hash;
export const sha256Hex = keccak256Hex;

/**
 * EIP-55 mixed-case checksum address encoder
 */
export function toChecksumAddress(addrHex: string): string {
  const clean = addrHex.toLowerCase().replace('0x', '');
  const hash = toHex(keccak_256(new TextEncoder().encode(clean)));
  let ret = '0x';
  for (let i = 0; i < clean.length; i++) {
    if (parseInt(hash[i], 16) >= 8) {
      ret += clean[i].toUpperCase();
    } else {
      ret += clean[i];
    }
  }
  return ret;
}

/**
 * Derive Ethereum address from secp256k1 public key:
 * Address = EIP55(keccak256(uncompressedPublicKey[1..64])[-20..])
 */
export function deriveAddress(publicKeyHex: string): string {
  const clean = publicKeyHex.startsWith('0x') ? publicKeyHex.slice(2) : publicKeyHex;
  const point = secp256k1.Point.fromHex(clean);
  const uncompressed = point.toBytes(false); // 65 bytes: 0x04 + 64 bytes
  const hash = keccak_256(uncompressed.slice(1));
  const rawAddr = toHex(hash.slice(-20));
  return toChecksumAddress(rawAddr);
}

export interface KeyPair {
  privateKey: string; // hex (without 0x prefix or with)
  publicKey: string;  // compressed hex
  address: string;    // 0x-prefixed EIP-55 checksum address
}

export function generateKeypair(): KeyPair {
  const pair = secp256k1.keygen();
  const privHex = toHex(pair.secretKey);
  const pubHex = toHex(pair.publicKey);
  const address = deriveAddress(pubHex);
  return {
    privateKey: privHex,
    publicKey: pubHex,
    address
  };
}

export function keypairFromPrivateHex(privateKeyHex: string): KeyPair {
  const clean = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex;
  const secretKey = fromHex(clean);
  const publicKeyBytes = secp256k1.getPublicKey(secretKey, true); // compressed
  const pubHex = toHex(publicKeyBytes);
  return {
    privateKey: clean,
    publicKey: pubHex,
    address: deriveAddress(pubHex)
  };
}

export function signMessage(message: Uint8Array | string, privateKeyHex: string): string {
  const msgHash = keccak256Hash(message);
  const clean = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex;
  const privBytes = fromHex(clean);
  const sig = secp256k1.sign(msgHash, privBytes);
  return toHex(sig);
}

export function verifySignature(signatureHex: string, message: Uint8Array | string, publicKeyHex: string): boolean {
  try {
    const cleanSig = signatureHex.startsWith('0x') ? signatureHex.slice(2) : signatureHex;
    const cleanPub = publicKeyHex.startsWith('0x') ? publicKeyHex.slice(2) : publicKeyHex;
    const sigBytes = fromHex(cleanSig);
    const pubBytes = fromHex(cleanPub);
    const msgHash = keccak256Hash(message);
    return secp256k1.verify(sigBytes, msgHash, pubBytes);
  } catch {
    return false;
  }
}

/**
 * XOR aggregation of 32-byte secret values
 */
export function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const len = Math.max(a.length, b.length);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const byteA = i < a.length ? a[i] : 0;
    const byteB = i < b.length ? b[i] : 0;
    out[i] = byteA ^ byteB;
  }
  return out;
}

export function aggregateSecretsXOR(secrets: Uint8Array[]): Uint8Array {
  if (secrets.length === 0) {
    return new Uint8Array(32);
  }
  let acc: Uint8Array = new Uint8Array(secrets[0].length);
  acc.set(secrets[0]);
  for (let i = 1; i < secrets.length; i++) {
    acc = xorBytes(acc, secrets[i]);
  }
  return acc;
}
