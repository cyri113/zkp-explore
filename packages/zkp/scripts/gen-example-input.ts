/**
 * Generates an example input.json for `pnpm zkp:prove`.
 * Builds a tiny synthetic batch + top-level tree and writes the JSON
 * shape expected by the CLI.
 */
import { writeFileSync } from 'fs';
import { Field } from 'o1js';
import {
  PoseidonMerkleTree,
  computeBatchArtifacts,
  TOP_TREE_HEIGHT,
  TransferLeaf,
} from '@zkp/merkle';

function makeTransfer(seed: number): TransferLeaf {
  const hex = seed.toString(16).padStart(2, '0');
  return {
    from: '0x' + 'aa'.repeat(19) + hex,
    to: '0x' + 'bb'.repeat(19) + hex,
    value: String(1000 + seed),
    txHash: '0x' + 'cc'.repeat(31) + hex,
    logIndex: seed,
    blockNumber: 19_000_000 + seed,
  };
}

const batches: TransferLeaf[][] = [
  [makeTransfer(1), makeTransfer(2)],
  [makeTransfer(3), makeTransfer(4)],
];

const prepared = batches.map((b) => computeBatchArtifacts(b));
const topTree = PoseidonMerkleTree.fromLeaves(
  prepared.map((p) => Field(BigInt(p.root))),
  TOP_TREE_HEIGHT
);

const batchIndex = 1;
const leafIndex = 0;
const leaf = batches[batchIndex][leafIndex];

const batchTree = PoseidonMerkleTree.fromJSON(
  JSON.parse(prepared[batchIndex].treeJson)
);
const batchWitness = batchTree.getWitness(leafIndex);
const topWitness = topTree.getWitness(batchIndex);

const out = {
  snapshotRoot: topTree.getRoot().toString(),
  leaf,
  batchSiblings: batchWitness.map((w) => ({
    isLeft: w.isLeft,
    sibling: w.sibling.toString(),
  })),
  topSiblings: topWitness.map((w) => ({
    isLeft: w.isLeft,
    sibling: w.sibling.toString(),
  })),
};

const outPath = process.argv[2] ?? '/tmp/zkp-input.json';
writeFileSync(outPath, JSON.stringify(out, null, 2));
process.stderr.write(`wrote ${outPath}\n`);
