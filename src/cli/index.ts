#!/usr/bin/env node
import { generateKeypair, keypairFromPrivateHex } from '../crypto/keys.js';
import { LotteryChain } from '../chain/chain.js';
import { ONE_ETHER, formatEther } from '../types/index.js';
import { createTransaction } from '../mempool/mempool.js';
import { createEntropyCommitment, createEntropyReveal } from '../consensus/randao.js';

function parseArgs(args: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i++;
      } else {
        result[key] = true;
      }
    } else if (!result.command) {
      result.command = arg;
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = (args.command as string) || 'help';

  switch (command) {
    case 'keygen': {
      const kp = generateKeypair();
      console.log('=== New Keypair Generated ===');
      console.log('Address:    ', kp.address);
      console.log('Public Key: ', kp.publicKey);
      console.log('Private Key:', kp.privateKey);
      break;
    }

    case 'node': {
      const p2pPort = Number(args.port) || 9001;
      const dbPath = (args.db as string) || `./data-node-${p2pPort}`;
      const privKey = (args.key as string) || '';
      const bootstrapRaw = (args.bootstrap as string) || '';
      const bootstrapAddrs = bootstrapRaw ? bootstrapRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;

      const keypair = privKey ? keypairFromPrivateHex(privKey) : generateKeypair();

      console.log(`Starting LotteryChain node on port ${p2pPort}...`);
      console.log(`Validator Address: ${keypair.address}`);

      const chain = new LotteryChain({
        dbPath,
        enableP2P: true,
        p2pPort,
        bootstrapAddrs,
        initialValidators: [{ address: keypair.address, publicKey: keypair.publicKey, stake: 500n * ONE_ETHER }],
        initialAccounts: { [keypair.address]: 10000n * ONE_ETHER }
      });

      await chain.init();
      console.log(`Node started! PeerId: ${chain.getP2PNode()?.getPeerId()}`);
      console.log(`Multiaddrs: ${chain.getP2PNode()?.getMultiaddrs().join(', ')}`);

      // Keep running
      process.on('SIGINT', async () => {
        console.log('\nStopping node...');
        await chain.stop();
        process.exit(0);
      });
      break;
    }

    case 'status': {
      const dbPath = (args.db as string) || './data-node-9001';
      const chain = new LotteryChain({ dbPath });
      await chain.init();
      const round = chain.getCurrentRound();
      const validators = chain.getValidators();
      const head = chain.getHeadBlock();

      console.log('=== Lottery Blockchain Status ===');
      console.log('Head Block:   #', head?.header.index ?? 0, 'Hash:', head?.hash);
      console.log('Current Round:', round.id);
      console.log('Phase:        ', round.phase);
      console.log('Jackpot:      ', `${formatEther(round.jackpot)} Tokens`);
      console.log('Tickets Sold: ', round.tickets.length);
      console.log('Validators:   ', validators.length, 'total');
      for (const v of validators) {
        console.log(` - ${v.address} | Stake: ${formatEther(v.stake)} Tokens | Slashed: ${v.slashed}`);
      }
      await chain.stop();
      break;
    }

    case 'help':
    default: {
      console.log(`
Usage: lottery-chain <command> [options]

Commands:
  keygen                     Generate a new Ed25519 keypair and address
  node                       Start a P2P blockchain node
    --port <number>          P2P port (default: 9001)
    --db <path>              Data directory for LevelDB
    --key <hex>              Private key for validator
    --bootstrap <multiaddrs> Comma-separated bootstrap multiaddresses
  status                     Display chain and round status
    --db <path>              Data directory to query
`);
      break;
    }
  }
}

main().catch(console.error);
