import Database from 'better-sqlite3';

type Network = {
  id: number;
  name: string;
};

export function getOrCreateNetwork(db: Database.Database, name: string): number {
  const existing = db.prepare(`SELECT id FROM networks WHERE name = ?`)
    .get(name) as { id: number } | undefined;
  if (existing) return existing.id;

  const result = db
    .prepare(`INSERT INTO networks (name) VALUES (?)`)
    .run(name);
  return Number(result.lastInsertRowid);
}

export function getNetworkById(db: Database.Database, id: number): Network | null {
  const row = db.prepare(`SELECT id, name FROM networks WHERE id = ?`)
    .get(id) as Network | undefined;
  return row || null;
}

export function getNetworkByName(db: Database.Database, name: string): Network | null {
  const row = db.prepare(`SELECT id, name FROM networks WHERE name = ?`)
    .get(name) as Network | undefined;
  return row || null;
}

export function getNetworks(db: Database.Database): Network[] {
  const rows = db.prepare(`SELECT id, name FROM networks`).all() as Network[];
  return rows;
}