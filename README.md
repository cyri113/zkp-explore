# zkp-explore

EVM transfers → hierarchical Merkle tree → zero-knowledge membership proofs.

## What this is

`zkp-explore` is a three-stage pipeline that lets you take any EVM token contract and produce a cryptographic proof of the form *"this specific transfer happened"* without revealing the rest of the history. Concretely, it:

1. Downloads every token-transfer event for a contract into a local database.
2. Rolls those transfers up into a tamper-evident Merkle tree of trees (a single root fingerprints the entire history).
3. Uses a zero-knowledge program (built with [o1js](https://github.com/o1-labs/o1js), Mina's proving system) to prove that a chosen transfer is a leaf of that root — the proof can be verified by anyone, and reveals nothing except the single root.

It runs entirely on your machine, uses SQLite for storage, and only talks to the outside world to download transfers from Alchemy.

## Architecture

```
┌───────────┐  alchemy_getAssetTransfers   ┌───────────┐   HTTP :3001    ┌──────────┐
│  Alchemy  │ ────────────────────────────►│  indexer  │◄────────────────│  merkle  │
└───────────┘                              │           │                 │          │
                                           │   CLI +   │                 │ CLI + :3002
                                           │   :3001   │                 │          │
                                           └─────┬─────┘                 └────┬─────┘
                                                 │                            │
                                           data/indexer.db               data/merkle.db
                                                                              │
                                                                merkle:query  │
                                                                              ▼
                                                                        data/input.json
                                                                              │
                                                                              ▼
                                                                       ┌─────────────┐
                                                                       │     zkp     │
                                                                       │  CLI only   │
                                                                       └──────┬──────┘
                                                                              │
                                                                        data/proof.json
```

## The three packages

| Package | Role | Docs |
|---|---|---|
| [`@zkp/indexer`](packages/indexer/README.md) | Fetches every token transfer for a contract from Alchemy, stores them in SQLite, serves them over HTTP on port 3001. | `packages/indexer/README.md` |
| [`@zkp/merkle`](packages/merkle/README.md) | Reads transfers from the indexer, builds fixed-height batch trees and a top-level snapshot tree, serves proofs. HTTP on port 3002. | `packages/merkle/README.md` |
| [`@zkp/zkp`](packages/zkp/README.md) | Compiles an o1js `ZkProgram` and produces / verifies a zero-knowledge proof that a transfer belongs to the snapshot root. CLI only. | `packages/zkp/README.md` |

## Prerequisites

- Node.js ≥ 20
- [pnpm](https://pnpm.io/)
- An [Alchemy](https://www.alchemy.com/) API key

## Setup

```bash
pnpm install
cp .env.example .env
# edit .env and set ALCHEMY_API_KEY=your-key-here
```

## End-to-end walkthrough

The six commands below are the full pipeline, exactly as you'd run them from the repository root. Each step annotates what it does and what it writes.

```bash
# 1. Download every token transfer for a contract into data/indexer.db
pnpm indexer:sync --contractAddress 0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85

# 2. Start the indexer HTTP server on :3001 so merkle can read transfers
pnpm indexer

# 3. Build the hierarchical merkle tree for asset 1 → data/merkle.db
pnpm merkle:build --asset-id 1 --batch-concurrency 3

# 4. Produce a witness for one wallet at one block → data/wallet.json
pnpm merkle:query \
  --asset-id 1 \
  --wallet 0x0009af4fc4318de8b959a5e8c0f622e297929417 \
  --block 2480930 > data/wallet.json

# 5. Reshape one transfer from data/wallet.json into data/input.json
#    (see packages/zkp/README.md for the exact schema), then:
pnpm zkp:prove --in data/input.json --out data/proof.json

# 6. Independently verify the proof
pnpm zkp:verify --proof data/proof.json
```

Notes:

- Step 2 starts a long-lived HTTP server; run it in a separate terminal.
- Step 4 can contain many transfers. The `data/input.json` expected by `zkp:prove` is a flatter shape — pick one transfer from `data/wallet.json` and map it:
  ```jsonc
  {
    "snapshotRoot":  <transfer.topLevelProof.snapshotRoot>,
    "leaf":          <transfer.leaf>,
    "batchSiblings": <transfer.batchProof.batchWitness>,   // 14 entries
    "topSiblings":   <transfer.topLevelProof.topWitness>   // 15 entries
  }
  ```
  See [`packages/zkp/README.md`](packages/zkp/README.md#input-file-schema) for the full schema.
- Step 5 is slow the first time it runs (several minutes): o1js compiles the ZK circuit.

## Root scripts

Every script is runnable from the repo root with `pnpm <script>`.

| Script | Description |
|---|---|
| `pnpm indexer:sync` | Download transfers for a contract into `data/indexer.db` (see `packages/indexer/README.md`) |
| `pnpm indexer` | Start the indexer HTTP server on `:3001` |
| `pnpm merkle:build` | Build the hierarchical merkle tree for an asset into `data/merkle.db` |
| `pnpm merkle:query` | Print wallet transfers + merkle proofs as JSON |
| `pnpm merkle` | Start the merkle HTTP server on `:3002` |
| `pnpm zkp:prove` | Generate a ZK snapshot-membership proof from a JSON input file |
| `pnpm zkp:verify` | Verify a previously generated proof JSON file |
| `pnpm test` | Run Jest across all three packages (`--runInBand`) |
| `pnpm build` | `tsc -b` across all packages |
| `pnpm clean` | Recursive clean of every package |

## Repository layout

```
packages/
  indexer/     @zkp/indexer  — Alchemy fetcher + HTTP server (port 3001)
  merkle/      @zkp/merkle   — hierarchical Poseidon merkle tree + HTTP server (port 3002)
  zkp/         @zkp/zkp      — o1js ZkProgram + prove/verify CLI
data/          local SQLite + JSON artifacts (gitignored)
```

## Development

```bash
# run all tests (all three packages, single worker)
pnpm test

# run tests for one package only
pnpm --filter @zkp/merkle test
pnpm --filter @zkp/zkp    test

# type-check the whole workspace
pnpm build
```

Tests run through a root `jest.config.js` that lists the three packages as Jest projects. The `@zkp/zkp` test suite compiles the o1js circuit and takes several minutes end-to-end; its timeout is set to 15 minutes.

## Notes and limitations

- Single-machine local development only. There is no deployment / hosting layer.
- Storage is SQLite in `data/` (WAL mode). `data/` is gitignored.
- The first `pnpm zkp:prove` of a session takes minutes because o1js has to compile the circuit. Proving and verifying are fast afterwards.
- Tree heights are hard-coded: `BATCH_TREE_HEIGHT = 15` (≥ 16 384 leaves per batch) and `TOP_TREE_HEIGHT = 16` (≥ 32 768 batches). These are compile-time constants shared between `@zkp/merkle` and `@zkp/zkp`; changing one requires re-compiling the circuit.
- Only EVM token transfers are currently supported, via a dedicated adapter in `@zkp/merkle`. The underlying Merkle tree is chain-agnostic.
