import { Field } from 'o1js';
import { MerkleDb } from './MerkleDb';
import { PoseidonMerkleTree } from './PoseidonMerkleTree';
import { WalletTransferResult, BatchProof, TopLevelProof } from './types';
import { normalizeEvmAddress, transferToLeafHash } from './adapters/evm';

/**
 * Simple LRU cache using Map insertion order.
 * On access: delete + re-insert moves entry to end.
 * Evict from front when capacity exceeded.
 */
class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key); // Remove if exists (for re-ordering)
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      // Evict oldest (first key)
      const firstKey = this.map.keys().next().value!;
      this.map.delete(firstKey);
    }
  }
}

function serializeWitness(
  witness: Array<{ isLeft: boolean; sibling: Field }>
): Array<{ isLeft: boolean; sibling: string }> {
  return witness.map(({ isLeft, sibling }) => ({
    isLeft,
    sibling: sibling.toString(),
  }));
}

export class QueryService {
  private batchCache: LRUCache<number, PoseidonMerkleTree>;

  constructor(
    private db: MerkleDb,
    cacheSize = 20
  ) {
    this.batchCache = new LRUCache(cacheSize);
  }

  /**
   * Get all transfers for a wallet in a specific asset at or before a given block number,
   * with two-level merkle proofs (leaf→batch root, batch root→snapshot root).
   */
  getWalletTransfersAtBlock(
    assetId: number,
    wallet: string,
    blockNumber: number,
    limit?: number
  ): WalletTransferResult {
    const normalizedWallet = normalizeEvmAddress(wallet);

    // 1. Prefer a snapshot whose committed tip is at or before the query block (historical view).
    // If none exist (only newer snapshots, e.g. chain moved on), use the latest snapshot and
    // filter leaves by block below — proofs still verify against the current published root.
    let snapshot = this.db.getSnapshotAtBlock(assetId, blockNumber);
    if (!snapshot) {
      snapshot = this.db.getLatestSnapshot(assetId);
    }
    if (!snapshot) {
      return {
        wallet: normalizedWallet,
        blockNumber,
        snapshotRoot: '',
        batchCount: 0,
        transfers: [],
      };
    }

    // 2. Deserialize top-level tree
    const topLevelTree = PoseidonMerkleTree.fromJSON(JSON.parse(snapshot.treeNodes));

    // 3. Get all batches for this asset containing this wallet
    const walletBatches = this.db.getWalletBatches(assetId, normalizedWallet);

    // 4. Filter to batches included in this snapshot
    // We need to map batch IDs to their position in the asset's batch list
    const assetBatchRoots = this.db.getAllBatchRoots(assetId);
    const batchIdToIndex = new Map<number, number>();
    for (let i = 0; i < assetBatchRoots.length; i++) {
      batchIdToIndex.set(assetBatchRoots[i].id, i);
    }

    const relevantBatches = walletBatches.filter((wb) => {
      const idx = batchIdToIndex.get(wb.batchId);
      return idx !== undefined && idx < snapshot.batchCount;
    });

    // 5. For each relevant batch, generate proofs
    const transfers: WalletTransferResult['transfers'] = [];

    const maxTransfers = limit != null && limit > 0 ? limit : undefined;

    batchLoop: for (const { batchId, leafIndices } of relevantBatches) {
      // Load batch tree (from cache or DB)
      const batchTree = this.loadBatchTree(batchId);
      if (!batchTree) continue;

      // Load leaf data
      const leafData = this.db.getBatchLeaves(batchId, leafIndices);

      const topLeafIndex = batchIdToIndex.get(batchId)!;

      for (const { leafIndex, leaf, leafHash } of leafData) {
        if (leaf.blockNumber > blockNumber) {
          continue;
        }

        if (maxTransfers != null && transfers.length >= maxTransfers) {
          break batchLoop;
        }

        // Batch-level proof: leaf → batch root
        const batchWitness = batchTree.getWitness(leafIndex);
        const batchRoot = batchTree.getRoot().toString();

        const batchProof: BatchProof = {
          batchId,
          leafIndex,
          leaf,
          leafHash,
          batchWitness: serializeWitness(batchWitness),
          batchRoot,
        };

        // Top-level proof: batch root → snapshot root
        const topWitness = topLevelTree.getWitness(topLeafIndex);

        const topLevelProof: TopLevelProof = {
          batchIndex: topLeafIndex,
          topWitness: serializeWitness(topWitness),
          snapshotRoot: snapshot.root,
        };

        transfers.push({ leaf, batchProof, topLevelProof });
      }
    }

    const truncated = maxTransfers != null && transfers.length >= maxTransfers;

    return {
      wallet: normalizedWallet,
      blockNumber,
      snapshotRoot: snapshot.root,
      batchCount: snapshot.batchCount,
      transfers,
      ...(maxTransfers != null ? { limit: maxTransfers, ...(truncated ? { truncated: true } : {}) } : {}),
    };
  }

  /**
   * Get a single leaf proof (batch-level only).
   */
  getBatchLeafProof(
    batchId: number,
    leafIndex: number
  ): BatchProof | null {
    const batchTree = this.loadBatchTree(batchId);
    if (!batchTree) return null;

    const leafData = this.db.getBatchLeaves(batchId, [leafIndex]);
    if (leafData.length === 0) return null;

    const { leaf, leafHash } = leafData[0];
    const batchWitness = batchTree.getWitness(leafIndex);

    return {
      batchId,
      leafIndex,
      leaf,
      leafHash,
      batchWitness: serializeWitness(batchWitness),
      batchRoot: batchTree.getRoot().toString(),
    };
  }

  private loadBatchTree(batchId: number): PoseidonMerkleTree | null {
    // Check cache first
    let tree = this.batchCache.get(batchId);
    if (tree) return tree;

    // Load from DB
    const batch = this.db.getBatch(batchId);
    if (!batch) return null;

    tree = PoseidonMerkleTree.fromJSON(JSON.parse(batch.treeNodes));
    this.batchCache.set(batchId, tree);
    return tree;
  }
}
