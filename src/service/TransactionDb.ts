import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'transactions.db');

export type RawTransaction = Record<string, unknown>;

export class TransactionDb {
  private db: Database.Database;

  constructor(dbPath = DB_PATH) {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initializeSchema();
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
      INSERT OR IGNORE INTO raw_transactions (hash, asset_id, data)
      VALUES (?, ?, ?)
    `);

    const insert = this.db.transaction((txs: RawTransaction[]) => {
      let count = 0;
      for (const tx of txs) {
        const hash = tx[hashKey];
        if (!hash) continue;

        const result = insertStmt.run(
          String(hash),
          assetId ?? null,
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

  getTransactionCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM raw_transactions`)
      .get() as { count: number };

    return row.count;
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
