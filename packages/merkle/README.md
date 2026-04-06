# @zkp/merkle

Hierarchical Poseidon Merkle tree over EVM transfers, with membership proofs.

## What this is

Takes the transfers `@zkp/indexer` has downloaded and organizes them into a tree of trees. Every group of up to 10,000 transfers becomes a *batch tree*, and all batch roots are then summarized into a single *snapshot tree*. The single snapshot root is a tamper-evident fingerprint of the entire transfer history. For any wallet at any block, this package can return the transfers along with the cryptographic path from each transfer up to that snapshot root — so a third party can later verify membership without seeing the full history.

## How it fits in

Second stage of the `zkp-explore` pipeline:

```
@zkp/indexer (HTTP, 3001) → @zkp/merkle → @zkp/zkp
```

Reads transfers from `@zkp/indexer` over HTTP. Writes `data/merkle.db`. Its `query` output feeds the ZK proof in `@zkp/zkp`.

## Prerequisites

- `@zkp/indexer` must be running (`pnpm indexer`) and must already contain data (`pnpm indexer:sync --contractAddress ...`).
- The target asset must exist in the indexer. Use `curl http://localhost:3001/assets` to list asset ids.

## Quick start

Run from the repository root:

```bash
# 1. Build the hierarchical tree for asset 1, prepping 3 batches in parallel
pnpm merkle:build --asset-id 1 --batch-concurrency 3

# 2. Query one wallet at one block, capture the witness JSON
pnpm merkle:query \
  --asset-id 1 \
  --wallet 0x0009af4fc4318de8b959a5e8c0f622e297929417 \
  --block 2480930 > data/wallet.json

# 3. (Optional) serve the merkle package over HTTP on :3002
pnpm merkle
```

## Fixed tree heights

These heights are compile-time constants because the ZkProgram in `@zkp/zkp` needs them at circuit-compilation time.

| Constant | Value | Capacity |
|---|---|---|
| `BATCH_TREE_HEIGHT` | `15` | 2¹⁴ = 16,384 leaves per batch (≥ `BATCH_SIZE` = 10,000) |
| `TOP_TREE_HEIGHT` | `16` | 2¹⁵ = 32,768 batches per snapshot (~328 M leaves total) |

Every batch witness is `BATCH_TREE_HEIGHT - 1 = 14` siblings, every top witness is `TOP_TREE_HEIGHT - 1 = 15` siblings. This is what `@zkp/zkp` expects.

## CLI: `merkle:build`

Fetches transfers from the indexer and (re)builds the hierarchical tree for one asset.

| Flag | Type | Default | Description |
|---|---|---|---|
| `--asset-id` | number | `MERKLE_ASSET_ID` or `1` | Asset id from the indexer (`GET /assets`) |
| `--indexer-url` | string | `http://localhost:3001` | Base URL of the indexer HTTP API |
| `--batch-size` | number | `10000` | Transfers per batch |
| `--batch-concurrency` | number | `MERKLE_BATCH_CONCURRENCY` or `1` | `p-limit`: prep up to N full batches before persisting. `1` = flush each batch immediately. Range 1–32 |
| `--fetch-page-size` | number | `0` (auto, capped at 2000) | Indexer `page_size`. Auto mode caps at 2000 rows/request |
| `--reset` | boolean | `false` | **Wipes the entire merkle SQLite DB (all assets)** and rebuilds from scratch for `--asset-id` |

On success it prints a JSON summary on stdout (batch count, snapshot root, through-block) and logs per-batch progress on stderr.

## CLI: `merkle:query`

Produces a JSON witness file for a specific wallet at a specific block.

| Flag | Type | Default | Description |
|---|---|---|---|
| `--asset-id` | number | **required** | Asset id |
| `--wallet` | string | **required** | Wallet address (`0x...`) |
| `--block` | number | **required** | Block number to query at |
| `--limit` | number | `500` | Max transfers included with proofs. `0` = no limit (can be huge) |

Output shape:

```json
{
  "wallet": "0x…",
  "blockNumber": 2480930,
  "snapshotRoot": "…",
  "batchCount": 42,
  "transfers": [
    {
      "leaf": {
        "from": "0x…", "to": "0x…", "value": "…",
        "txHash": "0x…", "logIndex": 0, "blockNumber": 2480930
      },
      "batchProof": {
        "batchId": 7,
        "leafIndex": 123,
        "leaf":   { "…": "…" },
        "leafHash": "…",
        "batchWitness": [ { "isLeft": false, "sibling": "…" }, "… 14 total" ],
        "batchRoot": "…"
      },
      "topLevelProof": {
        "batchIndex": 6,
        "topWitness":  [ { "isLeft": true, "sibling": "…" }, "… 15 total" ],
        "snapshotRoot": "…"
      }
    }
  ]
}
```

### Turning query output into a `zkp:prove` input

`zkp:prove` expects a flatter shape. Pick one transfer from `transfers[]` and map it as follows:

```jsonc
{
  "snapshotRoot":  <topLevelProof.snapshotRoot>,
  "leaf":          <leaf>,
  "batchSiblings": <batchProof.batchWitness>,   // 14 entries
  "topSiblings":   <topLevelProof.topWitness>   // 15 entries
}
```

Save this as e.g. `data/input.json` and feed it to `pnpm zkp:prove --in data/input.json --out data/proof.json`.

## HTTP API: `pnpm merkle`

Starts a server on `MERKLE_PORT` (default `3002`).

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | `{ "status": "ok", "service": "merkle" }` |
| `POST` | `/tree/build?asset_id=N` | Re-run the build for an asset (reads from `INDEXER_URL`) |
| `GET` | `/tree/summary?asset_id=N` | Latest snapshot root, batch count, tree height, through-block, batch roots |
| `GET` | `/tree/proof?batch=B&leaf=L` | Raw batch proof for a given `(batchId, leafIndex)` |
| `GET` | `/wallet/:address/transfers?asset_id=N&block=B` | Same payload as `merkle:query` for that wallet and block |

## Environment variables

| Name | Default | Purpose |
|---|---|---|
| `MERKLE_PORT` | `3002` | HTTP port for `pnpm merkle` |
| `INDEXER_URL` | `http://localhost:3001` | Base URL used to fetch transfers from the indexer |
| `MERKLE_ASSET_ID` | — | Default `--asset-id` for `merkle:build` |
| `MERKLE_BATCH_CONCURRENCY` | `1` | Default `--batch-concurrency` (1–32) |
| `MERKLE_FETCH_PAGE_SIZE` | — | Override indexer `page_size` (≥ 100, capped at 50,000) |

## Data layout

```
data/merkle.db         SQLite database (WAL mode), gitignored
```

Tables (high-level):

- `batches` — one row per batch tree: `assetId`, `root`, `leafCount`, `firstBlock`, `lastBlock`, serialized tree nodes.
- `batch_leaves` — one row per leaf: `(batchId, leafIndex)`, leaf fields, leaf hash.
- `wallet_index` — `(assetId, wallet) → [(batchId, leafIndices)]`, used by `query`.
- `snapshots` — one row per top-level snapshot: `assetId`, `root`, `batchCount`, `treeHeight`, `throughBlock`, serialized tree nodes.

## How it works

- **`PoseidonMerkleTree`** (`src/PoseidonMerkleTree.ts`) is a binary-heap Merkle tree with `Field(0)` empty leaves and `Poseidon.hash([left, right])` as the internal hash. This is intentionally identical to o1js's `MerkleTree`, so in-circuit and off-circuit roots match.
- **Leaf encoding** (`src/adapters/evm.ts`, `transferToLeafHash`): each transfer is encoded as 7 Fields — `[from, to, value, txHashHigh, txHashLow, logIndex, blockNumber]` — and hashed with `Poseidon.hash`. Addresses are normalized to lowercase hex before encoding. The ZkProgram in `@zkp/zkp` uses the exact same encoding so an in-circuit hash equals the stored leaf hash.
- **`BatchBuilder`** (`src/BatchBuilder.ts`) pulls pages from the indexer, buffers into batches of `BATCH_SIZE`, and for each batch computes the tree + wallet index in a worker before writing to SQLite. It then builds/updates the top-level snapshot tree at `TOP_TREE_HEIGHT`.
- **Fixed heights are not negotiable.** Batch trees are always built at `BATCH_TREE_HEIGHT` and the top tree at `TOP_TREE_HEIGHT`, so every witness has the exact length the ZkProgram expects.
- **`QueryService`** (`src/QueryService.ts`) picks the snapshot whose committed tip is at or before the query block (historical view), then walks every batch that contains the wallet, emitting both the batch-level and top-level proof for each matching leaf. An LRU cache (20 batch trees) keeps re-queries fast.

## Troubleshooting

- **`No batches`** from `merkle:build` — the indexer has no rows for this asset. Check `curl http://localhost:3001/transactions/count?asset_id=N`.
- **`Top tree overflow`** — you have more than 32,768 batches (i.e. > ~328M transfers). Increase `TOP_TREE_HEIGHT` in both `@zkp/merkle` and `@zkp/zkp` and re-compile the circuit.
- **Query returns empty** — either the wallet has no transfers for this asset, or the earliest snapshot tip is after `--block`. Try a more recent `--block`, or rebuild.
- **Output JSON is enormous** — pass a smaller `--limit` (default is already 500).
