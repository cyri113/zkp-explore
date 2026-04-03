import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'transactions.db');

export type RawTransaction = Record<string, unknown>;

export class TransactionDb {
  private db: Database.Database;

  constructor(dbPath = DB_PATH) {
    // Ensure data directory exists
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initializeSchema();
  }

  private initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS raw_transactions (
        hash TEXT NOT NULL,
        address TEXT NOT NULL,
        network TEXT NOT NULL,
        data TEXT NOT NULL,
        stored_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (hash, address, network)
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        address TEXT NOT NULL,
        network TEXT NOT NULL,
        direction TEXT NOT NULL,
        page_key TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (address, network, direction)
      );

      CREATE INDEX IF NOT EXISTS idx_address_network ON raw_transactions(address, network);
      CREATE INDEX IF NOT EXISTS idx_stored_at ON raw_transactions(stored_at);
      CREATE INDEX IF NOT EXISTS idx_checkpoint_lookup ON checkpoints(address, network, direction);
    `);
  }

  /**
   * Insert raw transactions. Duplicates are skipped.
   * Returns count of inserted transactions.
   */
  insertTransactions(address: string, network: string, transactions: RawTransaction[], hashKey = 'hash'): number {
    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO raw_transactions (hash, address, network, data)
      VALUES (?, ?, ?, ?)
    `);

    const insert = this.db.transaction((txs: RawTransaction[]) => {
      let count = 0;
      for (const tx of txs) {
        const hash = tx[hashKey];
        if (!hash) continue;

        const result = insertStmt.run(
          String(hash),
          address,
          network,
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

  /**
   * Get all stored transactions for a given address/network.
   */
  getTransactions(address: string, network: string): RawTransaction[] {
    const rows = this.db
      .prepare(
        `
      SELECT data FROM raw_transactions 
      WHERE address = ? AND network = ?
      ORDER BY stored_at ASC
    `
      )
      .all(address, network) as Array<{ data: string }>;

    return rows.map((row) => JSON.parse(row.data));
  }

  /**
   * Get count of transactions for a given address/network.
   */
  getTransactionCount(address: string, network: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM raw_transactions WHERE address = ? AND network = ?`)
      .get(address, network) as { count: number };

    return row.count;
  }

  /**
   * Clear all transactions for a given address/network (for reset).
   */
  clearTransactions(address: string, network: string): number {
    const result = this.db.prepare(`DELETE FROM raw_transactions WHERE address = ? AND network = ?`).run(address, network);
    return result.changes ?? 0;
  }

  /**
   * Clear entire database (full reset).
   */
  clearAllTransactions(): void {
    this.db.exec(`DELETE FROM raw_transactions`);
  }

  /**
   * Save a checkpoint (pagination token) for a direction.
   */
  saveCheckpoint(address: string, network: string, direction: string, pageKey: string | undefined): void {
    if (!pageKey) {
      // If no pageKey, remove the checkpoint (we've reached the end)
      this.db.prepare(`DELETE FROM checkpoints WHERE address = ? AND network = ? AND direction = ?`).run(
        address,
        network,
        direction
      );
    } else {
      this.db
        .prepare(
          `
        INSERT OR REPLACE INTO checkpoints (address, network, direction, page_key, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `
        )
        .run(address, network, direction, pageKey);
    }
  }

  /**
   * Get the saved checkpoint (pagination token) for a direction.
   * Returns undefined if no checkpoint exists.
   */
  getCheckpoint(address: string, network: string, direction: string): string | undefined {
    const row = this.db
      .prepare(`SELECT page_key FROM checkpoints WHERE address = ? AND network = ? AND direction = ?`)
      .get(address, network, direction) as { page_key: string } | undefined;

    return row?.page_key;
  }

  /**
   * Clear checkpoints for a specific address/network.
   */
  clearCheckpoints(address: string, network: string): void {
    this.db.prepare(`DELETE FROM checkpoints WHERE address = ? AND network = ?`).run(address, network);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
