import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'merkle.db');

export class MerkleDb {
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
      CREATE TABLE IF NOT EXISTS trees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        leaf_count INTEGER NOT NULL,
        root TEXT NOT NULL,
        first_timestamp INTEGER,
        last_timestamp INTEGER,
        tree_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  saveTree(leafCount: number, root: string, firstTimestamp: number, lastTimestamp: number, treeJson: string): number {
    const result = this.db
      .prepare(`
        INSERT INTO trees (leaf_count, root, first_timestamp, last_timestamp, tree_json)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(leafCount, root, firstTimestamp, lastTimestamp, treeJson);
    return Number(result.lastInsertRowid);
  }

  getLatestTree(): { id: number; leafCount: number; root: string; firstTimestamp: number; lastTimestamp: number; treeJson: string } | null {
    const row = this.db
      .prepare(`SELECT id, leaf_count, root, first_timestamp, last_timestamp, tree_json FROM trees ORDER BY id DESC LIMIT 1`)
      .get() as { id: number; leaf_count: number; root: string; first_timestamp: number; last_timestamp: number; tree_json: string } | undefined;

    if (!row) return null;
    return {
      id: row.id,
      leafCount: row.leaf_count,
      root: row.root,
      firstTimestamp: row.first_timestamp,
      lastTimestamp: row.last_timestamp,
      treeJson: row.tree_json,
    };
  }

  close(): void {
    this.db.close();
  }
}
