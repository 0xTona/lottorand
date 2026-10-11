import { Transaction, TxType, AccountState, toBigInt, ONE_ETHER } from '../types/index.js';
import { keccak256Hex, signMessage, verifySignature, deriveAddress, fromHex } from '../crypto/keys.js';

export function getTxSigningData(tx: Omit<Transaction, 'id' | 'signature'>): string {
  return JSON.stringify({
    type: tx.type,
    sender: tx.sender,
    recipient: tx.recipient || null,
    amount: tx.amount.toString(),
    roundId: tx.roundId ?? null,
    ticketCount: tx.ticketCount ?? null,
    ticketPrice: tx.ticketPrice !== undefined ? tx.ticketPrice.toString() : null,
    nonce: tx.nonce,
    fee: tx.fee.toString(),
    timestamp: tx.timestamp,
    publicKey: tx.publicKey
  });
}

export function createTransaction(params: {
  type: TxType;
  sender: string;
  recipient?: string;
  amount: bigint | number | string;
  nonce: number;
  fee?: bigint | number | string;
  roundId?: number;
  ticketCount?: number;
  ticketPrice?: bigint | number | string;
  privateKey: string;
  publicKey: string;
}): Transaction {
  const timestamp = Date.now();
  const amount = toBigInt(params.amount);
  const fee = params.fee !== undefined ? toBigInt(params.fee) : ONE_ETHER / 1000n;
  const ticketPrice = params.ticketPrice !== undefined ? toBigInt(params.ticketPrice) : undefined;
  const unsigned = {
    type: params.type,
    sender: params.sender,
    recipient: params.recipient,
    amount,
    roundId: params.roundId,
    ticketCount: params.ticketCount,
    ticketPrice,
    nonce: params.nonce,
    fee,
    timestamp,
    publicKey: params.publicKey
  };

  const signingData = getTxSigningData(unsigned);
  const id = keccak256Hex(signingData);
  const signature = signMessage(id, params.privateKey);

  return {
    ...unsigned,
    id,
    signature
  };
}

export function verifyTransaction(tx: Transaction, account?: AccountState): { valid: boolean; error?: string } {
  if (tx.amount < 0n || tx.fee < 0n) {
    return { valid: false, error: 'Negative amount or fee' };
  }

  // Check derived address
  const expectedSender = deriveAddress(tx.publicKey);
  if (tx.sender !== expectedSender) {
    return { valid: false, error: `Sender address mismatch: expected ${expectedSender}, got ${tx.sender}` };
  }

  // Check signature
  const unsigned = {
    type: tx.type,
    sender: tx.sender,
    recipient: tx.recipient,
    amount: tx.amount,
    roundId: tx.roundId,
    ticketCount: tx.ticketCount,
    ticketPrice: tx.ticketPrice,
    nonce: tx.nonce,
    fee: tx.fee,
    timestamp: tx.timestamp,
    publicKey: tx.publicKey
  };
  const signingData = getTxSigningData(unsigned);
  const expectedId = keccak256Hex(signingData);
  if (tx.id !== expectedId) {
    return { valid: false, error: 'Transaction ID hash mismatch' };
  }

  if (!verifySignature(tx.signature, tx.id, tx.publicKey)) {
    return { valid: false, error: 'Invalid transaction cryptographic signature' };
  }

  // Account state checks if provided
  if (account) {
    if (tx.nonce !== account.nonce) {
      return { valid: false, error: `Invalid nonce: expected ${account.nonce}, got ${tx.nonce}` };
    }
    const totalRequired = tx.amount + tx.fee;
    if (account.balance < totalRequired) {
      return { valid: false, error: `Insufficient balance: has ${account.balance}, needs ${totalRequired}` };
    }
  }

  return { valid: true };
}

export class Mempool {
  private transactions: Map<string, Transaction> = new Map();

  addTransaction(tx: Transaction, account?: AccountState): { accepted: boolean; error?: string } {
    if (this.transactions.has(tx.id)) {
      return { accepted: false, error: 'Transaction already in mempool' };
    }

    const verification = verifyTransaction(tx, account);
    if (!verification.valid) {
      return { accepted: false, error: verification.error };
    }

    this.transactions.set(tx.id, tx);
    return { accepted: true };
  }

  getPending(limit?: number): Transaction[] {
    const list = Array.from(this.transactions.values());
    // Sort descending by fee (miner priority)
    list.sort((a, b) => (b.fee > a.fee ? 1 : b.fee < a.fee ? -1 : 0));
    if (limit && limit > 0) {
      return list.slice(0, limit);
    }
    return list;
  }

  removeTransactions(txIds: string[]): void {
    for (const id of txIds) {
      this.transactions.delete(id);
    }
  }

  clear(): void {
    this.transactions.clear();
  }

  size(): number {
    return this.transactions.size;
  }
}
