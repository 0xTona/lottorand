import { EntropyCommitment, EntropyReveal, toBigInt } from '../types/index.js';
import {
  keccak256Hex,
  keccak256Hash,
  signMessage,
  verifySignature,
  deriveAddress,
  fromHex,
  toHex,
  aggregateSecretsXOR
} from '../crypto/keys.js';

export function getCommitmentSigningData(c: Omit<EntropyCommitment, 'signature'>): string {
  return JSON.stringify({
    roundId: c.roundId,
    validator: c.validator,
    commitment: c.commitment,
    lockedStake: c.lockedStake.toString(),
    timestamp: c.timestamp,
    publicKey: c.publicKey
  });
}

export function getRevealSigningData(r: Omit<EntropyReveal, 'signature'>): string {
  return JSON.stringify({
    roundId: r.roundId,
    validator: r.validator,
    secret: r.secret,
    timestamp: r.timestamp,
    publicKey: r.publicKey
  });
}

export function createEntropyCommitment(params: {
  roundId: number;
  validator: string;
  secret: Uint8Array;
  lockedStake: bigint | number | string;
  privateKey: string;
  publicKey: string;
}): EntropyCommitment {
  const commitment = keccak256Hex(params.secret);
  const timestamp = Date.now();
  const lockedStake = toBigInt(params.lockedStake);
  const unsigned = {
    roundId: params.roundId,
    validator: params.validator,
    commitment,
    lockedStake,
    timestamp,
    publicKey: params.publicKey
  };
  const signingData = getCommitmentSigningData(unsigned);
  const sig = signMessage(signingData, params.privateKey);

  return {
    ...unsigned,
    signature: sig
  };
}

export function createEntropyReveal(params: {
  roundId: number;
  validator: string;
  secret: Uint8Array;
  privateKey: string;
  publicKey: string;
}): EntropyReveal {
  const secretHex = toHex(params.secret);
  const timestamp = Date.now();
  const unsigned = {
    roundId: params.roundId,
    validator: params.validator,
    secret: secretHex,
    timestamp,
    publicKey: params.publicKey
  };
  const signingData = getRevealSigningData(unsigned);
  const sig = signMessage(signingData, params.privateKey);

  return {
    ...unsigned,
    signature: sig
  };
}

export function verifyEntropyCommitment(c: EntropyCommitment): { valid: boolean; error?: string } {
  const expectedValidator = deriveAddress(c.publicKey);
  if (c.validator !== expectedValidator) {
    return { valid: false, error: 'Validator address does not match public key' };
  }
  const unsigned = {
    roundId: c.roundId,
    validator: c.validator,
    commitment: c.commitment,
    lockedStake: c.lockedStake,
    timestamp: c.timestamp,
    publicKey: c.publicKey
  };
  const signingData = getCommitmentSigningData(unsigned);
  if (!verifySignature(c.signature, signingData, c.publicKey)) {
    return { valid: false, error: 'Invalid commitment signature' };
  }
  return { valid: true };
}

export function verifyEntropyReveal(
  r: EntropyReveal,
  commitment: EntropyCommitment
): { valid: boolean; error?: string } {
  if (r.roundId !== commitment.roundId) {
    return { valid: false, error: 'Round ID mismatch between reveal and commitment' };
  }
  if (r.validator !== commitment.validator) {
    return { valid: false, error: 'Validator address mismatch between reveal and commitment' };
  }
  const expectedValidator = deriveAddress(r.publicKey);
  if (r.validator !== expectedValidator) {
    return { valid: false, error: 'Validator address does not match public key' };
  }
  const unsigned = {
    roundId: r.roundId,
    validator: r.validator,
    secret: r.secret,
    timestamp: r.timestamp,
    publicKey: r.publicKey
  };
  const signingData = getRevealSigningData(unsigned);
  if (!verifySignature(r.signature, signingData, r.publicKey)) {
    return { valid: false, error: 'Invalid reveal signature' };
  }

  // Cryptographic preimage check: Keccak256(secret) == commitment
  const secretBytes = fromHex(r.secret);
  const computedHash = keccak256Hex(secretBytes);
  if (computedHash !== commitment.commitment) {
    return {
      valid: false,
      error: `Preimage mismatch: computed ${computedHash}, expected commitment ${commitment.commitment}`
    };
  }

  return { valid: true };
}

/**
 * Aggregates entropy secrets:
 * R = Keccak256(s_1 ⊕ s_2 ⊕ ... ⊕ s_k)
 */
export function aggregateEntropy(reveals: EntropyReveal[]): { seedHex: string; seedBigInt: bigint } {
  if (reveals.length === 0) {
    const emptySeed = keccak256Hex('no-reveals');
    return { seedHex: emptySeed, seedBigInt: BigInt('0x' + emptySeed) };
  }

  // Sort reveals deterministically by validator address
  const sorted = [...reveals].sort((a, b) => a.validator.localeCompare(b.validator));
  const secretByteArrays = sorted.map((r) => fromHex(r.secret));

  // XOR aggregation
  const xorAggregated = aggregateSecretsXOR(secretByteArrays);
  const finalDigestBytes = keccak256Hash(xorAggregated);
  const seedHex = toHex(finalDigestBytes);
  const seedBigInt = BigInt('0x' + seedHex);

  return { seedHex, seedBigInt };
}

export function calculateWinningTicketIndex(seedHex: string, totalTickets: number): number {
  if (totalTickets <= 0) return 0;
  const seedBigInt = BigInt('0x' + seedHex);
  const total = BigInt(totalTickets);
  const winningIndex = Number(seedBigInt % total);
  return winningIndex;
}
