import { Field } from 'o1js';
import {
  PoseidonMerkleTree,
  transferToLeafHash,
  computeBatchArtifacts,
  BATCH_TREE_HEIGHT,
  TOP_TREE_HEIGHT,
  TransferLeaf,
} from '@zkp/merkle';
import { SnapshotMembership } from './SnapshotMembership';
import {
  transferLeafToCircuit,
  batchWitnessToCircuit,
  topWitnessToCircuit,
} from './proofAdapters';

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

function serializeWitness(
  w: Array<{ isLeft: boolean; sibling: Field }>
): Array<{ isLeft: boolean; sibling: string }> {
  return w.map(({ isLeft, sibling }) => ({ isLeft, sibling: sibling.toString() }));
}

describe('SnapshotMembership ZkProgram', () => {
  // o1js compile cost is high.
  jest.setTimeout(15 * 60 * 1000);

  // Build 3 batches of 4 transfers each, then a top-level tree of 3 batch roots.
  const batches: TransferLeaf[][] = [
    [makeTransfer(1), makeTransfer(2), makeTransfer(3), makeTransfer(4)],
    [makeTransfer(5), makeTransfer(6), makeTransfer(7), makeTransfer(8)],
    [makeTransfer(9), makeTransfer(10), makeTransfer(11), makeTransfer(12)],
  ];

  let prepared: ReturnType<typeof computeBatchArtifacts>[];
  let topTree: PoseidonMerkleTree;

  beforeAll(async () => {
    prepared = batches.map((b) => computeBatchArtifacts(b));
    const batchRootFields = prepared.map((p) => Field(BigInt(p.root)));
    topTree = PoseidonMerkleTree.fromLeaves(batchRootFields, TOP_TREE_HEIGHT);

    await SnapshotMembership.compile();
  });

  it('batch trees are normalized to BATCH_TREE_HEIGHT', () => {
    for (const p of prepared) {
      expect(p.treeHeight).toBe(BATCH_TREE_HEIGHT);
    }
  });

  it('top tree has fixed TOP_TREE_HEIGHT', () => {
    expect(topTree.height).toBe(TOP_TREE_HEIGHT);
  });

  it('proves and verifies snapshot membership', async () => {
    const batchIndex = 1;
    const leafIndex = 2;
    const transfer = batches[batchIndex][leafIndex];

    const batchTree = PoseidonMerkleTree.fromJSON(
      JSON.parse(prepared[batchIndex].treeJson)
    );
    const batchWitness = batchTree.getWitness(leafIndex);
    const topWitness = topTree.getWitness(batchIndex);
    const snapshotRoot = topTree.getRoot();

    // Off-circuit sanity
    const leafHash = transferToLeafHash(transfer);
    expect(
      PoseidonMerkleTree.verifyWitness(
        leafHash,
        batchWitness,
        batchTree.getRoot()
      )
    ).toBe(true);
    expect(
      PoseidonMerkleTree.verifyWitness(
        batchTree.getRoot(),
        topWitness,
        snapshotRoot
      )
    ).toBe(true);

    const leafCircuit = transferLeafToCircuit(transfer);
    const batchWitnessCircuit = batchWitnessToCircuit(
      serializeWitness(batchWitness)
    );
    const topWitnessCircuit = topWitnessToCircuit(serializeWitness(topWitness));

    const { proof } = await SnapshotMembership.prove(
      snapshotRoot,
      leafCircuit,
      batchWitnessCircuit,
      topWitnessCircuit
    );
    const ok = await SnapshotMembership.verify(proof);
    expect(ok).toBe(true);
  });

  it('fails to prove with a tampered leaf', async () => {
    const batchIndex = 0;
    const leafIndex = 1;
    const batchTree = PoseidonMerkleTree.fromJSON(
      JSON.parse(prepared[batchIndex].treeJson)
    );
    const batchWitness = batchTree.getWitness(leafIndex);
    const topWitness = topTree.getWitness(batchIndex);
    const snapshotRoot = topTree.getRoot();

    const tampered = { ...batches[batchIndex][leafIndex], value: '99999' };

    const leafCircuit = transferLeafToCircuit(tampered);
    const batchWitnessCircuit = batchWitnessToCircuit(
      serializeWitness(batchWitness)
    );
    const topWitnessCircuit = topWitnessToCircuit(serializeWitness(topWitness));

    await expect(
      SnapshotMembership.prove(
        snapshotRoot,
        leafCircuit,
        batchWitnessCircuit,
        topWitnessCircuit
      )
    ).rejects.toThrow();
  });
});
