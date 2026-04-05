import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'indexer.db');

export type RawTransaction = Record<string, unknown>;

export class IndexerDb {
  private db: Database.Database;

  constructor(dbPath = DB_PATH) {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.registerFunctions();
    this.initializeSchema();
  }

  private registerFunctions() {
    this.db.function('hex_to_int', (hex: string) => Number(BigInt(hex)));
    this.db.function('extract_log_index', (uniqueId: string) => {
      const parts = uniqueId.split(':');
      return Number(parts[parts.length - 1]);
    });
  }

  private initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS networks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        network_id INTEGER NOT NULL REFERENCES networks(id),
        address TEXT NOT NULL,
        UNIQUE(network_id, address)
      );

      CREATE TABLE IF NOT EXISTS raw_transactions (
        hash TEXT NOT NULL PRIMARY KEY,
        asset_id INTEGER REFERENCES assets(id),
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        asset_id INTEGER NOT NULL PRIMARY KEY REFERENCES assets(id),
        last_block INTEGER,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    this.migrateAddSortColumns();
  }

  private migrateAddSortColumns() {
    // Add columns if they don't exist (idempotent migration for existing DBs)
    const columns = this.db
      .prepare(`PRAGMA table_info(raw_transactions)`)
      .all() as Array<{ name: string }>;
    const colNames = new Set(columns.map((c) => c.name));

    if (!colNames.has('block_number')) {
      console.error('[DB] Migrating: adding block_number and log_index columns...');
      this.db.exec(`ALTER TABLE raw_transactions ADD COLUMN block_number INTEGER`);
      this.db.exec(`ALTER TABLE raw_transactions ADD COLUMN log_index INTEGER`);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_raw_tx_order
          ON raw_transactions (block_number, log_index)
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_raw_tx_asset_order
          ON raw_transactions (asset_id, block_number, log_index)
      `);
    }

    // Backfill any rows missing sort columns
    const needsBackfill = this.db
      .prepare(`SELECT COUNT(*) as count FROM raw_transactions WHERE block_number IS NULL`)
      .get() as { count: number };

    if (needsBackfill.count > 0) {
      console.error(`[DB] Backfilling ${needsBackfill.count.toLocaleString()} rows with sort columns...`);
      this.db.exec(`
        UPDATE raw_transactions
        SET block_number = hex_to_int(json_extract(data, '$.blockNum')),
            log_index = extract_log_index(json_extract(data, '$.uniqueId'))
        WHERE block_number IS NULL
      `);
      console.error(`[DB] Backfill complete.`);
    }
  }

  getOrCreateNetwork(name: string): number {
    const existing = this.db
      .prepare(`SELECT id FROM networks WHERE name = ?`)
      .get(name) as { id: number } | undefined;
    if (existing) return existing.id;

    const result = this.db
      .prepare(`INSERT INTO networks (name) VALUES (?)`)
      .run(name);
    return Number(result.lastInsertRowid);
  }

  getOrCreateAsset(networkId: number, address: string): number {
    const existing = this.db
      .prepare(`SELECT id FROM assets WHERE network_id = ? AND address = ?`)
      .get(networkId, address) as { id: number } | undefined;
    if (existing) return existing.id;

    const result = this.db
      .prepare(`INSERT INTO assets (network_id, address) VALUES (?, ?)`)
      .run(networkId, address);
    return Number(result.lastInsertRowid);
  }

  insertTransactions(transactions: RawTransaction[], hashKey = 'hash', assetId?: number): number {
    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO raw_transactions (hash, asset_id, block_number, log_index, data)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insert = this.db.transaction((txs: RawTransaction[]) => {
      let count = 0;
      for (const tx of txs) {
        const hash = tx[hashKey];
        if (!hash) continue;

        const blockNum = tx.blockNum as string | undefined;
        const blockNumber = blockNum ? Number(BigInt(blockNum)) : null;

        const uniqueId = tx.uniqueId as string | undefined;
        let logIndex: number | null = null;
        if (uniqueId) {
          const parts = uniqueId.split(':');
          logIndex = Number(parts[parts.length - 1]);
        }

        const result = insertStmt.run(
          String(hash),
          assetId ?? null,
          blockNumber,
          logIndex,
          JSON.stringify(tx)
        );
        if ((result.changes ?? 0) > 0) {
          count++;
        }
      }
      return count;
    });

    return insert(transactions);
  }

  getTransactions(): RawTransaction[] {
    const rows = this.db
      .prepare(`SELECT data FROM raw_transactions`)
      .all() as Array<{ data: string }>;

    return rows.map((row) => JSON.parse(row.data));
  }

  *iterateTransactionsOrdered(pageSize = 50_000): IterableIterator<RawTransaction> {
    const stmt = this.db.prepare(`
      SELECT block_number, log_index, data FROM raw_transactions
      WHERE block_number > ? OR (block_number = ? AND log_index > ?)
      ORDER BY block_number, log_index
      LIMIT ?
    `);

    let lastBlock = -1;
    let lastLog = -1;

    while (true) {
      const rows = stmt.all(lastBlock, lastBlock, lastLog, pageSize) as Array<{
        block_number: number;
        log_index: number;
        data: string;
      }>;

      if (rows.length === 0) break;

      for (const row of rows) {
        lastBlock = row.block_number;
        lastLog = row.log_index;
        yield JSON.parse(row.data);
      }
    }
  }

  getTransactionPage(pageSize: number, afterBlock = -1, afterLog = -1, assetId?: number): {
    transactions: RawTransaction[];
    lastBlock: number;
    lastLog: number;
  } {
    const hasAsset = assetId != null;
    const rows = this.db
      .prepare(
        hasAsset
          ? `SELECT block_number, log_index, data FROM raw_transactions
             WHERE asset_id = ? AND (block_number > ? OR (block_number = ? AND log_index > ?))
             ORDER BY block_number, log_index
             LIMIT ?`
          : `SELECT block_number, log_index, data FROM raw_transactions
             WHERE (block_number > ? OR (block_number = ? AND log_index > ?))
             ORDER BY block_number, log_index
             LIMIT ?`
      )
      .all(...(hasAsset
        ? [assetId, afterBlock, afterBlock, afterLog, pageSize]
        : [afterBlock, afterBlock, afterLog, pageSize]
      )) as Array<{
        block_number: number;
        log_index: number;
        data: string;
      }>;

    let lastBlockOut = afterBlock;
    let lastLogOut = afterLog;
    const transactions = rows.map((row) => {
      lastBlockOut = row.block_number;
      lastLogOut = row.log_index;
      return JSON.parse(row.data);
    });

    return { transactions, lastBlock: lastBlockOut, lastLog: lastLogOut };
  }

  getTransactionCount(assetId?: number): number {
    const row = assetId != null
      ? this.db
        .prepare('SELECT COUNT(*) as count FROM raw_transactions WHERE asset_id = ?')
        .get(assetId) as { count: number }
      : this.db
        .prepare('SELECT COUNT(*) as count FROM raw_transactions')
        .get() as { count: number };

    return row.count;
  }

  getAssets(): Array<{ id: number; networkId: number; network: string; address: string }> {
    return this.db
      .prepare(`
        SELECT a.id, a.network_id, n.name as network, a.address
        FROM assets a
        JOIN networks n ON n.id = a.network_id
        ORDER BY a.id
      `)
      .all() as Array<{ id: number; networkId: number; network: string; address: string }>;
  }

  getAssetByAddress(address: string): { id: number; networkId: number; address: string } | null {
    const row = this.db
      .prepare('SELECT id, network_id, address FROM assets WHERE LOWER(address) = LOWER(?)')
      .get(address) as { id: number; network_id: number; address: string } | undefined;
    return row ? { id: row.id, networkId: row.network_id, address: row.address } : null;
  }

  getResumeBlock(assetId: number): number | null {
    const row = this.db
      .prepare(`SELECT last_block FROM checkpoints WHERE asset_id = ?`)
      .get(assetId) as { last_block: number | null } | undefined;

    return row?.last_block ?? null;
  }

  saveCheckpoint(assetId: number, lastBlock: number): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO checkpoints (asset_id, last_block, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
      `)
      .run(assetId, lastBlock);
  }

  clearTransactions(): number {
    const result = this.db.prepare(`DELETE FROM raw_transactions`).run();
    return result.changes ?? 0;
  }

  clearCheckpoints(assetId: number): void {
    this.db.prepare(`DELETE FROM checkpoints WHERE asset_id = ?`).run(assetId);
  }

  close(): void {
    this.db.close();
  }
}
