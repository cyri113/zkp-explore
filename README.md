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

## API

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

## Testing

```bash
pnpm test
```

Test files:
- `src/merkle/HashTree.test.ts`
- `src/merkle/adapters/evm.test.ts`

## Notes

- `HashTree.addLeaf` enforces strictly increasing `sortKey` and unique `id`.
- `fromJSON` rebuilds the tree from leaves and restores snapshots.
