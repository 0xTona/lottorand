import { EventEmitter } from 'events';
import {
  Block,
  BlockHeader,
  Transaction,
  EntropyCommitment,
  EntropyReveal,
  AccountState,
  ChainState,
  LotteryRound,
  RoundOutcome,
  Validator,
  toBigInt,
  ONE_ETHER
} from '../types/index.js';
import { KeyPair, keccak256Hex, signMessage, verifySignature, deriveAddress } from '../crypto/keys.js';
import { Mempool, verifyTransaction } from '../mempool/mempool.js';
import { ValidatorManager, MIN_VALIDATOR_STAKE } from '../consensus/validator.js';
import { LotteryStateMachine } from '../consensus/lottery.js';
import { LedgerStorage } from '../storage/ledger.js';
import { P2PNetworkNode } from '../p2p/node.js';

export interface ChainConfig {
  dbPath?: string;
  enableP2P?: boolean;
  p2pPort?: number;
  p2pHost?: string;
  bootstrapAddrs?: string[];
  initialAccounts?: Record<string, bigint | number | string>;
  initialValidators?: { address: string; publicKey: string; stake: bigint | number | string }[];
  slotTimeMs?: number; // Slot duration timer in milliseconds (default: 0)
}

export class LotteryChain extends EventEmitter {
  private mempool: Mempool = new Mempool();
  private validatorManager: ValidatorManager;
  private lottery: LotteryStateMachine;
  private storage: LedgerStorage;
  private p2p?: P2PNetworkNode;
  private accounts: Map<string, AccountState> = new Map();
  private headBlock: Block | null = null;
  private isInitialized = false;
  private seenBlocksByHeight: Map<number, Block> = new Map();
  private blockProductionTimer?: NodeJS.Timeout;

  constructor(private config: ChainConfig = {}) {
    super();
    this.storage = new LedgerStorage(config.dbPath);
    this.validatorManager = new ValidatorManager();
    this.lottery = new LotteryStateMachine();

    if (config.enableP2P) {
      this.p2p = new P2PNetworkNode({
        listenPort: config.p2pPort,
        listenHost: config.p2pHost,
        bootstrapAddrs: config.bootstrapAddrs,
        enableMdns: true
      });
      this.setupP2PListeners();
    }
  }

  async init(): Promise<void> {
    if (this.isInitialized) return;

    await this.storage.init();
    const storedState = await this.storage.getState();
    const latestBlock = await this.storage.getLatestBlock();

    if (storedState && latestBlock) {
      // Restore from persistent storage
      for (const [addr, acc] of Object.entries(storedState.accounts)) {
        this.accounts.set(addr, { ...acc, balance: toBigInt(acc.balance) });
      }
      this.validatorManager = new ValidatorManager(
        Object.values(storedState.validators).map((v) => ({
          ...v,
          stake: toBigInt(v.stake),
          lockedStake: toBigInt(v.lockedStake),
          totalRewardsEarned: toBigInt(v.totalRewardsEarned)
        }))
      );
      this.lottery = new LotteryStateMachine(
        {
          ...storedState.currentRound,
          ticketPrice: toBigInt(storedState.currentRound.ticketPrice),
          jackpot: toBigInt(storedState.currentRound.jackpot),
          rolloverFromPrev: toBigInt(storedState.currentRound.rolloverFromPrev)
        },
        storedState.pastRounds,
        toBigInt(storedState.totalBurned)
      );
      this.headBlock = latestBlock;
    } else {
      // Setup Genesis State
      if (this.config.initialAccounts) {
        for (const [addr, bal] of Object.entries(this.config.initialAccounts)) {
          this.accounts.set(addr, { address: addr, balance: toBigInt(bal), nonce: 0 });
        }
      }

      if (this.config.initialValidators) {
        for (const v of this.config.initialValidators) {
          const stake = toBigInt(v.stake);
          this.validatorManager.registerOrStake(v.address, v.publicKey, stake);
          // Also give account balance if not exists
          if (!this.accounts.has(v.address)) {
            this.accounts.set(v.address, { address: v.address, balance: 1000n * ONE_ETHER, nonce: 0 });
          }
        }
      }

      // Create Genesis Block
      const genesisBlock = this.createGenesisBlock();
      await this.storage.saveBlock(genesisBlock);
      this.headBlock = genesisBlock;
      await this.saveCurrentState();
    }

    if (this.headBlock) {
      this.seenBlocksByHeight.set(this.headBlock.header.index, this.headBlock);
    }

    if (this.p2p) {
      await this.p2p.start();
    }

    this.isInitialized = true;
  }

  async stop(): Promise<void> {
    this.stopBlockProduction();
    if (this.p2p) {
      await this.p2p.stop();
    }
    await this.storage.close();
  }

  getP2PNode(): P2PNetworkNode | undefined {
    return this.p2p;
  }

  getHeadBlock(): Block | null {
    return this.headBlock;
  }

  getAccount(address: string): AccountState {
    const acc = this.accounts.get(address);
    if (!acc) {
      return { address, balance: 0n, nonce: 0 };
    }
    return { ...acc };
  }

  setAccountBalance(address: string, balance: bigint | number | string): void {
    const acc = this.getAccount(address);
    acc.balance = toBigInt(balance);
    this.accounts.set(address, acc);
  }

  getValidators(): Validator[] {
    return this.validatorManager.getAllValidators();
  }

  getActiveValidators(): Validator[] {
    return this.validatorManager.getActiveValidators();
  }

  getProposerForHeight(blockIndex: number): Validator | null {
    return this.validatorManager.getProposerForHeight(blockIndex);
  }

  startBlockProduction(validatorKeypair: KeyPair, intervalMs?: number): void {
    if (this.blockProductionTimer) return;
    const interval =
      intervalMs ??
      (this.config.slotTimeMs && this.config.slotTimeMs > 0 ? this.config.slotTimeMs : 3000);

    this.blockProductionTimer = setInterval(async () => {
      try {
        if (!this.headBlock) return;
        const nextIndex = this.headBlock.header.index + 1;
        const expectedProposer = this.getProposerForHeight(nextIndex);
        if (
          expectedProposer &&
          expectedProposer.address.toLowerCase() === validatorKeypair.address.toLowerCase()
        ) {
          const slotTime = this.config.slotTimeMs ?? 0;
          const elapsed = Date.now() - this.headBlock.header.timestamp;
          if (slotTime === 0 || elapsed >= slotTime) {
            await this.proposeBlock(validatorKeypair);
          }
        }
      } catch (err) {
        this.emit('error', err);
      }
    }, interval);
  }

  stopBlockProduction(): void {
    if (this.blockProductionTimer) {
      clearInterval(this.blockProductionTimer);
      this.blockProductionTimer = undefined;
    }
  }

  getCurrentRound(): LotteryRound {
    return this.lottery.getCurrentRound();
  }

  getLotteryStateMachine(): LotteryStateMachine {
    return this.lottery;
  }

  getValidatorManager(): ValidatorManager {
    return this.validatorManager;
  }

  getMempool(): Mempool {
    return this.mempool;
  }

  async submitTransaction(tx: Transaction, broadcast = true): Promise<{ success: boolean; error?: string }> {
    const acc = this.getAccount(tx.sender);
    const added = this.mempool.addTransaction(tx, acc);
    if (!added.accepted) {
      return { success: false, error: added.error };
    }

    if (broadcast && this.p2p) {
      await this.p2p.broadcastTx(tx);
    }

    this.emit('txAdded', tx);
    return { success: true };
  }

  async submitCommitment(
    commitment: EntropyCommitment,
    broadcast = true
  ): Promise<{ success: boolean; error?: string }> {
    const res = this.lottery.recordCommitment(commitment, this.validatorManager);
    if (!res.success) {
      return res;
    }

    if (broadcast && this.p2p) {
      await this.p2p.broadcastCommitment(commitment);
    }

    this.emit('commitmentRecorded', commitment);
    return { success: true };
  }

  async submitReveal(
    reveal: EntropyReveal,
    broadcast = true
  ): Promise<{ success: boolean; error?: string }> {
    const res = this.lottery.recordReveal(reveal, this.validatorManager);
    if (!res.success) {
      return res;
    }

    if (broadcast && this.p2p) {
      await this.p2p.broadcastReveal(reveal);
    }

    this.emit('revealRecorded', reveal);
    return { success: true };
  }

  computeStateRoot(): string {
    const accountsObj: Record<string, AccountState> = {};
    for (const [k, v] of this.accounts.entries()) {
      accountsObj[k] = v;
    }
    const valObj = this.validatorManager.toJSON();
    const roundObj = this.lottery.getCurrentRound();
    return keccak256Hex(JSON.stringify({ accounts: accountsObj, validators: valObj, round: roundObj }));
  }

  async proposeBlock(proposerKeypair: KeyPair, broadcast = true): Promise<Block> {
    if (!this.headBlock) {
      throw new Error('Chain head not initialized');
    }

    const nextIndex = this.headBlock.header.index + 1;

    // 1. Slot duration check
    const slotTime = this.config.slotTimeMs ?? 0;
    if (slotTime > 0) {
      const elapsed = Date.now() - this.headBlock.header.timestamp;
      if (elapsed < slotTime) {
        throw new Error(
          `Cannot propose block: slot duration of ${slotTime}ms not met (elapsed: ${elapsed}ms)`
        );
      }
    }

    // 2. Deterministic Round-Robin Leader Election
    const expectedProposer = this.validatorManager.getProposerForHeight(nextIndex);
    if (
      expectedProposer &&
      proposerKeypair.address.toLowerCase() !== expectedProposer.address.toLowerCase()
    ) {
      throw new Error(
        `Invalid proposer for block #${nextIndex}: expected ${expectedProposer.address}, got ${proposerKeypair.address}`
      );
    }

    const currentRound = this.lottery.getCurrentRound();

    // Check round lifecycle transitions based on block index
    let roundOutcome: RoundOutcome | undefined;

    while (true) {
      const round = this.lottery.getCurrentRound();
      if (round.phase === 'OPEN' && nextIndex >= round.commitStartBlock) {
        this.lottery.transitionToCommit();
      } else if (round.phase === 'COMMIT' && nextIndex >= round.revealStartBlock) {
        this.lottery.transitionToReveal();
      } else if (round.phase === 'REVEAL' && nextIndex >= round.drawBlock) {
        roundOutcome = this.lottery.executeDrawAndPayout(nextIndex, this.validatorManager, this.accounts);
        break;
      } else {
        break;
      }
    }

    // Pull transactions from mempool
    const pendingTxs = this.mempool.getPending(50);
    const validTxs: Transaction[] = [];

    // Execute valid transactions
    for (const tx of pendingTxs) {
      const senderAcc = this.getAccount(tx.sender);
      const verify = verifyTransaction(tx, senderAcc);
      if (!verify.valid) {
        continue;
      }

      // Deduct balance and increment nonce
      senderAcc.balance -= tx.amount + tx.fee;
      senderAcc.nonce += 1;
      this.accounts.set(tx.sender, senderAcc);

      // Reward block proposer with tx fee
      let proposerAcc = this.getAccount(proposerKeypair.address);
      proposerAcc.balance += tx.fee;
      this.accounts.set(proposerKeypair.address, proposerAcc);

      // Process transaction effects
      if (tx.type === 'TRANSFER' && tx.recipient) {
        const recipAcc = this.getAccount(tx.recipient);
        recipAcc.balance += tx.amount;
        this.accounts.set(tx.recipient, recipAcc);
      } else if (tx.type === 'STAKE') {
        this.validatorManager.registerOrStake(tx.sender, tx.publicKey, tx.amount);
      } else if (tx.type === 'UNSTAKE') {
        this.validatorManager.unstake(tx.sender, tx.amount);
        senderAcc.balance += tx.amount;
        this.accounts.set(tx.sender, senderAcc);
      } else if (tx.type === 'BUY_TICKET' && tx.ticketCount && tx.ticketPrice) {
        this.lottery.buyTickets(tx.sender, tx.ticketCount, tx.ticketPrice, tx.id);
      }

      validTxs.push(tx);
    }

    // Remove processed transactions from mempool
    this.mempool.removeTransactions(validTxs.map((t) => t.id));

    // Gather commitments & reveals associated with this block
    const commitments = Object.values(currentRound.commitments);
    const reveals = Object.values(currentRound.reveals);

    const txRoot = keccak256Hex(validTxs.map((t) => t.id).join(';') || 'empty-tx');
    const entropyRoot = keccak256Hex(
      commitments.map((c) => c.commitment).join(';') + '|' + reveals.map((r) => r.secret).join(';')
    );
    const stateRoot = this.computeStateRoot();

    const header: BlockHeader = {
      index: nextIndex,
      previousHash: this.headBlock.hash,
      timestamp: Date.now(),
      stateRoot,
      txRoot,
      proposer: proposerKeypair.address,
      roundId: currentRound.id,
      entropyRoot
    };

    const headerHash = keccak256Hex(JSON.stringify(header));
    const signature = signMessage(headerHash, proposerKeypair.privateKey);

    const block: Block = {
      header,
      hash: headerHash,
      signature,
      transactions: validTxs,
      commitments,
      reveals,
      roundOutcome
    };

    // Save block and update state
    await this.storage.saveBlock(block);
    this.headBlock = block;
    this.seenBlocksByHeight.set(block.header.index, block);
    await this.saveCurrentState();

    if (broadcast && this.p2p) {
      await this.p2p.broadcastBlock(block);
    }

    this.emit('blockAppended', block);
    return block;
  }

  async applyIncomingBlock(block: Block): Promise<{ success: boolean; error?: string }> {
    if (!this.headBlock) {
      return { success: false, error: 'Head block not initialized' };
    }

    // 1. Anti-Equivocation: check if conflicting block at this height was already seen
    const existingBlock =
      this.seenBlocksByHeight.get(block.header.index) ??
      (this.headBlock && this.headBlock.header.index === block.header.index ? this.headBlock : null);

    if (existingBlock && existingBlock.hash !== block.hash) {
      if (existingBlock.header.proposer.toLowerCase() === block.header.proposer.toLowerCase()) {
        const proposerVal = this.validatorManager.getValidator(block.header.proposer);
        if (proposerVal) {
          const isValidSig = verifySignature(block.signature, block.hash, proposerVal.publicKey);
          if (isValidSig) {
            const honest = this.validatorManager.getActiveValidators().map((v) => v.address);
            const slashRecord = this.validatorManager.slashEquivocatingProposer(
              block.header.proposer,
              MIN_VALIDATOR_STAKE,
              honest
            );
            if (slashRecord) {
              await this.saveCurrentState();
              this.emit('equivocationDetected', {
                proposer: block.header.proposer,
                height: block.header.index,
                existingHash: existingBlock.hash,
                conflictingHash: block.hash,
                slashRecord
              });
            }
            return {
              success: false,
              error: `Equivocation detected: Proposer ${block.header.proposer} slashed for double-proposing at height ${block.header.index}`
            };
          }
        }
      }
    }

    // 2. Strict sequential height enforcement
    if (block.header.index !== this.headBlock.header.index + 1) {
      return {
        success: false,
        error: `Invalid block index: expected ${this.headBlock.header.index + 1}, got ${block.header.index}`
      };
    }

    // 3. Parent hash link verification
    if (block.header.previousHash !== this.headBlock.hash) {
      return {
        success: false,
        error: `Previous hash mismatch: expected ${this.headBlock.hash}, got ${block.header.previousHash}`
      };
    }

    // 4. Header hash integrity
    const computedHash = keccak256Hex(JSON.stringify(block.header));
    if (computedHash !== block.hash) {
      return { success: false, error: 'Block hash does not match computed header hash' };
    }

    // 5. Slot duration timer check
    const slotTime = this.config.slotTimeMs ?? 0;
    if (slotTime > 0 && block.header.timestamp < this.headBlock.header.timestamp + slotTime) {
      return {
        success: false,
        error: `Block timestamp ${block.header.timestamp} is too early (slot duration: ${slotTime}ms)`
      };
    }

    // 6. Deterministic Round-Robin Leader Election
    const expectedProposer = this.validatorManager.getProposerForHeight(block.header.index);
    if (!expectedProposer || block.header.proposer.toLowerCase() !== expectedProposer.address.toLowerCase()) {
      return {
        success: false,
        error: `Invalid proposer for block #${block.header.index}: expected ${expectedProposer?.address}, got ${block.header.proposer}`
      };
    }

    // 7. Verify Proposer Active & Block Signature
    const proposerVal = this.validatorManager.getValidator(block.header.proposer);
    if (!proposerVal || proposerVal.slashed) {
      return {
        success: false,
        error: `Proposer ${block.header.proposer} is not an active validator`
      };
    }

    const isValidSignature = verifySignature(block.signature, block.hash, proposerVal.publicKey);
    if (!isValidSignature) {
      return {
        success: false,
        error: `Invalid block signature from proposer ${block.header.proposer}`
      };
    }

    // Apply transactions
    for (const tx of block.transactions) {
      const senderAcc = this.getAccount(tx.sender);
      senderAcc.balance -= tx.amount + tx.fee;
      senderAcc.nonce += 1;
      this.accounts.set(tx.sender, senderAcc);

      // Fee to proposer
      const proposerAcc = this.getAccount(block.header.proposer);
      proposerAcc.balance += tx.fee;
      this.accounts.set(block.header.proposer, proposerAcc);

      if (tx.type === 'TRANSFER' && tx.recipient) {
        const recipAcc = this.getAccount(tx.recipient);
        recipAcc.balance += tx.amount;
        this.accounts.set(tx.recipient, recipAcc);
      } else if (tx.type === 'STAKE') {
        this.validatorManager.registerOrStake(tx.sender, tx.publicKey, tx.amount);
      } else if (tx.type === 'UNSTAKE') {
        this.validatorManager.unstake(tx.sender, tx.amount);
        senderAcc.balance += tx.amount;
        this.accounts.set(tx.sender, senderAcc);
      } else if (tx.type === 'BUY_TICKET' && tx.ticketCount && tx.ticketPrice) {
        this.lottery.buyTickets(tx.sender, tx.ticketCount, tx.ticketPrice, tx.id);
      }
    }

    // Synchronize round phase before applying commitments & reveals
    while (true) {
      const round = this.lottery.getCurrentRound();
      if (round.phase === 'OPEN' && block.header.index >= round.commitStartBlock) {
        this.lottery.transitionToCommit();
      } else if (round.phase === 'COMMIT' && block.header.index >= round.revealStartBlock) {
        this.lottery.transitionToReveal();
      } else {
        break;
      }
    }

    // Apply commitments & reveals
    for (const c of block.commitments) {
      if (!this.lottery.getCurrentRound().commitments[c.validator]) {
        this.lottery.recordCommitment(c, this.validatorManager);
      }
    }

    for (const r of block.reveals) {
      if (!this.lottery.getCurrentRound().reveals[r.validator]) {
        this.lottery.recordReveal(r, this.validatorManager);
      }
    }

    // If block triggered draw
    if (block.roundOutcome) {
      this.lottery.executeDrawAndPayout(block.header.index, this.validatorManager, this.accounts);
    }

    this.mempool.removeTransactions(block.transactions.map((t) => t.id));
    await this.storage.saveBlock(block);
    this.headBlock = block;
    this.seenBlocksByHeight.set(block.header.index, block);
    await this.saveCurrentState();

    this.emit('blockApplied', block);
    return { success: true };
  }

  private async saveCurrentState(): Promise<void> {
    const accountsObj: Record<string, AccountState> = {};
    for (const [k, v] of this.accounts.entries()) {
      accountsObj[k] = { ...v };
    }
    const state: ChainState = {
      accounts: accountsObj,
      validators: this.validatorManager.toJSON(),
      currentRound: this.lottery.getCurrentRound(),
      pastRounds: this.lottery.toJSON().pastRounds,
      totalBurned: this.lottery.getTotalBurned()
    };
    await this.storage.saveState(state);
  }

  private createGenesisBlock(): Block {
    const header: BlockHeader = {
      index: 0,
      previousHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      timestamp: 1700000000000,
      stateRoot: this.computeStateRoot(),
      txRoot: keccak256Hex('genesis-tx'),
      proposer: 'genesis-authority',
      roundId: 1,
      entropyRoot: keccak256Hex('genesis-entropy')
    };

    const hash = keccak256Hex(JSON.stringify(header));
    return {
      header,
      hash,
      signature: '0x00genesis',
      transactions: [],
      commitments: [],
      reveals: []
    };
  }

  private setupP2PListeners(): void {
    if (!this.p2p) return;

    this.p2p.on('tx', (tx: Transaction) => {
      this.submitTransaction(tx, false).catch((err) => {
        this.emit('error', err);
      });
    });

    this.p2p.on('commit', (commitment: EntropyCommitment) => {
      this.submitCommitment(commitment, false).catch((err) => {
        this.emit('error', err);
      });
    });

    this.p2p.on('reveal', (reveal: EntropyReveal) => {
      this.submitReveal(reveal, false).catch((err) => {
        this.emit('error', err);
      });
    });

    this.p2p.on('block', (block: Block) => {
      this.applyIncomingBlock(block).catch((err) => {
        this.emit('error', err);
      });
    });
  }
}
