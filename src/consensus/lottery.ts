import {
  LotteryRound,
  RoundOutcome,
  EntropyCommitment,
  EntropyReveal,
  Ticket,
  AccountState,
  DEFAULT_TICKET_PRICE,
  toBigInt
} from '../types/index.js';
import { ValidatorManager } from './validator.js';
import { aggregateEntropy, calculateWinningTicketIndex, verifyEntropyCommitment, verifyEntropyReveal } from './randao.js';

export { DEFAULT_TICKET_PRICE };
export const DEFAULT_ROUND_DURATION_BLOCKS = 5;
export const DEFAULT_COMMIT_DURATION_BLOCKS = 3;
export const DEFAULT_REVEAL_DURATION_BLOCKS = 3;

export class LotteryStateMachine {
  private currentRound: LotteryRound;
  private pastRounds: Map<number, LotteryRound> = new Map();
  private totalBurned: bigint = 0n;

  constructor(
    initialRound?: LotteryRound,
    pastRounds?: Record<number, LotteryRound>,
    totalBurned?: bigint | number | string
  ) {
    if (initialRound) {
      this.currentRound = {
        ...initialRound,
        ticketPrice: toBigInt(initialRound.ticketPrice, DEFAULT_TICKET_PRICE),
        jackpot: toBigInt(initialRound.jackpot),
        rolloverFromPrev: toBigInt(initialRound.rolloverFromPrev)
      };
    } else {
      this.currentRound = this.createNewRound(1, 0n, 0);
    }
    if (pastRounds) {
      for (const [id, r] of Object.entries(pastRounds)) {
        this.pastRounds.set(Number(id), {
          ...r,
          ticketPrice: toBigInt(r.ticketPrice, DEFAULT_TICKET_PRICE),
          jackpot: toBigInt(r.jackpot),
          rolloverFromPrev: toBigInt(r.rolloverFromPrev)
        });
      }
    }
    if (totalBurned !== undefined) {
      this.totalBurned = toBigInt(totalBurned);
    }
  }

  getCurrentRound(): LotteryRound {
    return this.currentRound;
  }

  getPastRound(id: number): LotteryRound | undefined {
    return this.pastRounds.get(id);
  }

  getAllPastRounds(): LotteryRound[] {
    return Array.from(this.pastRounds.values());
  }

  getTotalBurned(): bigint {
    return this.totalBurned;
  }

  createNewRound(id: number, rolloverAmount: bigint | number | string, currentBlock: number): LotteryRound {
    const rollover = toBigInt(rolloverAmount);
    return {
      id,
      phase: 'OPEN',
      ticketPrice: DEFAULT_TICKET_PRICE,
      tickets: [],
      commitments: {},
      reveals: {},
      jackpot: rollover,
      rolloverFromPrev: rollover,
      createdAtBlock: currentBlock,
      commitStartBlock: currentBlock + DEFAULT_ROUND_DURATION_BLOCKS,
      revealStartBlock: currentBlock + DEFAULT_ROUND_DURATION_BLOCKS + DEFAULT_COMMIT_DURATION_BLOCKS,
      drawBlock: currentBlock + DEFAULT_ROUND_DURATION_BLOCKS + DEFAULT_COMMIT_DURATION_BLOCKS + DEFAULT_REVEAL_DURATION_BLOCKS
    };
  }

  buyTickets(
    buyer: string,
    ticketCount: number,
    ticketPrice: bigint | number | string,
    txId: string
  ): { success: boolean; error?: string; ticketIndices?: number[] } {
    if (this.currentRound.phase !== 'OPEN') {
      return { success: false, error: `Tickets cannot be purchased in phase: ${this.currentRound.phase}` };
    }
    const price = toBigInt(ticketPrice);
    if (price !== this.currentRound.ticketPrice) {
      return {
        success: false,
        error: `Incorrect ticket price: expected ${this.currentRound.ticketPrice}, got ${price}`
      };
    }
    if (ticketCount <= 0) {
      return { success: false, error: 'Ticket count must be positive' };
    }

    const indices: number[] = [];
    const startIndex = this.currentRound.tickets.length;
    for (let i = 0; i < ticketCount; i++) {
      const idx = startIndex + i;
      this.currentRound.tickets.push({
        ticketIndex: idx,
        buyer,
        txId
      });
      indices.push(idx);
    }

    this.currentRound.jackpot += BigInt(ticketCount) * price;
    return { success: true, ticketIndices: indices };
  }

  recordCommitment(
    commitment: EntropyCommitment,
    validatorManager: ValidatorManager
  ): { success: boolean; error?: string } {
    if (this.currentRound.phase !== 'COMMIT') {
      return { success: false, error: `Commitments only accepted in COMMIT phase, current: ${this.currentRound.phase}` };
    }
    if (commitment.roundId !== this.currentRound.id) {
      return { success: false, error: `Round ID mismatch: commitment ${commitment.roundId}, current ${this.currentRound.id}` };
    }

    const verify = verifyEntropyCommitment(commitment);
    if (!verify.valid) {
      return { success: false, error: verify.error };
    }

    const val = validatorManager.getValidator(commitment.validator);
    if (!val || val.slashed) {
      return { success: false, error: 'Validator is not active or is slashed' };
    }

    // Dynamic Anti-Withholding check: locked stake must exceed jackpot
    const requiredStake = validatorManager.calculateRequiredStake(this.currentRound.jackpot);
    if (commitment.lockedStake < requiredStake) {
      return {
        success: false,
        error: `Insufficient locked stake: provided ${commitment.lockedStake}, required ${requiredStake}`
      };
    }

    const lockResult = validatorManager.lockStake(commitment.validator, commitment.lockedStake);
    if (!lockResult.success) {
      return { success: false, error: lockResult.error };
    }

    this.currentRound.commitments[commitment.validator] = commitment;
    return { success: true };
  }

  transitionToCommit(): { success: boolean; error?: string } {
    if (this.currentRound.phase !== 'OPEN') {
      return { success: false, error: `Cannot transition to COMMIT from phase: ${this.currentRound.phase}` };
    }
    this.currentRound.phase = 'COMMIT';
    return { success: true };
  }

  transitionToReveal(): { success: boolean; error?: string } {
    if (this.currentRound.phase !== 'COMMIT') {
      return { success: false, error: `Cannot transition to REVEAL from phase: ${this.currentRound.phase}` };
    }
    this.currentRound.phase = 'REVEAL';
    return { success: true };
  }

  recordReveal(
    reveal: EntropyReveal,
    validatorManager: ValidatorManager
  ): { success: boolean; error?: string } {
    if (this.currentRound.phase !== 'REVEAL') {
      return { success: false, error: `Reveals only accepted in REVEAL phase, current: ${this.currentRound.phase}` };
    }
    if (reveal.roundId !== this.currentRound.id) {
      return { success: false, error: `Round ID mismatch: reveal ${reveal.roundId}, current ${this.currentRound.id}` };
    }

    const commitment = this.currentRound.commitments[reveal.validator];
    if (!commitment) {
      return { success: false, error: `No commitment found for validator ${reveal.validator} in round ${this.currentRound.id}` };
    }

    const verify = verifyEntropyReveal(reveal, commitment);
    if (!verify.valid) {
      return { success: false, error: verify.error };
    }

    this.currentRound.reveals[reveal.validator] = reveal;
    return { success: true };
  }

  executeDrawAndPayout(
    currentBlock: number,
    validatorManager: ValidatorManager,
    accounts: Map<string, AccountState>
  ): RoundOutcome {
    this.currentRound.phase = 'DRAW';

    const committedAddresses = Object.keys(this.currentRound.commitments);
    const honestRevealers = Object.keys(this.currentRound.reveals);
    const withholdingValidators = committedAddresses.filter((addr) => !this.currentRound.reveals[addr]);

    // Slashing withheld validators
    let slashedStakePerValidator = 0n;
    if (withholdingValidators.length > 0) {
      const firstCommit = this.currentRound.commitments[withholdingValidators[0]];
      slashedStakePerValidator = firstCommit ? firstCommit.lockedStake : 0n;
    }

    const slashResult = validatorManager.slashWithholdingValidators(
      withholdingValidators,
      slashedStakePerValidator,
      honestRevealers
    );
    this.totalBurned += slashResult.totalBurned;

    // Unlock stake for honest revealers
    for (const honest of honestRevealers) {
      const c = this.currentRound.commitments[honest];
      if (c) {
        validatorManager.unlockStake(honest, c.lockedStake);
      }
    }

    // Compute aggregated entropy seed
    const activeReveals = Object.values(this.currentRound.reveals);
    const { seedHex } = aggregateEntropy(activeReveals);

    const totalTickets = this.currentRound.tickets.length;
    let winningIndex = 0;
    let winnerAddress = '0x0';
    const totalJackpot = this.currentRound.jackpot;

    let payoutAmount = 0n;
    let validatorFeePool = 0n;
    let rolloverAmount = 0n;

    if (totalTickets > 0) {
      winningIndex = calculateWinningTicketIndex(seedHex, totalTickets);
      const winningTicket = this.currentRound.tickets[winningIndex];
      winnerAddress = winningTicket.buyer;

      // Economics: 90% winner, 5% validator fee, 5% reserve rollover
      payoutAmount = (totalJackpot * 90n) / 100n;
      validatorFeePool = (totalJackpot * 5n) / 100n;
      rolloverAmount = totalJackpot - payoutAmount - validatorFeePool;

      // Credit winner account
      let winnerAcc = accounts.get(winnerAddress);
      if (!winnerAcc) {
        winnerAcc = { address: winnerAddress, balance: 0n, nonce: 0 };
        accounts.set(winnerAddress, winnerAcc);
      }
      winnerAcc.balance += payoutAmount;

      // Distribute 5% validator fee to honest revealers
      validatorManager.distributeValidatorFees(honestRevealers, validatorFeePool);
    } else {
      // No tickets bought, roll over 100% of jackpot
      rolloverAmount = totalJackpot;
    }

    const outcome: RoundOutcome = {
      roundId: this.currentRound.id,
      winningTicketIndex: winningIndex,
      winnerAddress,
      jackpot: totalJackpot,
      payoutAmount,
      validatorFeePool,
      rolloverAmount,
      revealedValidators: honestRevealers,
      slashedValidators: slashResult.records,
      aggregatedSeedHex: seedHex,
      drawnAt: Date.now()
    };

    this.currentRound.outcome = outcome;
    this.currentRound.phase = 'COMPLETED';

    // Store completed round
    this.pastRounds.set(this.currentRound.id, { ...this.currentRound });

    // Advance to next round
    const nextRoundId = this.currentRound.id + 1;
    this.currentRound = this.createNewRound(nextRoundId, rolloverAmount, currentBlock);

    return outcome;
  }

  toJSON(): {
    currentRound: LotteryRound;
    pastRounds: Record<number, LotteryRound>;
    totalBurned: bigint;
  } {
    const pastObj: Record<number, LotteryRound> = {};
    for (const [k, v] of this.pastRounds.entries()) {
      pastObj[k] = { ...v };
    }
    return {
      currentRound: JSON.parse(JSON.stringify(this.currentRound)),
      pastRounds: pastObj,
      totalBurned: this.totalBurned
    };
  }
}
