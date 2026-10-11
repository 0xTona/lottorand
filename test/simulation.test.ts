import assert from 'assert';
import {
  generateKeypair,
  sha256Hex,
  toHex,
  fromHex,
  keccak256Hex,
  signMessage
} from '../src/crypto/keys.js';
import {
  createEntropyCommitment,
  createEntropyReveal,
  aggregateEntropy,
  calculateWinningTicketIndex
} from '../src/consensus/randao.js';
import { createTransaction } from '../src/mempool/mempool.js';
import { LotteryChain } from '../src/chain/chain.js';
import { ONE_ETHER, DEFAULT_TICKET_PRICE, formatEther, toBigInt } from '../src/types/index.js';

async function runSimulation() {
  console.log('====================================================');
  console.log('  LOTTERY BLOCKCHAIN 3-VALIDATOR SIMULATION TEST   ');
  console.log('====================================================\n');

  // 1. Setup Identities
  console.log('[Step 1] Initializing validator identities and buyer accounts...');
  const val1 = generateKeypair();
  const val2 = generateKeypair();
  const val3 = generateKeypair();

  const buyerA = generateKeypair();
  const buyerB = generateKeypair();

  console.log(`Validator 1: ${val1.address}`);
  console.log(`Validator 2: ${val2.address}`);
  console.log(`Validator 3: ${val3.address}`);
  console.log(`Buyer A:     ${buyerA.address}`);
  console.log(`Buyer B:     ${buyerB.address}\n`);

  // 2. Setup Chain with Initial Stakes & Balances
  const initialStake = 500n * ONE_ETHER;
  const chain = new LotteryChain({
    initialValidators: [
      { address: val1.address, publicKey: val1.publicKey, stake: initialStake },
      { address: val2.address, publicKey: val2.publicKey, stake: initialStake },
      { address: val3.address, publicKey: val3.publicKey, stake: initialStake }
    ],
    initialAccounts: {
      [val1.address]: 1000n * ONE_ETHER,
      [val2.address]: 1000n * ONE_ETHER,
      [val3.address]: 1000n * ONE_ETHER,
      [buyerA.address]: 500n * ONE_ETHER,
      [buyerB.address]: 500n * ONE_ETHER
    }
  });

  await chain.init();
  console.log('[Step 2] Chain genesis initialized successfully.');
  assert.strictEqual(chain.getValidators().length, 3, 'Should have 3 registered validators');
  assert.strictEqual(chain.getAccount(buyerA.address).balance, 500n * ONE_ETHER);

  const valMap = new Map<string, any>([
    [val1.address.toLowerCase(), val1],
    [val2.address.toLowerCase(), val2],
    [val3.address.toLowerCase(), val3]
  ]);

  function getElectedProposer(c: LotteryChain) {
    const nextIdx = (c.getHeadBlock()?.header.index ?? 0) + 1;
    const expected = c.getProposerForHeight(nextIdx);
    if (!expected) throw new Error(`No elected proposer for block #${nextIdx}`);
    const kp = valMap.get(expected.address.toLowerCase());
    if (!kp) throw new Error(`Keypair not found for elected proposer ${expected.address}`);
    return kp;
  }

  // =========================================================================
  // TEST ROUND 1: Normal Draw Lifecycle
  // =========================================================================
  console.log('\n----------------------------------------------------');
  console.log('  TEST 1: Round 1 Normal Draw Lifecycle');
  console.log('----------------------------------------------------');

  let round1 = chain.getCurrentRound();
  console.log(`Current Round ID: ${round1.id}, Phase: ${round1.phase}`);
  assert.strictEqual(round1.phase, 'OPEN');

  // Buyers purchase tickets (each ticket costs 0.01 Token = 1e16 wei)
  console.log('1.1 Buyers purchasing tickets...');
  const tx1 = createTransaction({
    type: 'BUY_TICKET',
    sender: buyerA.address,
    amount: 3n * DEFAULT_TICKET_PRICE, // 3 tickets * 0.01 Token
    ticketCount: 3,
    ticketPrice: DEFAULT_TICKET_PRICE,
    roundId: round1.id,
    nonce: 0,
    fee: 10n ** 15n,
    privateKey: buyerA.privateKey,
    publicKey: buyerA.publicKey
  });
  await chain.submitTransaction(tx1);

  const tx2 = createTransaction({
    type: 'BUY_TICKET',
    sender: buyerB.address,
    amount: 2n * DEFAULT_TICKET_PRICE, // 2 tickets * 0.01 Token
    ticketCount: 2,
    ticketPrice: DEFAULT_TICKET_PRICE,
    roundId: round1.id,
    nonce: 0,
    fee: 10n ** 15n,
    privateKey: buyerB.privateKey,
    publicKey: buyerB.publicKey
  });
  await chain.submitTransaction(tx2);

  // Mine Block 1 with ticket transactions
  const proposer1 = getElectedProposer(chain);
  const block1 = await chain.proposeBlock(proposer1);
  console.log(`Block #1 proposed by elected leader ${proposer1.address}, included ${block1.transactions.length} txs.`);

  round1 = chain.getCurrentRound();
  const expectedJackpot1 = 5n * DEFAULT_TICKET_PRICE;
  console.log(`Total tickets sold: ${round1.tickets.length}, Current Jackpot: ${formatEther(round1.jackpot)} Tokens`);
  assert.strictEqual(round1.tickets.length, 5);
  assert.strictEqual(round1.jackpot, expectedJackpot1);

  // Dynamic Anti-Withholding Stake Check
  const requiredStakeRound1 = chain.getValidatorManager().calculateRequiredStake(round1.jackpot);
  console.log(`1.2 Required stake for Anti-Withholding: ${formatEther(requiredStakeRound1)} Tokens (must exceed jackpot)`);
  assert(requiredStakeRound1 > round1.jackpot, 'Anti-withholding rule: stake requirement must exceed jackpot');

  // Verify commitments rejected while still in OPEN phase
  const secret1 = new Uint8Array(32).fill(11);
  const secret2 = new Uint8Array(32).fill(22);
  const secret3 = new Uint8Array(32).fill(33);

  const commit1 = createEntropyCommitment({
    roundId: round1.id,
    validator: val1.address,
    secret: secret1,
    lockedStake: requiredStakeRound1,
    privateKey: val1.privateKey,
    publicKey: val1.publicKey
  });
  const commit2 = createEntropyCommitment({
    roundId: round1.id,
    validator: val2.address,
    secret: secret2,
    lockedStake: requiredStakeRound1,
    privateKey: val2.privateKey,
    publicKey: val2.publicKey
  });
  const commit3 = createEntropyCommitment({
    roundId: round1.id,
    validator: val3.address,
    secret: secret3,
    lockedStake: requiredStakeRound1,
    privateKey: val3.privateKey,
    publicKey: val3.publicKey
  });

  const earlyCommitRes = await chain.submitCommitment(commit1);
  assert(!earlyCommitRes.success, 'Commitments must be rejected in OPEN phase');
  console.log(' -> Commitments correctly rejected during OPEN phase.');

  // Advance round to COMMIT phase (freezing ticket sales)
  console.log('1.3 Advancing round to COMMIT phase...');
  await chain.proposeBlock(getElectedProposer(chain)); // block 2
  await chain.proposeBlock(getElectedProposer(chain)); // block 3
  await chain.proposeBlock(getElectedProposer(chain)); // block 4
  await chain.proposeBlock(getElectedProposer(chain)); // block 5 (reaches commitStartBlock)

  round1 = chain.getCurrentRound();
  console.log(`Round phase is now: ${round1.phase}`);
  assert.strictEqual(round1.phase, 'COMMIT');

  // Verify tickets cannot be bought once in COMMIT phase
  const rejectedTicketBuy = chain.getLotteryStateMachine().buyTickets(buyerA.address, 1, DEFAULT_TICKET_PRICE, 'late-tx');
  assert(!rejectedTicketBuy.success, 'Ticket purchases must be rejected in COMMIT phase');
  console.log(' -> Ticket purchases correctly rejected during COMMIT phase (jackpot immutable).');

  // Validators generate secrets and broadcast commitments in COMMIT phase
  console.log('1.4 Validators broadcasting commitments in COMMIT phase...');
  const cRes1 = await chain.submitCommitment(commit1);
  const cRes2 = await chain.submitCommitment(commit2);
  const cRes3 = await chain.submitCommitment(commit3);
  assert(cRes1.success && cRes2.success && cRes3.success, 'All commitments should be accepted in COMMIT phase');

  // Mine blocks to advance to REVEAL phase
  console.log('1.5 Advancing round to REVEAL phase...');
  await chain.proposeBlock(getElectedProposer(chain)); // block 6
  await chain.proposeBlock(getElectedProposer(chain)); // block 7
  await chain.proposeBlock(getElectedProposer(chain)); // block 8 (reaches revealStartBlock)

  round1 = chain.getCurrentRound();
  console.log(`Round phase is now: ${round1.phase}`);
  assert.strictEqual(round1.phase, 'REVEAL');

  // Validators broadcast reveals
  console.log('1.6 Validators broadcasting reveals...');
  const reveal1 = createEntropyReveal({
    roundId: round1.id,
    validator: val1.address,
    secret: secret1,
    privateKey: val1.privateKey,
    publicKey: val1.publicKey
  });
  const reveal2 = createEntropyReveal({
    roundId: round1.id,
    validator: val2.address,
    secret: secret2,
    privateKey: val2.privateKey,
    publicKey: val2.publicKey
  });
  const reveal3 = createEntropyReveal({
    roundId: round1.id,
    validator: val3.address,
    secret: secret3,
    privateKey: val3.privateKey,
    publicKey: val3.publicKey
  });

  const rRes1 = await chain.submitReveal(reveal1);
  const rRes2 = await chain.submitReveal(reveal2);
  const rRes3 = await chain.submitReveal(reveal3);
  assert(rRes1.success && rRes2.success && rRes3.success, 'All reveals should be accepted');

  // Mine blocks to advance to DRAW phase
  console.log('1.7 Advancing blocks to trigger DRAW & PAYOUT...');
  await chain.proposeBlock(getElectedProposer(chain)); // block 9
  await chain.proposeBlock(getElectedProposer(chain)); // block 10
  const drawBlock = await chain.proposeBlock(getElectedProposer(chain)); // reaches drawBlock (block 11)

  assert(drawBlock.roundOutcome, 'Block should contain roundOutcome');
  const outcome1 = drawBlock.roundOutcome!;
  console.log('=== Round 1 Completed! ===');
  console.log(`Winner Address:        ${outcome1.winnerAddress}`);
  console.log(`Winning Ticket Index:  ${outcome1.winningTicketIndex}`);
  console.log(`Jackpot:               ${outcome1.jackpot}`);
  console.log(`Payout (90%):          ${outcome1.payoutAmount}`);
  console.log(`Validator Fee Pool(5%):${outcome1.validatorFeePool}`);
  console.log(`Rollover to Next (5%): ${outcome1.rolloverAmount}`);
  console.log(`Aggregated Seed:       ${outcome1.aggregatedSeedHex.slice(0, 16)}...`);

  assert.strictEqual(outcome1.jackpot, expectedJackpot1);
  const expectedPayout1 = (expectedJackpot1 * 90n) / 100n;
  const expectedFeePool1 = (expectedJackpot1 * 5n) / 100n;
  const expectedRollover1 = expectedJackpot1 - expectedPayout1 - expectedFeePool1;
  assert.strictEqual(outcome1.payoutAmount, expectedPayout1);
  assert.strictEqual(outcome1.validatorFeePool, expectedFeePool1);
  assert.strictEqual(outcome1.rolloverAmount, expectedRollover1);
  assert.strictEqual(outcome1.revealedValidators.length, 3);
  assert.strictEqual(outcome1.slashedValidators.length, 0);

  // Assert winner balance increased
  const winnerBal = chain.getAccount(outcome1.winnerAddress).balance;
  console.log(`Winner balance after payout: ${formatEther(winnerBal)} Tokens`);
  assert(winnerBal > 450n * ONE_ETHER, 'Winner should have received payout');

  // Assert new round initialized with rollover
  const round2 = chain.getCurrentRound();
  console.log(`New Round ID: ${round2.id}, Rollover from prev: ${formatEther(round2.rolloverFromPrev)} Tokens`);
  assert.strictEqual(round2.id, 2);
  assert.strictEqual(round2.rolloverFromPrev, expectedRollover1);
  assert.strictEqual(round2.jackpot, expectedRollover1);
  assert.strictEqual(round2.phase, 'OPEN');

  // =========================================================================
  // TEST ROUND 2: Malicious / Slashing Scenario (Anti-Withholding Rule)
  // =========================================================================
  console.log('\n----------------------------------------------------');
  console.log('  TEST 2: Round 2 Malicious Withholding & Slashing');
  console.log('----------------------------------------------------');

  // Buyer purchases more tickets in Round 2
  const txR2 = createTransaction({
    type: 'BUY_TICKET',
    sender: buyerA.address,
    amount: 5n * DEFAULT_TICKET_PRICE, // 5 tickets * 0.01 Token
    ticketCount: 5,
    ticketPrice: DEFAULT_TICKET_PRICE,
    roundId: round2.id,
    nonce: chain.getAccount(buyerA.address).nonce,
    fee: 10n ** 15n,
    privateKey: buyerA.privateKey,
    publicKey: buyerA.publicKey
  });
  await chain.submitTransaction(txR2);
  await chain.proposeBlock(getElectedProposer(chain));

  const currentR2 = chain.getCurrentRound();
  const expectedJackpot2 = expectedRollover1 + 5n * DEFAULT_TICKET_PRICE;
  console.log(`Round 2 Jackpot: ${formatEther(currentR2.jackpot)} Tokens (includes rollover + tickets)`);
  assert.strictEqual(currentR2.jackpot, expectedJackpot2);

  // Advance Round 2 from OPEN to COMMIT phase (freezing ticket sales)
  console.log('2.1 Advancing round to COMMIT phase...');
  await chain.proposeBlock(getElectedProposer(chain)); // block 13
  await chain.proposeBlock(getElectedProposer(chain)); // block 14
  await chain.proposeBlock(getElectedProposer(chain)); // block 15
  await chain.proposeBlock(getElectedProposer(chain)); // block 16 (reaches commitStartBlock)
  assert.strictEqual(chain.getCurrentRound().phase, 'COMMIT');

  const requiredStakeRound2 = chain.getValidatorManager().calculateRequiredStake(currentR2.jackpot);
  console.log(`Round 2 Required stake: ${formatEther(requiredStakeRound2)} Tokens`);

  // All 3 validators commit in COMMIT phase
  const r2Secret1 = new Uint8Array(32).fill(44);
  const r2Secret2 = new Uint8Array(32).fill(55);
  const r2Secret3_malicious = new Uint8Array(32).fill(99);

  const r2Commit1 = createEntropyCommitment({
    roundId: round2.id,
    validator: val1.address,
    secret: r2Secret1,
    lockedStake: requiredStakeRound2,
    privateKey: val1.privateKey,
    publicKey: val1.publicKey
  });
  const r2Commit2 = createEntropyCommitment({
    roundId: round2.id,
    validator: val2.address,
    secret: r2Secret2,
    lockedStake: requiredStakeRound2,
    privateKey: val2.privateKey,
    publicKey: val2.publicKey
  });
  const r2Commit3 = createEntropyCommitment({
    roundId: round2.id,
    validator: val3.address,
    secret: r2Secret3_malicious,
    lockedStake: requiredStakeRound2,
    privateKey: val3.privateKey,
    publicKey: val3.publicKey
  });

  await chain.submitCommitment(r2Commit1);
  await chain.submitCommitment(r2Commit2);
  await chain.submitCommitment(r2Commit3);
  console.log('2.2 All 3 validators committed stake in Round 2.');

  // Advance to REVEAL phase
  await chain.proposeBlock(getElectedProposer(chain)); // block 17
  await chain.proposeBlock(getElectedProposer(chain)); // block 18
  await chain.proposeBlock(getElectedProposer(chain)); // block 19 (reaches revealStartBlock)
  assert.strictEqual(chain.getCurrentRound().phase, 'REVEAL');

  // Honest validators 1 & 2 reveal their secrets; Malicious Validator 3 WITHHOLDS!
  console.log('2.3 Honest Validators 1 & 2 reveal secrets. Validator 3 WITHHOLDS!');
  const r2Reveal1 = createEntropyReveal({
    roundId: round2.id,
    validator: val1.address,
    secret: r2Secret1,
    privateKey: val1.privateKey,
    publicKey: val1.publicKey
  });
  const r2Reveal2 = createEntropyReveal({
    roundId: round2.id,
    validator: val2.address,
    secret: r2Secret2,
    privateKey: val2.privateKey,
    publicKey: val2.publicKey
  });

  await chain.submitReveal(r2Reveal1);
  await chain.submitReveal(r2Reveal2);
  // Validator 3 deliberately does NOT reveal!

  // Record pre-draw stakes
  const val1PreStake = chain.getValidatorManager().getValidator(val1.address)!.stake;
  const val2PreStake = chain.getValidatorManager().getValidator(val2.address)!.stake;
  const val3PreStake = chain.getValidatorManager().getValidator(val3.address)!.stake;
  const preTotalBurned = chain.getLotteryStateMachine().getTotalBurned();

  // Advance blocks to trigger DRAW & SLASH
  console.log('2.3 Advancing blocks to trigger DRAW & SLASHING...');
  await chain.proposeBlock(getElectedProposer(chain));
  await chain.proposeBlock(getElectedProposer(chain));
  const r2DrawBlock = await chain.proposeBlock(getElectedProposer(chain));

  assert(r2DrawBlock.roundOutcome, 'Block should contain roundOutcome');
  const outcome2 = r2DrawBlock.roundOutcome!;

  console.log('=== Round 2 Outcome with Slashing ===');
  console.log(`Revealed Honest Validators: ${outcome2.revealedValidators.join(', ')}`);
  console.log(`Slashed Validators Count:   ${outcome2.slashedValidators.length}`);
  for (const s of outcome2.slashedValidators) {
    console.log(` -> Slashed Validator: ${s.validator}`);
    console.log(`    Slashed Stake:     ${formatEther(s.slashedStake)} Tokens`);
    console.log(`    Burned (50%):      ${formatEther(s.burnedAmount)} Tokens`);
    console.log(`    Bounty (50%):      ${formatEther(s.bountyAmount)} Tokens`);
  }

  // Verifications for slashing
  assert.strictEqual(outcome2.slashedValidators.length, 1, 'Validator 3 must be slashed');
  assert.strictEqual(outcome2.slashedValidators[0].validator, val3.address);
  assert.strictEqual(outcome2.slashedValidators[0].slashedStake, requiredStakeRound2);

  const expectedBurned = (requiredStakeRound2 * 50n) / 100n;
  const expectedBounty = requiredStakeRound2 - expectedBurned;
  assert.strictEqual(outcome2.slashedValidators[0].burnedAmount, expectedBurned);
  assert.strictEqual(outcome2.slashedValidators[0].bountyAmount, expectedBounty);

  // Verify Validator 3 state
  const val3Post = chain.getValidatorManager().getValidator(val3.address)!;
  console.log(`Validator 3 state: Slashed=${val3Post.slashed}, Stake=${formatEther(val3Post.stake)} Tokens (was ${formatEther(val3PreStake)})`);
  assert.strictEqual(val3Post.slashed, true, 'Validator 3 should be marked as slashed');
  assert.strictEqual(val3Post.stake, val3PreStake - requiredStakeRound2, 'Validator 3 stake should be slashed');

  // Verify Honest Validators received the bounty
  const val1Post = chain.getValidatorManager().getValidator(val1.address)!;
  const val2Post = chain.getValidatorManager().getValidator(val2.address)!;
  const expectedBountyEach = expectedBounty / 2n;
  console.log(`Honest Validators gained bounty: +${formatEther(expectedBountyEach)} each`);
  assert(val1Post.stake > val1PreStake, 'Validator 1 should have received slashing bounty');
  assert(val2Post.stake > val2PreStake, 'Validator 2 should have received slashing bounty');

  // Verify Burning
  const postTotalBurned = chain.getLotteryStateMachine().getTotalBurned();
  console.log(`Total Burned: ${formatEther(postTotalBurned)} Tokens (increased by ${formatEther(postTotalBurned - preTotalBurned)})`);
  assert.strictEqual(postTotalBurned - preTotalBurned, expectedBurned, 'Burned counter should match 50% slash');

  // =========================================================================
  // TEST 3: Byzantine Consensus Verification (Leader Election, Equivocation, Slot Time)
  // =========================================================================
  console.log('\n----------------------------------------------------');
  console.log('  TEST 3: Byzantine Consensus Verification');
  console.log('----------------------------------------------------');

  // 3.1 Leader Election Enforcement
  console.log('3.1 Verifying deterministic round-robin leader election...');
  const nextHeight = (chain.getHeadBlock()?.header.index ?? 0) + 1;
  const elected = chain.getProposerForHeight(nextHeight)!;
  const nonElected = [val1, val2].find((v) => v.address.toLowerCase() !== elected.address.toLowerCase())!;

  let unauthorizedThrown = false;
  try {
    await chain.proposeBlock(nonElected);
  } catch (err: any) {
    unauthorizedThrown = true;
    assert(err.message.includes('Invalid proposer'), `Expected leader election error, got: ${err.message}`);
  }
  assert.strictEqual(unauthorizedThrown, true, 'Non-elected proposer must be rejected');
  console.log(' -> Unauthorized proposer correctly rejected by leader election rule.');

  // 3.2 Anti-Equivocation Slashing
  console.log('3.2 Testing equivocation detection & proposer slashing...');
  const honestLeader = valMap.get(elected.address.toLowerCase())!;
  const legitBlock = await chain.proposeBlock(honestLeader);
  assert.strictEqual(legitBlock.header.index, nextHeight);

  // Conflicting block for the same height signed by the same leader
  const conflictingHeader = {
    ...legitBlock.header,
    timestamp: legitBlock.header.timestamp + 1,
    txRoot: keccak256Hex('conflicting-tx-tree')
  };
  const conflictingHash = keccak256Hex(JSON.stringify(conflictingHeader));
  const conflictingSig = signMessage(conflictingHash, honestLeader.privateKey);

  const conflictingBlock = {
    header: conflictingHeader,
    hash: conflictingHash,
    signature: conflictingSig,
    transactions: [],
    commitments: [],
    reveals: []
  };

  const equivocationResult = await chain.applyIncomingBlock(conflictingBlock);
  assert.strictEqual(equivocationResult.success, false);
  assert(equivocationResult.error?.includes('Equivocation detected'), 'Equivocation must be detected');

  const slashedLeaderState = chain.getValidatorManager().getValidator(honestLeader.address)!;
  assert.strictEqual(slashedLeaderState.slashed, true, 'Equivocating leader must be slashed');
  console.log(` -> Equivocation detected! Slashed double-proposer ${honestLeader.address}`);

  // 3.3 Slot Duration Timer Enforcement
  console.log('3.3 Testing slot duration timer enforcement...');
  const timedChain = new LotteryChain({
    slotTimeMs: 150,
    initialValidators: [
      { address: val1.address, publicKey: val1.publicKey, stake: 500n * ONE_ETHER }
    ],
    initialAccounts: { [val1.address]: 1000n * ONE_ETHER }
  });
  await timedChain.init();

  const tBlock1 = await timedChain.proposeBlock(val1);
  assert.strictEqual(tBlock1.header.index, 1);

  // Attempting immediate proposal should fail
  let slotEarlyThrown = false;
  try {
    await timedChain.proposeBlock(val1);
  } catch (err: any) {
    slotEarlyThrown = true;
    assert(err.message.includes('slot duration'), `Expected slot error, got: ${err.message}`);
  }
  assert.strictEqual(slotEarlyThrown, true, 'Immediate proposal must violate slot duration');

  // Waiting for slot interval to elapse
  await new Promise((res) => setTimeout(res, 160));
  const tBlock2 = await timedChain.proposeBlock(val1);
  assert.strictEqual(tBlock2.header.index, 2);
  console.log(' -> Slot duration timer properly enforced (early proposal rejected, timed proposal accepted).');

  await timedChain.stop();

  console.log('\n====================================================');
  console.log('  ALL INTEGRATION TESTS AND SIMULATIONS PASSED!  ');
  console.log('====================================================\n');

  await chain.stop();
}

runSimulation().catch((err) => {
  console.error('\nSIMULATION FAILED:', err);
  process.exit(1);
});
