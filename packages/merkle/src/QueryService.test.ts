import { Field, Poseidon } from 'o1js';
import { MerkleDb } from './MerkleDb';
import { BatchBuilder } from './BatchBuilder';
import { QueryService } from './QueryService';
import { PoseidonMerkleTree } from './PoseidonMerkleTree';
import { TransferLeaf } from './types';
import { transferToLeafHash } from './adapters/evm';

const TEST_ASSET_ID = 1;

function makeTransfer(
  blockNumber: number,
  logIndex: number,
  from = '0xaaa',
  to = '0xbbb'
): TransferLeaf {
  return {
    from: from.toLowerCase(),
    to: to.toLowerCase(),
    value: '1000',
    txHash: `0x${'0'.repeat(60)}${blockNumber.toString(16).padStart(4, '0')}`,
    logIndex,
    blockNumber,
  };
}

describe('QueryService', () => {
  let db: MerkleDb;
  let builder: BatchBuilder;
  let query: QueryService;

  beforeEach(() => {
    db = new MerkleDb(':memory:');
    builder = new BatchBuilder(db, TEST_ASSET_ID, 5);
    query = new QueryService(db, 5);
  });

  afterEach(() => {
    db.close();
  });

  function buildTestData() {
    // Batch 1: blocks 100-100 — 0xaaa sends to 0xbbb
    builder.buildBatch([
      makeTransfer(100, 0, '0xaaa', '0xbbb'),
      makeTransfer(100, 1, '0xaaa', '0xccc'),
      makeTransfer(100, 2, '0xbbb', '0xccc'),
    ]);

    // Batch 2: blocks 200-200 — 0xbbb sends to 0xaaa
    builder.buildBatch([
      makeTransfer(200, 0, '0xbbb', '0xaaa'),
      makeTransfer(200, 1, '0xccc', '0xaaa'),
    ]);

    builder.buildTopLevelTree();
  }

  it('returns transfers for a wallet', () => {
    buildTestData();

    const result = query.getWalletTransfersAtBlock(TEST_ASSET_ID, '0xaaa', 300);

    expect(result.wallet).toBe('0xaaa');
    expect(result.snapshotRoot).toBeTruthy();
    // 0xaaa appears in: batch1 transfers 0,1 (as from), batch2 transfers 0,1 (as to)
    expect(result.transfers.length).toBe(4);
  });

  it('respects limit and sets truncated', () => {
    buildTestData();

    const result = query.getWalletTransfersAtBlock(TEST_ASSET_ID, '0xaaa', 300, 2);

    expect(result.transfers.length).toBe(2);
    expect(result.limit).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('filters by block number', () => {
    // Build batch 1 at block 100
    builder.buildBatch([
      makeTransfer(100, 0, '0xaaa', '0xbbb'),
    ]);
    builder.buildTopLevelTree();

    // Build batch 2 at block 200
    builder.buildBatch([
      makeTransfer(200, 0, '0xaaa', '0xbbb'),
    ]);
    builder.buildTopLevelTree();

    // Query at block 150 — should only get batch 1 snapshot
    const result = query.getWalletTransfersAtBlock(TEST_ASSET_ID, '0xaaa', 150);

    // Snapshot at block 100 has 1 batch, 0xaaa has 1 transfer
    expect(result.batchCount).toBe(1);
    expect(result.transfers.length).toBe(1);
    expect(result.transfers[0].leaf.blockNumber).toBe(100);
  });

  it('returns empty for unknown wallet', () => {
    buildTestData();

    const result = query.getWalletTransfersAtBlock(TEST_ASSET_ID, '0xddd', 300);

    expect(result.transfers.length).toBe(0);
    expect(result.snapshotRoot).toBeTruthy();
  });

  it('returns empty when no snapshot exists', () => {
    const result = query.getWalletTransfersAtBlock(TEST_ASSET_ID, '0xaaa', 300);

    expect(result.transfers.length).toBe(0);
    expect(result.snapshotRoot).toBe('');
  });

  it('is case-insensitive for wallet addresses', () => {
    buildTestData();

    const lower = query.getWalletTransfersAtBlock(TEST_ASSET_ID, '0xaaa', 300);
    const upper = query.getWalletTransfersAtBlock(TEST_ASSET_ID, '0xAAA', 300);

    expect(lower.transfers.length).toBe(upper.transfers.length);
  });

  it('isolates queries by asset', () => {
    buildTestData();

    // Query a different asset — should return nothing
    const result = query.getWalletTransfersAtBlock(999, '0xaaa', 300);
    expect(result.transfers.length).toBe(0);
    expect(result.snapshotRoot).toBe('');
  });

  describe('proof verification', () => {
    it('batch proofs are valid', () => {
      buildTestData();

      const result = query.getWalletTransfersAtBlock(TEST_ASSET_ID, '0xaaa', 300);

      for (const { leaf, batchProof } of result.transfers) {
        // Re-hash the leaf
        const leafHash = transferToLeafHash(leaf);

        // Walk the batch witness
        const witness = batchProof.batchWitness.map((w) => ({
          isLeft: w.isLeft,
          sibling: Field(BigInt(w.sibling)),
        }));

        const valid = PoseidonMerkleTree.verifyWitness(
          leafHash,
          witness,
          Field(BigInt(batchProof.batchRoot))
        );
        expect(valid).toBe(true);
      }
    });

    it('top-level proofs are valid', () => {
      buildTestData();

      const result = query.getWalletTransfersAtBlock(TEST_ASSET_ID, '0xaaa', 300);

      for (const { batchProof, topLevelProof } of result.transfers) {
        // The batch root should be a leaf in the top-level tree
        const batchRootField = Field(BigInt(batchProof.batchRoot));

        const witness = topLevelProof.topWitness.map((w) => ({
          isLeft: w.isLeft,
          sibling: Field(BigInt(w.sibling)),
        }));

        const valid = PoseidonMerkleTree.verifyWitness(
          batchRootField,
          witness,
          Field(BigInt(topLevelProof.snapshotRoot))
        );
        expect(valid).toBe(true);
      }
    });

    it('full two-level proof chain: leaf → batch root → snapshot root', () => {
      buildTestData();

      const result = query.getWalletTransfersAtBlock(TEST_ASSET_ID, '0xbbb', 300);

      expect(result.transfers.length).toBeGreaterThan(0);

      for (const { leaf, batchProof, topLevelProof } of result.transfers) {
        // Level 1: leaf → batch root
        const leafHash = transferToLeafHash(leaf);
        const batchWitness = batchProof.batchWitness.map((w) => ({
          isLeft: w.isLeft,
          sibling: Field(BigInt(w.sibling)),
        }));
        const batchValid = PoseidonMerkleTree.verifyWitness(
          leafHash,
          batchWitness,
          Field(BigInt(batchProof.batchRoot))
        );
        expect(batchValid).toBe(true);

        // Level 2: batch root → snapshot root
        const topWitness = topLevelProof.topWitness.map((w) => ({
          isLeft: w.isLeft,
          sibling: Field(BigInt(w.sibling)),
        }));
        const topValid = PoseidonMerkleTree.verifyWitness(
          Field(BigInt(batchProof.batchRoot)),
          topWitness,
          Field(BigInt(topLevelProof.snapshotRoot))
        );
        expect(topValid).toBe(true);

        // Snapshot root matches the query result
        expect(topLevelProof.snapshotRoot).toBe(result.snapshotRoot);
      }
    });
  });

  describe('getBatchLeafProof', () => {
    it('returns proof for a specific leaf', () => {
      builder.buildBatch([
        makeTransfer(100, 0, '0xaaa', '0xbbb'),
        makeTransfer(100, 1, '0xaaa', '0xccc'),
      ]);

      const proof = query.getBatchLeafProof(1, 0);

      expect(proof).not.toBeNull();
      expect(proof!.batchId).toBe(1);
      expect(proof!.leafIndex).toBe(0);
      expect(proof!.leaf.logIndex).toBe(0);

      // Verify proof
      const leafHash = transferToLeafHash(proof!.leaf);
      const witness = proof!.batchWitness.map((w) => ({
        isLeft: w.isLeft,
        sibling: Field(BigInt(w.sibling)),
      }));
      const valid = PoseidonMerkleTree.verifyWitness(
        leafHash,
        witness,
        Field(BigInt(proof!.batchRoot))
      );
      expect(valid).toBe(true);
    });

    it('returns null for non-existent batch', () => {
      const proof = query.getBatchLeafProof(999, 0);
      expect(proof).toBeNull();
    });
  });
});
