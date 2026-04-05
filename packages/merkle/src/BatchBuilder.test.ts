import { Field, Poseidon } from 'o1js';
import { MerkleDb } from './MerkleDb';
import { BatchBuilder, resolveIndexerFetchPageSize } from './BatchBuilder';
import { PoseidonMerkleTree } from './PoseidonMerkleTree';
import { TransferLeaf } from './types';
import { transferToLeafHash } from './adapters/evm';

const TEST_ASSET_ID = 1;

function makeTransfer(blockNumber: number, logIndex: number, from = '0xaaa', to = '0xbbb'): TransferLeaf {
  return {
    from: from.toLowerCase(),
    to: to.toLowerCase(),
    value: '1000',
    txHash: `0x${'0'.repeat(62)}${blockNumber.toString(16).padStart(2, '0')}`,
    logIndex,
    blockNumber,
  };
}

describe('resolveIndexerFetchPageSize', () => {
  it('auto mode caps large batch sizes at 2000', () => {
    expect(resolveIndexerFetchPageSize(10_000)).toBe(2_000);
  });

  it('auto mode uses batch size when below cap', () => {
    expect(resolveIndexerFetchPageSize(800)).toBe(800);
  });

  it('auto mode floors small batch sizes', () => {
    expect(resolveIndexerFetchPageSize(5)).toBe(500);
  });

  it('respects explicit page size when valid', () => {
    expect(resolveIndexerFetchPageSize(10_000, 3_000)).toBe(3_000);
  });
});

describe('BatchBuilder', () => {
  let db: MerkleDb;
  let builder: BatchBuilder;

  beforeEach(() => {
    db = new MerkleDb(':memory:');
    builder = new BatchBuilder(db, TEST_ASSET_ID, 5); // small batch size for tests
  });

  afterEach(() => {
    db.close();
  });

  describe('MerkleDb.clearAll', () => {
    it('removes all batches for every asset', () => {
      builder.buildBatch([makeTransfer(100, 0)]);
      expect(db.getBatchCount(TEST_ASSET_ID)).toBe(1);
      db.clearAll();
      expect(db.getBatchCount(TEST_ASSET_ID)).toBe(0);
    });
  });

  describe('buildBatch', () => {
    it('builds a batch and persists to DB', () => {
      const transfers = [
        makeTransfer(100, 0, '0xaaa', '0xbbb'),
        makeTransfer(100, 1, '0xbbb', '0xccc'),
        makeTransfer(101, 0, '0xaaa', '0xccc'),
      ];

      const { batchId, root } = builder.buildBatch(transfers);

      expect(batchId).toBe(1);
      expect(root).toBeTruthy();

      // Verify batch is in DB
      const batch = db.getBatch(batchId);
      expect(batch).not.toBeNull();
      expect(batch!.assetId).toBe(TEST_ASSET_ID);
      expect(batch!.leafCount).toBe(3);
      expect(batch!.root).toBe(root);
      expect(batch!.firstBlock).toBe(100);
      expect(batch!.lastBlock).toBe(101);
    });

    it('persists leaves to DB', () => {
      const transfers = [
        makeTransfer(100, 0),
        makeTransfer(100, 1),
      ];

      const { batchId } = builder.buildBatch(transfers);

      const leaves = db.getBatchLeaves(batchId, [0, 1]);
      expect(leaves.length).toBe(2);
      expect(leaves[0].leaf.blockNumber).toBe(100);
      expect(leaves[0].leaf.logIndex).toBe(0);
      expect(leaves[1].leaf.logIndex).toBe(1);
    });

    it('persists wallet index for both from and to', () => {
      const transfers = [
        makeTransfer(100, 0, '0xaaa', '0xbbb'),
        makeTransfer(100, 1, '0xbbb', '0xccc'),
      ];

      const { batchId } = builder.buildBatch(transfers);

      // 0xaaa sent transfer 0
      const aaaBatches = db.getWalletBatches(TEST_ASSET_ID, '0xaaa');
      expect(aaaBatches.length).toBe(1);
      expect(aaaBatches[0].batchId).toBe(batchId);
      expect(aaaBatches[0].leafIndices).toContain(0);

      // 0xbbb received transfer 0, sent transfer 1
      const bbbBatches = db.getWalletBatches(TEST_ASSET_ID, '0xbbb');
      expect(bbbBatches.length).toBe(1);
      expect(bbbBatches[0].leafIndices).toEqual(expect.arrayContaining([0, 1]));

      // 0xccc received transfer 1
      const cccBatches = db.getWalletBatches(TEST_ASSET_ID, '0xccc');
      expect(cccBatches.length).toBe(1);
      expect(cccBatches[0].leafIndices).toContain(1);
    });

    it('root matches manual tree construction', () => {
      const transfers = [makeTransfer(100, 0), makeTransfer(100, 1)];
      const { root } = builder.buildBatch(transfers);

      // Manually hash and build
      const hashes = transfers.map(transferToLeafHash);
      const manualTree = PoseidonMerkleTree.fromLeaves(hashes);

      expect(root).toBe(manualTree.getRoot().toString());
    });
  });

  describe('buildTopLevelTree', () => {
    it('builds a top-level tree from batch roots', () => {
      builder.buildBatch([makeTransfer(100, 0), makeTransfer(100, 1)]);
      builder.buildBatch([makeTransfer(200, 0), makeTransfer(200, 1)]);

      const { root, batchCount } = builder.buildTopLevelTree();

      expect(batchCount).toBe(2);
      expect(root).toBeTruthy();

      // Verify snapshot persisted
      const snapshot = db.getLatestSnapshot(TEST_ASSET_ID);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.assetId).toBe(TEST_ASSET_ID);
      expect(snapshot!.root).toBe(root);
      expect(snapshot!.batchCount).toBe(2);
    });

    it('snapshot root matches manual construction', () => {
      builder.buildBatch([makeTransfer(100, 0)]);
      builder.buildBatch([makeTransfer(200, 0)]);

      const batchRoots = db.getAllBatchRoots(TEST_ASSET_ID);
      const rootFields = batchRoots.map((b) => Field(BigInt(b.root)));
      const manualTree = PoseidonMerkleTree.fromLeaves(rootFields, 8);

      const { root } = builder.buildTopLevelTree();
      expect(root).toBe(manualTree.getRoot().toString());
    });

    it('throws when no batches exist', () => {
      expect(() => builder.buildTopLevelTree()).toThrow('No batches');
    });
  });

  describe('incremental build', () => {
    it('builds batches incrementally', () => {
      // First round
      builder.buildBatch([makeTransfer(100, 0), makeTransfer(100, 1)]);
      builder.buildTopLevelTree();

      const snapshot1 = db.getLatestSnapshot(TEST_ASSET_ID);

      // Second round
      builder.buildBatch([makeTransfer(200, 0), makeTransfer(200, 1)]);
      builder.buildTopLevelTree();

      const snapshot2 = db.getLatestSnapshot(TEST_ASSET_ID);

      expect(snapshot1!.batchCount).toBe(1);
      expect(snapshot2!.batchCount).toBe(2);
      expect(snapshot1!.root).not.toBe(snapshot2!.root);
    });
  });

  describe('asset isolation', () => {
    it('different assets have separate trees', () => {
      const builder2 = new BatchBuilder(db, 2, 5);

      builder.buildBatch([makeTransfer(100, 0)]);
      builder.buildTopLevelTree();

      builder2.buildBatch([makeTransfer(200, 0)]);
      builder2.buildTopLevelTree();

      const snapshot1 = db.getLatestSnapshot(TEST_ASSET_ID);
      const snapshot2 = db.getLatestSnapshot(2);

      expect(snapshot1!.root).not.toBe(snapshot2!.root);
      expect(db.getBatchCount(TEST_ASSET_ID)).toBe(1);
      expect(db.getBatchCount(2)).toBe(1);
    });
  });
});
