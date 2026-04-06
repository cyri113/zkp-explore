import { Field } from 'o1js';

// --- Legacy flat tree types (kept for backward compat) ---

export type LeafEntry = {
  id: string;
  fields: Field[];
  timestamp: number;
  sortKey: string;
};

export type RootSnapshot = {
  root: string;
  leafIndex: number;
  timestamp: number;
  sortKey: string;
};

// --- Hierarchical merkle tree types ---

export interface TransferLeaf {
  from: string;
  to: string;
  value: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
}

export interface BatchProof {
  batchId: number;
  leafIndex: number;
  leaf: TransferLeaf;
  leafHash: string;
  batchWitness: Array<{ isLeft: boolean; sibling: string }>;
  batchRoot: string;
}

export interface TopLevelProof {
  batchIndex: number;
  topWitness: Array<{ isLeft: boolean; sibling: string }>;
  snapshotRoot: string;
}

export interface WalletTransferResult {
  wallet: string;
  blockNumber: number;
  snapshotRoot: string;
  batchCount: number;
  transfers: Array<{
    leaf: TransferLeaf;
    batchProof: BatchProof;
    topLevelProof: TopLevelProof;
  }>;
  /** Set when `limit` was passed and at least that many transfers matched */
  truncated?: boolean;
  /** Max transfers requested (only when a limit was applied) */
  limit?: number;
}

export const BATCH_SIZE = 10_000;
export const INITIAL_TOP_LEVEL_HEIGHT = 8;

/**
 * Fixed height for batch Merkle trees so every batch proof has the same
 * witness length. Required for circuit compatibility: o1js `MerkleWitness(N)`
 * needs a compile-time constant. 2^14 = 16384 ≥ BATCH_SIZE = 10_000.
 */
export const BATCH_TREE_HEIGHT = 15;

/**
 * Fixed height for the top-level Merkle tree (tree of batch roots). Also
 * required to be a compile-time constant for circuit compatibility.
 * 2^15 = 32_768 batches × BATCH_SIZE = up to ~328M leaves per snapshot.
 */
export const TOP_TREE_HEIGHT = 16;
