# @zkp/indexer

Fetch EVM token transfers from Alchemy and serve them over HTTP.

## What this is

Give this service a token contract address and it will download every token-transfer event the contract has ever emitted, store it in a local SQLite database, and expose a tiny HTTP API so the rest of the pipeline can read those transfers back. It is designed to be run once (or occasionally, to catch up with new blocks) and left running as a read-only server.

## How it fits in

First stage of the `zkp-explore` pipeline:

```
Alchemy → @zkp/indexer → @zkp/merkle → @zkp/zkp
```

Writes `data/indexer.db`. Read by `@zkp/merkle` over HTTP.

## Prerequisites

- An Alchemy API key. Copy `.env.example` to `.env` at the repo root and set:
  ```
  ALCHEMY_API_KEY=your-key-here
  ```

## Quick start

Run from the repository root:

```bash
# 1. One-shot sync: download every transfer for a contract
pnpm indexer:sync --contractAddress 0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85

# 2. Serve the indexed data on http://localhost:3001
pnpm indexer
```

The first command writes to `data/indexer.db` and can be re-run later to pick up new transfers. The second command starts the HTTP server that `@zkp/merkle` reads from.

## CLI: `indexer:sync`

Downloads transfers and writes them to `data/indexer.db`.

| Flag | Type | Default | Description |
|---|---|---|---|
| `--contractAddress` | string | **required** | EVM token contract to index |
| `--network` | string | `eth-mainnet` | `eth-mainnet`, `goerli`, or `sepolia` |
| `--maxPages` | number | `0` | Max pages per chunk. `0` = unlimited |
| `--reset` | boolean | `false` | Wipe stored transactions and checkpoints, then fetch from scratch |

**Resume behaviour.** Without `--reset`, subsequent runs resume from the last contiguous checkpoint `(block_number)` saved on the previous run. Duplicates are deduplicated at insertion time by Alchemy `uniqueId`, so it is safe to re-run.

On success the CLI prints a JSON summary on stdout and logs progress on stderr:

```json
{
  "contractAddress": "0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85",
  "network": "eth-mainnet",
  "totalStored": 12345,
  "fetched": 12345,
  "inserted": 12345
}
```

## HTTP API: `pnpm indexer`

Starts a tiny HTTP server on `INDEXER_PORT` (default `3001`).

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Returns `{ "status": "ok", "service": "indexer" }` |
| `GET` | `/assets` | Lists every indexed asset (id, network, contract address) |
| `GET` | `/transactions/count?asset_id=N` | Total number of stored transfers. `asset_id` is optional — omit it for the global count |
| `GET` | `/transactions?asset_id=N&page_size=1000&after_block=-1&after_log=-1` | Paginated transfers ordered by `(block_number, log_index)`. Use `after_block` / `after_log` from the previous page to keep iterating |

All responses are JSON. Errors return `{ "error": "..." }` with an appropriate HTTP status.

## Environment variables

| Name | Default | Purpose |
|---|---|---|
| `ALCHEMY_API_KEY` | — (required) | Alchemy API key used by `indexer:sync` |
| `INDEXER_PORT` | `3001` | HTTP port for `pnpm indexer` |

## Data layout

```
data/indexer.db        SQLite database (WAL mode), gitignored
```

Tables (high-level):

- `networks` — one row per chain (e.g. `eth-mainnet`).
- `assets` — one row per `(network, contract_address)` pair. This is the `asset_id` you pass downstream.
- `raw_transactions` — every fetched transfer, stored as a raw JSON blob keyed by Alchemy `uniqueId`. Chain-agnostic by design.
- `checkpoints` — the last contiguous `block_number` safely stored, per asset. Used to resume efficiently on the next run.

## How it works

- Fetches incoming and outgoing transfers concurrently via `Promise.all`, then deduplicates by `uniqueId`.
- Retries rate-limited requests (HTTP 429) with exponential backoff (1s, 2s, 4s).
- Inserts pages incrementally as they arrive, so large contracts make steady forward progress instead of holding everything in memory.
- Checkpoints are saved only at the contiguous watermark, so `--reset`-less resume is always safe.

## Troubleshooting

- **`ALCHEMY_API_KEY not found in environment`** — you need a `.env` at the repo root with `ALCHEMY_API_KEY=...`.
- **Sync seems stuck** — very active contracts have hundreds of pages of history. Watch the `[Progress]` lines on stderr; they tick every page.
- **Out-of-date data** — re-run `pnpm indexer:sync --contractAddress ...` without `--reset`; it will resume from the last checkpoint and only fetch new blocks.
