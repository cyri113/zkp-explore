import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { normalizeEvmAddress } from './adapters/evm';
import { TransferLeaf } from './types';

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'merkle.db');

export class MerkleDb {
  private db: Database.Database;

  constructor(dbPath = DB_PATH) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initializeSchema();
  }

  private initializeSchema() {
    this.db.exec(`
      -- Legacy table kept for backward compat with HashTree
      CREATE TABLE IF NOT EXISTS trees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        leaf_count INTEGER NOT NULL,
        root TEXT NOT NULL,
        first_timestamp INTEGER,
        last_timestamp INTEGER,
        tree_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL,
        leaf_count INTEGER NOT NULL,
        root TEXT NOT NULL,
        first_block INTEGER NOT NULL,
        last_block INTEGER NOT NULL,
        first_log_index INTEGER NOT NULL,
        last_log_index INTEGER NOT NULL,
        tree_height INTEGER NOT NULL,
        tree_nodes TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_batches_asset ON batches(asset_id);

      CREATE TABLE IF NOT EXISTS batch_leaves (
        batch_id INTEGER NOT NULL REFERENCES batches(id),
        leaf_index INTEGER NOT NULL,
        from_addr TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        value TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        leaf_hash TEXT NOT NULL,
        PRIMARY KEY (batch_id, leaf_index)
      );

      CREATE TABLE IF NOT EXISTS wallet_index (
        batch_id INTEGER NOT NULL REFERENCES batches(id),
        asset_id INTEGER NOT NULL,
        wallet_address TEXT NOT NULL,
        leaf_indices TEXT NOT NULL,
        PRIMARY KEY (batch_id, wallet_address)
      );

      CREATE INDEX IF NOT EXISTS idx_wallet_asset_address ON wallet_index(asset_id, wallet_address);

      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL,
        batch_count INTEGER NOT NULL,
        tree_height INTEGER NOT NULL,
        root TEXT NOT NULL,
        through_block INTEGER NOT NULL,
        through_log_index INTEGER NOT NULL,
        tree_nodes TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_asset_block ON snapshots(asset_id, through_block);
    `);
  }

  // ---------------------------------------------------------------------------
  // Batches
  // ---------------------------------------------------------------------------

  saveBatch(
    assetId: number,
    leafCount: number,
    root: string,
    firstBlock: number,
    lastBlock: number,
    firstLogIndex: number,
    lastLogIndex: number,
    treeHeight: number,
    treeNodes: string
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO batches
         (asset_id, leaf_count, root, first_block, last_block, first_log_index, last_log_index, tree_height, tree_nodes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(assetId, leafCount, root, firstBlock, lastBlock, firstLogIndex, lastLogIndex, treeHeight, treeNodes);
    return Number(result.lastInsertRowid);
  }

  saveBatchLeaves(
    batchId: number,
    leaves: Array<{ leaf: TransferLeaf; leafHash: string; leafIndex: number }>
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO batch_leaves
       (batch_id, leaf_index, from_addr, to_addr, value, tx_hash, log_index, block_number, leaf_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const insertAll = this.db.transaction((items: typeof leaves) => {
      for (const item of items) {
        insert.run(
          batchId,
          item.leafIndex,
          item.leaf.from,
          item.leaf.to,
          item.leaf.value,
          item.leaf.txHash,
          item.leaf.logIndex,
          item.leaf.blockNumber,
          item.leafHash
        );
      }
    });

    insertAll(leaves);
  }

  saveWalletIndices(batchId: number, assetId: number, walletMap: Map<string, number[]>): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO wallet_index (batch_id, asset_id, wallet_address, leaf_indices) VALUES (?, ?, ?, ?)`
    );

    const insertAll = this.db.transaction((entries: [string, number[]][]) => {
      for (const [wallet, indices] of entries) {
        insert.run(batchId, assetId, normalizeEvmAddress(wallet), JSON.stringify(indices));
      }
    });

    insertAll([...walletMap.entries()]);
  }

  getBatch(id: number): {
    id: number;
    assetId: number;
    leafCount: number;
    root: string;
    firstBlock: number;
    lastBlock: number;
    firstLogIndex: number;
    lastLogIndex: number;
    treeHeight: number;
    treeNodes: string;
  } | null {
    const row = this.db
      .prepare('SELECT * FROM batches WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as number,
      assetId: row.asset_id as number,
      leafCount: row.leaf_count as number,
      root: row.root as string,
      firstBlock: row.first_block as number,
      lastBlock: row.last_block as number,
      firstLogIndex: row.first_log_index as number,
      lastLogIndex: row.last_log_index as number,
      treeHeight: row.tree_height as number,
      treeNodes: row.tree_nodes as string,
    };
  }

  getLastBatch(assetId: number): {
    id: number;
    lastBlock: number;
    lastLogIndex: number;
  } | null {
    const row = this.db
      .prepare('SELECT id, last_block, last_log_index FROM batches WHERE asset_id = ? ORDER BY id DESC LIMIT 1')
      .get(assetId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as number,
      lastBlock: row.last_block as number,
      lastLogIndex: row.last_log_index as number,
    };
  }

  /**
   * If the latest batch for this asset has fewer than `batchSize` leaves, remove it so the next
   * indexer run can rebuild a full tail and merge new txs into that segment. Drops snapshots that
   * were built including that partial batch (`batch_count >=` batch count before delete); older
   * snapshots (smaller batch_count) are kept.
   *
   * Returns a cursor for GET /transactions: first row is (first_block, first_log_index), so use
   * after_block = first_block, after_log = first_log_index - 1 (e.g. -1 when log is 0).
   */
  tryRewindPartialTailBatch(
    assetId: number,
    batchSize: number
  ): { resumeAfterBlock: number; resumeAfterLog: number } | null {
    const row = this.db
      .prepare(
        `SELECT id, leaf_count, first_block, first_log_index FROM batches
         WHERE asset_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(assetId) as
      | { id: number; leaf_count: number; first_block: number; first_log_index: number }
      | undefined;

    if (!row || row.leaf_count >= batchSize) {
      return null;
    }

    const batchId = row.id;
    const batchCountBefore = this.getBatchCount(assetId);
    const resumeAfterBlock = row.first_block;
    const resumeAfterLog = row.first_log_index - 1;

    this.db.transaction(() => {
      this.db.prepare('DELETE FROM batch_leaves WHERE batch_id = ?').run(batchId);
      this.db.prepare('DELETE FROM wallet_index WHERE batch_id = ?').run(batchId);
      this.db.prepare('DELETE FROM batches WHERE id = ?').run(batchId);
      this.db
        .prepare('DELETE FROM snapshots WHERE asset_id = ? AND batch_count >= ?')
        .run(assetId, batchCountBefore);
    })();

    return { resumeAfterBlock, resumeAfterLog };
  }

  getBatchCount(assetId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM batches WHERE asset_id = ?')
      .get(assetId) as { count: number };
    return row.count;
  }

  getAllBatchRoots(assetId: number): Array<{ id: number; root: string }> {
    return this.db
      .prepare('SELECT id, root FROM batches WHERE asset_id = ? ORDER BY id')
      .all(assetId) as Array<{ id: number; root: string }>;
  }

  getBatchLeaves(
    batchId: number,
    leafIndices: number[]
  ): Array<{ leafIndex: number; leaf: TransferLeaf; leafHash: string }> {
    if (leafIndices.length === 0) return [];

    const placeholders = leafIndices.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT leaf_index, from_addr, to_addr, value, tx_hash, log_index, block_number, leaf_hash
         FROM batch_leaves
         WHERE batch_id = ? AND leaf_index IN (${placeholders})
         ORDER BY leaf_index`
      )
      .all(batchId, ...leafIndices) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      leafIndex: row.leaf_index as number,
      leaf: {
        from: row.from_addr as string,
        to: row.to_addr as string,
        value: row.value as string,
        txHash: row.tx_hash as string,
        logIndex: row.log_index as number,
        blockNumber: row.block_number as number,
      },
      leafHash: row.leaf_hash as string,
    }));
  }

  // ---------------------------------------------------------------------------
  // Wallet index
  // ---------------------------------------------------------------------------

  getWalletBatches(
    assetId: number,
    wallet: string
  ): Array<{ batchId: number; leafIndices: number[] }> {
    const rows = this.db
      .prepare(
        'SELECT batch_id, leaf_indices FROM wallet_index WHERE asset_id = ? AND wallet_address = ? ORDER BY batch_id'
      )
      .all(assetId, normalizeEvmAddress(wallet)) as Array<{
      batch_id: number;
      leaf_indices: string;
    }>;

    return rows.map((row) => ({
      batchId: row.batch_id,
      leafIndices: JSON.parse(row.leaf_indices) as number[],
    }));
  }

  // ---------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------

  saveSnapshot(
    assetId: number,
    batchCount: number,
    treeHeight: number,
    root: string,
    throughBlock: number,
    throughLogIndex: number,
    treeNodes: string
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO snapshots
         (asset_id, batch_count, tree_height, root, through_block, through_log_index, tree_nodes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(assetId, batchCount, treeHeight, root, throughBlock, throughLogIndex, treeNodes);
    return Number(result.lastInsertRowid);
  }

  getSnapshotAtBlock(assetId: number, blockNumber: number): {
    id: number;
    assetId: number;
    batchCount: number;
    treeHeight: number;
    root: string;
    throughBlock: number;
    throughLogIndex: number;
    treeNodes: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT * FROM snapshots
         WHERE asset_id = ? AND through_block <= ?
         ORDER BY through_block DESC, id DESC
         LIMIT 1`
      )
      .get(assetId, blockNumber) as Record<string, unknown> | undefined;

    if (!row) return null;
    return {
      id: row.id as number,
      assetId: row.asset_id as number,
      batchCount: row.batch_count as number,
      treeHeight: row.tree_height as number,
      root: row.root as string,
      throughBlock: row.through_block as number,
      throughLogIndex: row.through_log_index as number,
      treeNodes: row.tree_nodes as string,
    };
  }

  getLatestSnapshot(assetId: number): {
    id: number;
    assetId: number;
    batchCount: number;
    treeHeight: number;
    root: string;
    throughBlock: number;
    throughLogIndex: number;
    treeNodes: string;
  } | null {
    const row = this.db
      .prepare('SELECT * FROM snapshots WHERE asset_id = ? ORDER BY id DESC LIMIT 1')
      .get(assetId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return {
      id: row.id as number,
      assetId: row.asset_id as number,
      batchCount: row.batch_count as number,
      treeHeight: row.tree_height as number,
      root: row.root as string,
      throughBlock: row.through_block as number,
      throughLogIndex: row.through_log_index as number,
      treeNodes: row.tree_nodes as string,
    };
  }

  // ---------------------------------------------------------------------------
  // Legacy (backward compat)
  // ---------------------------------------------------------------------------

  saveTree(
    leafCount: number,
    root: string,
    firstTimestamp: number,
    lastTimestamp: number,
    treeJson: string
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO trees (leaf_count, root, first_timestamp, last_timestamp, tree_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(leafCount, root, firstTimestamp, lastTimestamp, treeJson);
    return Number(result.lastInsertRowid);
  }

  getLatestTree(): {
    id: number;
    leafCount: number;
    root: string;
    firstTimestamp: number;
    lastTimestamp: number;
    treeJson: string;
  } | null {
    const row = this.db
      .prepare(
        'SELECT id, leaf_count, root, first_timestamp, last_timestamp, tree_json FROM trees ORDER BY id DESC LIMIT 1'
      )
      .get() as Record<string, unknown> | undefined;

    if (!row) return null;
    return {
      id: row.id as number,
      leafCount: row.leaf_count as number,
      root: row.root as string,
      firstTimestamp: row.first_timestamp as number,
      lastTimestamp: row.last_timestamp as number,
      treeJson: row.tree_json as string,
    };
  }

  /**
   * Delete all merkle state (every asset). Resets AUTOINCREMENT rowids for main tables.
   */
  clearAll(): void {
    this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM batch_leaves;
        DELETE FROM wallet_index;
        DELETE FROM batches;
        DELETE FROM snapshots;
        DELETE FROM trees;
      `);
      const hasSeq = this.db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'`)
        .get();
      if (hasSeq) {
        this.db.exec(`
          DELETE FROM sqlite_sequence WHERE name IN ('batches', 'snapshots', 'trees');
        `);
      }
    })();
  }

  close(): void {
    this.db.close();
  }
}
