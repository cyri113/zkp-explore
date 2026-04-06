# @zkp/zkp

Prove a transfer is part of the snapshot root — without revealing anything else.

## What this is

A tiny zero-knowledge program written with [o1js](https://github.com/o1-labs/o1js) (Mina's proving system). Given a single EVM transfer and the two Merkle paths that `@zkp/merkle` produces (leaf → batch root → snapshot root), this package generates a cryptographic proof that the transfer is a leaf of that snapshot root. Anyone can verify the proof without ever seeing the transfer itself and without recomputing the tree.

## How it fits in

Third and final stage of the `zkp-explore` pipeline:

```
@zkp/indexer → @zkp/merkle → @zkp/zkp  (CLI: prove / verify)
```

Consumes a JSON file produced from `@zkp/merkle`'s `query` output. Writes a proof JSON.

## Prerequisites

You need an `input.json` matching the schema below. The easy way to get one:

1. `pnpm merkle:query --asset-id … --wallet … --block … > data/wallet.json`
2. Pick one transfer from `data/wallet.json` and reshape it into `{ snapshotRoot, leaf, batchSiblings, topSiblings }` (see [Input file schema](#input-file-schema)).

## Quick start

```bash
pnpm zkp:prove  --in data/input.json --out data/proof.json
pnpm zkp:verify --proof data/proof.json
```

The first `prove` run takes several minutes because o1js has to compile the circuit. Subsequent runs in the same process would be fast; across fresh `ts-node` invocations, each CLI call re-compiles.

## CLI reference

### `pnpm zkp:prove --in <input.json> --out <proof.json>`

1. Parses the input file and validates sibling array lengths.
2. Runs an **off-circuit sanity check**: hashes the leaf, walks `batchSiblings` then `topSiblings`, and asserts the result equals `snapshotRoot`. If this fails, it exits non-zero before the expensive compile step.
3. Compiles `SnapshotMembership` and generates the proof.
4. Verifies the proof locally and writes the output JSON.

Exits non-zero on any failure.

### `pnpm zkp:verify --proof <proof.json>`

Compiles the same ZkProgram, reconstructs the proof from its JSON form, verifies it, and prints `{ "verified": true, "snapshotRoot": "..." }` to stdout. Exits non-zero if verification fails.

## Input file schema

```jsonc
{
  "snapshotRoot": "12345…",                    // decimal Field string — the top-level root
  "leaf": {
    "from":        "0xaaaa…",                  // 20-byte hex address
    "to":          "0xbbbb…",                  // 20-byte hex address
    "value":       "1000",                     // decimal string (token amount, raw units)
    "txHash":      "0xcccc…",                  // 32-byte hex tx hash
    "logIndex":    0,                          // number
    "blockNumber": 19000001                    // number
  },
  "batchSiblings": [                            // 14 entries (BATCH_TREE_HEIGHT - 1)
    { "isLeft": false, "sibling": "…" },
    { "isLeft": true,  "sibling": "…" }
    // …14 total
  ],
  "topSiblings": [                              // 15 entries (TOP_TREE_HEIGHT - 1)
    { "isLeft": true,  "sibling": "…" }
    // …15 total
  ]
}
```

Field notes:

- **`snapshotRoot`** — decimal string of an o1js `Field`. Take it from `topLevelProof.snapshotRoot` in `merkle:query` output.
- **`leaf`** — identical to `@zkp/merkle`'s `TransferLeaf` type. Copy the `leaf` block straight out of the query result.
- **`batchSiblings`** — the path from the leaf up to the batch root. Must be exactly `BATCH_TREE_HEIGHT - 1 = 14` entries. Each entry is `{ isLeft, sibling }` where `isLeft` means the current node sits on the left (so the sibling is on the right). Take it from `batchProof.batchWitness`.
- **`topSiblings`** — the path from the batch root up to the snapshot root. Must be exactly `TOP_TREE_HEIGHT - 1 = 15` entries. Take it from `topLevelProof.topWitness`.

Lengths are fixed because the underlying o1js `MerkleWitness(N)` requires `N` at compile time. If you feed the wrong length, the CLI errors out before compiling.

## Output file schema

```json
{
  "verified": true,
  "snapshotRoot": "12345…",
  "proof": { "…": "o1js JsonProof" }
}
```

`proof` is whatever `proof.toJSON()` returns — pass it unchanged to `pnpm zkp:verify`.

## How it works

- **`SnapshotMembership`** (`src/SnapshotMembership.ts`) is a `ZkProgram` with one method:
  - Public input: `Field` — the snapshot root.
  - Private inputs: `TransferLeafCircuit`, `BatchMerkleWitness`, `TopMerkleWitness`.
  - Inside the method:
    1. Hash the leaf with the same 7-Field Poseidon encoding the off-chain tree uses.
    2. `batchWitness.calculateRoot(leafHash)` → candidate batch root.
    3. `topWitness.calculateRoot(batchRoot)` → candidate snapshot root.
    4. `assertEquals(snapshotRoot)`.

- **`TransferLeafCircuit`** (`src/TransferLeafCircuit.ts`) is an o1js `Struct` mirroring `transferToLeafHash` in `@zkp/merkle`. Its `hash()` method computes `Poseidon.hash([from, to, value, txHashHigh, txHashLow, logIndex, blockNumber])` exactly the way the batch tree did, so the in-circuit leaf hash equals the one stored in the batch.

- **`proofAdapters.ts`** converts the plain-JSON shapes (`TransferLeaf`, arrays of `{isLeft, sibling}`) into their circuit equivalents. The `txHash` is split into two 128-bit Fields to fit into the Poseidon input.

- **Witness classes** (`src/constants.ts`): `BatchMerkleWitness extends MerkleWitness(BATCH_TREE_HEIGHT)` and `TopMerkleWitness extends MerkleWitness(TOP_TREE_HEIGHT)`, both re-exported from `@zkp/merkle`'s constants so there is one source of truth.

## Performance notes

- **Compile** is the slow part: several minutes on first run.
- **Prove** is typically a few seconds once compiled.
- **Verify** is fast (milliseconds to ~1s).
- The CLI does the off-circuit sanity check *before* compiling, so a bad witness fails in milliseconds instead of minutes.

## Troubleshooting

- **`Expected batchSiblings.length === 14`** — your `batchSiblings` array is the wrong length. You probably grabbed a witness from a tree that wasn't built with `BATCH_TREE_HEIGHT = 15`. Rebuild `@zkp/merkle` and re-query.
- **`Expected topSiblings.length === 15`** — same story for the top tree (`TOP_TREE_HEIGHT = 16`).
- **`Pre-flight check failed: leaf + batchSiblings + topSiblings do not derive the provided snapshotRoot`** — the witness does not match the root. Make sure you took `leaf`, `batchSiblings`, `topSiblings`, and `snapshotRoot` from the *same* transfer in the *same* `merkle:query` output. If you rebuilt the merkle DB, re-run `merkle:query` to regenerate the witness.
- **First run is slow** — expected. o1js is compiling the circuit.
- **`verify` prints `verified: false`** — the proof file is corrupt or was generated against a different circuit. Re-run `prove`.
