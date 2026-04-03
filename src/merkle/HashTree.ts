import { Field, MerkleTree } from 'o1js';
import { LeafEntry, RootSnapshot } from './types';
import { hashLeaf } from './hash';

export class HashTree {
  private tree: MerkleTree;
  private snapshots: RootSnapshot[] = [];
  private idIndex: Map<string, bigint> = new Map();
  private leaves: LeafEntry[] = [];
  private lastSortKey = '';

  constructor(public readonly height: number) {
    this.tree = new MerkleTree(height);
  }

  addLeaf(entry: LeafEntry): RootSnapshot {
    if (entry.sortKey <= this.lastSortKey) {
      throw new Error('sortKey must be strictly increasing');
    }
    if (this.idIndex.has(entry.id)) {
      throw new Error(`Leaf id already exists: ${entry.id}`);
    }

    const leafIndex = this.leaves.length;
    const leafHash = hashLeaf(entry.fields);
    this.tree.setLeaf(BigInt(leafIndex), leafHash);

    this.leaves.push(entry);
    this.idIndex.set(entry.id, BigInt(leafIndex));
    this.lastSortKey = entry.sortKey;

    const snapshot: RootSnapshot = {
      root: this.getRoot().toString(),
      leafIndex,
      timestamp: entry.timestamp,
      sortKey: entry.sortKey,
    };

    this.snapshots.push(snapshot);
    return snapshot;
  }

  addLeaves(entries: LeafEntry[]): RootSnapshot[] {
    if (entries.length === 0) return [];

    const out: RootSnapshot[] = [];
    for (const entry of entries) {
      out.push(this.addLeaf(entry));
    }
    return out;
  }

  getRoot(): Field {
    return this.tree.getRoot();
  }

  getRootAt(timestamp: number): Field {
    if (this.snapshots.length === 0) {
      throw new Error('No snapshots available');
    }
    if (timestamp < this.snapshots[0].timestamp) {
      throw new Error('Timestamp before first insertion');
    }

    let left = 0;
    let right = this.snapshots.length - 1;
    let result = this.snapshots[0];

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const candidate = this.snapshots[mid];
      if (candidate.timestamp <= timestamp) {
        result = candidate;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    return Field(BigInt(result.root));
  }

  getWitness(leafIndex: bigint): any {
    const numericIndex = Number(leafIndex);
    if (numericIndex < 0 || numericIndex >= this.leaves.length) {
      throw new Error('Leaf index out of bounds');
    }
    return this.tree.getWitness(BigInt(numericIndex));
  }

  getLeafIndex(id: string): bigint | undefined {
    return this.idIndex.get(id);
  }

  getLeafCount(): bigint {
    return BigInt(this.leaves.length);
  }

  validate(leafIndex: bigint): boolean {
    return this.tree.validate(leafIndex);
  }

  getSnapshots(): RootSnapshot[] {
    return [...this.snapshots];
  }

  toJSON(): string {
    const serializableLeaves = this.leaves.map((leaf) => ({
      ...leaf,
      fields: leaf.fields.map((field) => field.toString()),
    }));

    return JSON.stringify({
      height: this.height,
      lastSortKey: this.lastSortKey,
      leaves: serializableLeaves,
      snapshots: this.snapshots,
    });
  }

  static fromJSON(json: string): HashTree {
    const parsed = JSON.parse(json) as {
      height: number;
      lastSortKey: string;
      leaves: Array<{ id: string; fields: string[]; timestamp: number; sortKey: string }>;
      snapshots: RootSnapshot[];
    };

    const tree = new HashTree(parsed.height);

    const entries: LeafEntry[] = parsed.leaves.map((entry) => ({
      id: entry.id,
      fields: entry.fields.map((f) => Field(BigInt(f))),
      timestamp: entry.timestamp,
      sortKey: entry.sortKey,
    }));

    tree.addLeaves(entries);

    // restore invariants from persisted snapshot metadata
    tree.snapshots = parsed.snapshots;
    tree.lastSortKey = parsed.lastSortKey;

    return tree;
  }
}
