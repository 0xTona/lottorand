// Polyfill BigInt.prototype.toJSON for clean JSON serialization
if (typeof BigInt !== 'undefined' && !(BigInt.prototype as any).toJSON) {
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };
}

export const ONE_ETHER = 10n ** 18n;
export const DEFAULT_TICKET_PRICE = 10n ** 16n; // 0.01 Token (10^16 wei)
export const MIN_VALIDATOR_STAKE = 100n * ONE_ETHER; // 100 Tokens

export function parseEther(etherStrOrNum: string | number): bigint {
  const parts = etherStrOrNum.toString().split('.');
  const whole = BigInt(parts[0]) * ONE_ETHER;
  if (!parts[1]) return whole;
  const fractionStr = parts[1].slice(0, 18).padEnd(18, '0');
  return whole + BigInt(fractionStr);
}

export function formatEther(wei: bigint): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / ONE_ETHER;
  const fraction = abs % ONE_ETHER;
  if (fraction === 0n) return (negative ? '-' : '') + whole.toString();
  const fracStr = fraction.toString().padStart(18, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}.${fracStr}`;
}

export function toBigInt(val: bigint | number | string | undefined | null, defaultVal = 0n): bigint {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') return BigInt(Math.floor(val));
  if (typeof val === 'string') {
    if (val.startsWith('0x') || val.startsWith('0X')) return BigInt(val);
    return BigInt(val || '0');
  }
  return defaultVal;
}

export type TxType = 'TRANSFER' | 'STAKE' | 'UNSTAKE' | 'BUY_TICKET';

export interface Transaction {
  id: string; // SHA256 tx hash
  type: TxType;
  sender: string;
  recipient?: string;
  amount: bigint;
  roundId?: number;
  ticketCount?: number;
  ticketPrice?: bigint;
  nonce: number;
  fee: bigint;
  timestamp: number;
  publicKey: string;
  signature: string;
}

export interface EntropyCommitment {
  roundId: number;
  validator: string;
  commitment: string; // sha256(secret)
  lockedStake: bigint;
  timestamp: number;
  publicKey: string;
  signature: string;
}

export interface EntropyReveal {
  roundId: number;
  validator: string;
  secret: string; // 32 bytes hex
  timestamp: number;
  publicKey: string;
  signature: string;
}

export type RoundPhase = 'OPEN' | 'COMMIT' | 'REVEAL' | 'DRAW' | 'COMPLETED';

export interface Ticket {
  ticketIndex: number;
  buyer: string;
  txId: string;
}

export interface SlashedValidatorRecord {
  validator: string;
  slashedStake: bigint;
  burnedAmount: bigint;
  bountyAmount: bigint;
}

export interface RoundOutcome {
  roundId: number;
  winningTicketIndex: number;
  winnerAddress: string;
  jackpot: bigint;
  payoutAmount: bigint;     // 90%
  validatorFeePool: bigint; // 5%
  rolloverAmount: bigint;   // 5%
  revealedValidators: string[];
  slashedValidators: SlashedValidatorRecord[];
  aggregatedSeedHex: string;
  drawnAt: number;
}

export interface LotteryRound {
  id: number;
  phase: RoundPhase;
  ticketPrice: bigint;
  tickets: Ticket[];
  commitments: Record<string, EntropyCommitment>;
  reveals: Record<string, EntropyReveal>;
  jackpot: bigint;
  rolloverFromPrev: bigint;
  createdAtBlock: number;
  commitStartBlock: number;
  revealStartBlock: number;
  drawBlock: number;
  outcome?: RoundOutcome;
}

export interface Validator {
  address: string;
  publicKey: string;
  stake: bigint;
  lockedStake: bigint;
  slashed: boolean;
  slashCount: number;
  totalRewardsEarned: bigint;
}

export interface AccountState {
  address: string;
  balance: bigint;
  nonce: number;
}

export interface BlockHeader {
  index: number;
  previousHash: string;
  timestamp: number;
  stateRoot: string;
  txRoot: string;
  proposer: string;
  roundId: number;
  entropyRoot: string;
}

export interface Block {
  header: BlockHeader;
  hash: string;
  signature: string;
  transactions: Transaction[];
  commitments: EntropyCommitment[];
  reveals: EntropyReveal[];
  roundOutcome?: RoundOutcome;
}

export interface ChainState {
  accounts: Record<string, AccountState>;
  validators: Record<string, Validator>;
  currentRound: LotteryRound;
  pastRounds: Record<number, LotteryRound>;
  totalBurned: bigint;
}
