# zkp-explore Merkle Tree Module

## Overview

In-memory Merkle tree for pre-hashed leaves with historical root snapshots.
- Chain-agnostic: callers provide `Field[]` leaves.
- EVM adapter example: normalizes transfer events into `LeafEntry`.
- Deterministic: same input order => same root.
- Persistence: `toJSON()` / `fromJSON(json)` roundtrip.

## Core types

- `LeafEntry`: `{ id, fields, timestamp, sortKey }`
- `RootSnapshot`: `{ root, leafIndex, timestamp, sortKey }`

## Merkle Tree API

```ts
import { HashTree } from './src/merkle/HashTree';
import { evmTransferToLeaf } from './src/merkle/adapters/evm';

const tree = new HashTree(20);

const evt = {
  transactionHash: '0xabc',
  logIndex: 1,
  blockNumber: 42,
  blockTimestamp: 1700000000,
  from: '0x111',
  to: '0x222',
  value: 123n,
};

const leaf = evmTransferToLeaf(evt);
tree.addLeaf(leaf);

const root = tree.getRoot();
const snap = tree.getSnapshots()[0];

const json = tree.toJSON();
const restored = HashTree.fromJSON(json);

console.log('is valid', restored.validate(0n));
```

## Historical roots

```ts
// returns latest root <= timestamp, throws if before first leaf
const rootAt = tree.getRootAt(1700000000);
```

## EVM Transaction Fetcher

Fetch all transactions (in/out) for an Ethereum address via Alchemy.

### Setup

Copy `.env.example` to `.env` and add your Alchemy API key:

```bash
cp .env.example .env
# Edit .env and add your API key
```

### CLI usage

```bash
# Fetch all transactions (may take time for active addresses)
pnpm evm 0xa23fDEBe6Cb888221820B5D56F16a1c5a73Ff4d0

# Limit to first N pages (per direction; 0=no limit, max=100)
pnpm evm 0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85 eth-mainnet 2

# Specify network
pnpm evm 0xa23fDEBe6Cb888221820B5D56F16a1c5a73Ff4d0 eth-mainnet
```

**Notes:**
- Each page contains up to 100 transfers.
- `maxPages` applies to both incoming and outgoing directions (default: unlimited).
- Actual result count may be lower after deduplication.
- Large contracts (10k+ transfers) without page limit may take several minutes.

### Performance optimizations

The service uses several strategies to maximize throughput:

- **Concurrent direction fetching**: Incoming and outgoing transfers are fetched in parallel via `Promise.all()`.
- **Exponential backoff**: Rate-limited requests (HTTP 429) trigger automatic retry with 1s, 2s, 4s backoff.
- **Pagination**: Each page fetches up to 100 transfers; large result sets are fetched concurrently.
- **Deduplication**: Results are deduplicated by transaction hash before returning.

Metrics from benchmarks on large contracts (300+ pages):
- 6 pages (600 raw transfers): ~5.3 seconds
- Speedup from parallelization: ~2x vs sequential

### Library usage

```ts
import { fetchAllTransactions } from './src/service/AlchemyTxService';

// Fetch all transactions
const txs = await fetchAllTransactions(apiKey, '0xa23f...', 'eth-mainnet');

// Limit to first 2 pages per direction
const txs = await fetchAllTransactions(apiKey, '0xa23f...', 'eth-mainnet', 2);

console.log(txs); // AssetTransfer[]
```

## Testing

```bash
pnpm test
```

Test files:
- `src/merkle/HashTree.test.ts`
- `src/merkle/adapters/evm.test.ts`
- `src/service/AlchemyTxService.test.ts`

## Notes

- `HashTree.addLeaf` enforces strictly increasing `sortKey` and unique `id`.
- `fromJSON` rebuilds the tree from leaves and restores snapshots.
- `fetchAllTransactions` deduplicates tx hashes and sorts by block number.
