# Lottery Chain

A decentralized application blockchain for provably fair lottery rounds using `js-libp2p` and a stake-backed multi-party commit-reveal (RANDAO) randomness engine.

## Features

- **P2P Networking (`js-libp2p`)**: GossipSub v1.1 topics for `/lottery/tx/1.0.0`, `/lottery/entropy/1.0.0`, and `/lottery/blocks/1.0.0` with mDNS discovery, TCP/Yamux, and Noise security.
- **Ethereum-Standard Cryptography**: `secp256k1` ECDSA signatures, `Keccak-256` hashing, and `0x...` EIP-55 checksum addresses.
- **Stake-Backed RANDAO**: Two-phase multi-party commit-reveal protocol with XOR entropy aggregation ($R = \text{Keccak256}(s_1 \oplus \dots \oplus s_k)$).
- **Economic Security & Slashing**: Dynamic anti-withholding stake enforcement ($D > \text{Jackpot}$), 50% burning of slashed stake, and 50% distribution as slashing bounty to honest validators.
- **Round Economics**: 90% jackpot to the winning ticket, 5% validator fee pool, and 5% rollover reserve to the next round.
- **Ledger Storage**: LevelDB on-disk persistence via `classic-level` and in-memory cache.

## Getting Started

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run simulation test (3-validator lifecycle & slashing)
npm test

# Generate new secp256k1 keypair & Ethereum address
npm start keygen

# Start a primary P2P node (default port 9001)
npm start node -- --port 9001

# Start a second node on the same machine (auto-connects via mDNS)
npm start node -- --port 9002

# Or connect explicitly via bootstrap address
npm start node -- --port 9002 --bootstrap "/ip4/127.0.0.1/tcp/9001/p2p/<PEER_ID>"
```

### CLI Options for `node`

- `--port <number>`: Port to listen for incoming P2P connections (default: `9001`).
- `--db <path>`: Directory path for LevelDB storage (default: `./data-node-<port>`).
- `--key <hex>`: Hex-encoded private key for the validator node.
- `--bootstrap <multiaddrs>`: Comma-separated multiaddresses for bootstrap peers.

Nodes running locally on the same network automatically discover and connect to each other using mDNS.

## Documentation

For a comprehensive architectural breakdown, mathematical analysis, and protocol specifications, see the [Deep Dive Technical Documentation](doc/README.md).
