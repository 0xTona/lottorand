import { Validator, SlashedValidatorRecord, MIN_VALIDATOR_STAKE, ONE_ETHER, toBigInt } from '../types/index.js';

export { MIN_VALIDATOR_STAKE };

export class ValidatorManager {
  private validators: Map<string, Validator> = new Map();

  constructor(initialValidators?: Validator[]) {
    if (initialValidators) {
      for (const v of initialValidators) {
        this.validators.set(v.address, {
          ...v,
          stake: toBigInt(v.stake),
          lockedStake: toBigInt(v.lockedStake),
          totalRewardsEarned: toBigInt(v.totalRewardsEarned)
        });
      }
    }
  }

  getValidator(address: string): Validator | undefined {
    return this.validators.get(address);
  }

  getAllValidators(): Validator[] {
    return Array.from(this.validators.values());
  }

  getActiveValidators(): Validator[] {
    return Array.from(this.validators.values()).filter(
      (v) => !v.slashed && v.stake >= MIN_VALIDATOR_STAKE
    );
  }

  /**
   * Deterministic round-robin leader election based on block height
   */
  getProposerForHeight(blockIndex: number): Validator | null {
    const active = this.getActiveValidators().sort((a, b) =>
      a.address.toLowerCase().localeCompare(b.address.toLowerCase())
    );
    if (active.length === 0) return null;
    const index = Math.abs((blockIndex - 1) % active.length);
    return active[index];
  }

  registerOrStake(address: string, publicKey: string, amount: bigint | number | string): Validator {
    const bigAmount = toBigInt(amount);
    let validator = this.validators.get(address);
    if (!validator) {
      validator = {
        address,
        publicKey,
        stake: bigAmount,
        lockedStake: 0n,
        slashed: false,
        slashCount: 0,
        totalRewardsEarned: 0n
      };
      this.validators.set(address, validator);
    } else {
      validator.stake += bigAmount;
      if (validator.slashed && validator.stake >= MIN_VALIDATOR_STAKE) {
        // Can rehabilitate if new stake deposited exceeds minimum
        validator.slashed = false;
      }
    }
    return validator;
  }

  unstake(address: string, amount: bigint | number | string): { success: boolean; error?: string } {
    const bigAmount = toBigInt(amount);
    const v = this.validators.get(address);
    if (!v) return { success: false, error: 'Validator not found' };
    const available = v.stake - v.lockedStake;
    if (available < bigAmount) {
      return { success: false, error: `Insufficient un-locked stake: available ${available}, requested ${bigAmount}` };
    }
    v.stake -= bigAmount;
    return { success: true };
  }

  /**
   * Anti-Withholding Rule:
   * Locked stake requirement D dynamically enforced:
   * Required Stake (D) > Current Round Jackpot
   */
  calculateRequiredStake(currentJackpot: bigint): bigint {
    const delta = 10n * ONE_ETHER;
    const target = currentJackpot + delta;
    return target > MIN_VALIDATOR_STAKE ? target : MIN_VALIDATOR_STAKE;
  }

  lockStake(address: string, requiredStake: bigint): { success: boolean; error?: string } {
    const v = this.validators.get(address);
    if (!v) return { success: false, error: 'Validator not found' };
    if (v.slashed) return { success: false, error: 'Validator is currently slashed' };

    const available = v.stake - v.lockedStake;
    if (available < requiredStake) {
      return {
        success: false,
        error: `Insufficient available stake to lock: has ${available}, required ${requiredStake}`
      };
    }
    v.lockedStake += requiredStake;
    return { success: true };
  }

  unlockStake(address: string, amount: bigint): void {
    const v = this.validators.get(address);
    if (v) {
      v.lockedStake = v.lockedStake > amount ? v.lockedStake - amount : 0n;
    }
  }

  /**
   * Execute slashing on withholding validators.
   * Slashing Distribution:
   * - 50% of slashed stake is burned.
   * - 50% is distributed to honest validators as a slashing bounty.
   */
  slashWithholdingValidators(
    withholdingAddresses: string[],
    lockedStakePerValidator: bigint,
    honestRevealers: string[]
  ): { records: SlashedValidatorRecord[]; totalBurned: bigint; bountyPerRevealer: bigint } {
    const records: SlashedValidatorRecord[] = [];
    let totalBurned = 0n;
    let totalBounty = 0n;

    for (const addr of withholdingAddresses) {
      const v = this.validators.get(addr);
      const slashAmount = lockedStakePerValidator;

      if (v) {
        v.stake = v.stake > slashAmount ? v.stake - slashAmount : 0n;
        v.lockedStake = v.lockedStake > slashAmount ? v.lockedStake - slashAmount : 0n;
        v.slashed = true;
        v.slashCount += 1;
      }

      const burnedAmount = (slashAmount * 50n) / 100n;
      const bountyAmount = slashAmount - burnedAmount;

      totalBurned += burnedAmount;
      totalBounty += bountyAmount;

      records.push({
        validator: addr,
        slashedStake: slashAmount,
        burnedAmount,
        bountyAmount
      });
    }

    const bountyPerRevealer = honestRevealers.length > 0 ? totalBounty / BigInt(honestRevealers.length) : 0n;

    // Distribute bounty to honest revealers
    if (bountyPerRevealer > 0n) {
      for (const honest of honestRevealers) {
        const v = this.validators.get(honest);
        if (v) {
          v.stake += bountyPerRevealer;
          v.totalRewardsEarned += bountyPerRevealer;
        }
      }
    }

    return { records, totalBurned, bountyPerRevealer };
  }

  distributeValidatorFees(honestRevealers: string[], totalFeePool: bigint): bigint {
    if (honestRevealers.length === 0 || totalFeePool <= 0n) return 0n;
    const feePerRevealer = totalFeePool / BigInt(honestRevealers.length);
    for (const honest of honestRevealers) {
      const v = this.validators.get(honest);
      if (v) {
        v.stake += feePerRevealer;
        v.totalRewardsEarned += feePerRevealer;
      }
    }
    return feePerRevealer;
  }

  /**
   * Anti-Equivocation Rule:
   * Slashes a proposer for signing conflicting blocks at the same height.
   * - Slashes MIN_VALIDATOR_STAKE (or their available stake).
   * - 50% burned, 50% distributed to honest active validators as bounty.
   * - Sets validator.slashed = true.
   */
  slashEquivocatingProposer(
    proposerAddress: string,
    slashAmount: bigint = MIN_VALIDATOR_STAKE,
    honestValidators: string[] = []
  ): SlashedValidatorRecord | null {
    const v = this.validators.get(proposerAddress);
    if (!v) return null;

    const actualSlash = v.stake < slashAmount ? v.stake : slashAmount;
    v.stake = v.stake > actualSlash ? v.stake - actualSlash : 0n;
    v.lockedStake = v.lockedStake > actualSlash ? v.lockedStake - actualSlash : 0n;
    v.slashed = true;
    v.slashCount += 1;

    const burnedAmount = (actualSlash * 50n) / 100n;
    const bountyAmount = actualSlash - burnedAmount;

    // Distribute bounty among honest active validators
    const recipients = honestValidators.filter(
      (addr) => addr.toLowerCase() !== proposerAddress.toLowerCase()
    );
    if (recipients.length > 0 && bountyAmount > 0n) {
      const share = bountyAmount / BigInt(recipients.length);
      for (const r of recipients) {
        const val = this.validators.get(r);
        if (val) {
          val.stake += share;
          val.totalRewardsEarned += share;
        }
      }
    }

    return {
      validator: proposerAddress,
      slashedStake: actualSlash,
      burnedAmount,
      bountyAmount
    };
  }

  toJSON(): Record<string, Validator> {
    const obj: Record<string, Validator> = {};
    for (const [k, v] of this.validators.entries()) {
      obj[k] = { ...v };
    }
    return obj;
  }
}
