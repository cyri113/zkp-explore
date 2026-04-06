import { Field, ZkProgram } from 'o1js';
import { BatchMerkleWitness, TopMerkleWitness } from './constants';
import { TransferLeafCircuit } from './TransferLeafCircuit';

/**
 * ZkProgram proving that a private TransferLeaf is part of a public
 * snapshot root produced by @zkp/merkle's hierarchical tree.
 *
 * Public input: snapshotRoot (Field) — the top-level tree root.
 * Private inputs:
 *   - leaf: TransferLeafCircuit (the EVM transfer being proven)
 *   - batchWitness: BatchMerkleWitness (path leaf → batchRoot)
 *   - topWitness:   TopMerkleWitness   (path batchRoot → snapshotRoot)
 *
 * The circuit:
 *   1. Re-hashes the leaf with the same 7-Field Poseidon encoding as
 *      `transferToLeafHash`.
 *   2. Walks the batch witness to derive the batch root.
 *   3. Walks the top witness, treating that batch root as a leaf, to
 *      derive the snapshot root.
 *   4. Asserts the result equals the public snapshot root.
 */
export const SnapshotMembership = ZkProgram({
  name: 'SnapshotMembership',
  publicInput: Field,
  methods: {
    prove: {
      privateInputs: [TransferLeafCircuit, BatchMerkleWitness, TopMerkleWitness],
      async method(
        snapshotRoot: Field,
        leaf: TransferLeafCircuit,
        batchWitness: BatchMerkleWitness,
        topWitness: TopMerkleWitness
      ) {
        const leafHash = leaf.hash();
        const batchRoot = batchWitness.calculateRoot(leafHash);
        const computedSnapshotRoot = topWitness.calculateRoot(batchRoot);
        computedSnapshotRoot.assertEquals(snapshotRoot);
      },
    },
  },
});

export class SnapshotMembershipProof extends ZkProgram.Proof(SnapshotMembership) {}
