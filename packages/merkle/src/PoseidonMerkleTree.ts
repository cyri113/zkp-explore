import { Field, Poseidon } from 'o1js';

const EMPTY = Field(0);

/**
 * Custom bottom-up Poseidon merkle tree stored as a binary heap.
 *
 * Node layout: index 1 = root, children of i are 2i and 2i+1.
 * Leaves start at index 2^(height-1).
 *
 * Internal node hash: Poseidon.hash([left, right]) — identical to o1js MerkleTree.
 * Empty leaves: Field(0) — identical to o1js MerkleTree.
 */
export class PoseidonMerkleTree {
  /** All nodes in binary-heap order. Index 0 is unused. */
  readonly nodes: Field[];
  readonly height: number;
  /** Number of leaf slots: 2^(height-1) */
  readonly capacity: number;

  private constructor(height: number, nodes: Field[]) {
    this.height = height;
    this.capacity = 1 << (height - 1);
    this.nodes = nodes;
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  /** Create an empty tree of given height. */
  static empty(height: number): PoseidonMerkleTree {
    const size = 1 << height; // 2^height
    const nodes = new Array<Field>(size).fill(EMPTY);
    // Build internal nodes bottom-up
    for (let i = (1 << (height - 1)) - 1; i >= 1; i--) {
      nodes[i] = Poseidon.hash([nodes[2 * i], nodes[2 * i + 1]]);
    }
    return new PoseidonMerkleTree(height, nodes);
  }

  /**
   * Build a tree from leaf hashes (bottom-up, ~N Poseidon hashes for N leaves).
   * Height is auto-calculated to fit all leaves.
   */
  static fromLeaves(leafHashes: Field[], minHeight?: number): PoseidonMerkleTree {
    const leafCount = leafHashes.length;
    let height = Math.max(
      minHeight ?? 2,
      Math.ceil(Math.log2(Math.max(leafCount, 2))) + 1
    );

    const size = 1 << height;
    const leafStart = 1 << (height - 1);
    const nodes = new Array<Field>(size).fill(EMPTY);

    // Copy leaves into leaf positions
    for (let i = 0; i < leafCount; i++) {
      nodes[leafStart + i] = leafHashes[i];
    }

    // Build internal nodes bottom-up
    for (let i = leafStart - 1; i >= 1; i--) {
      nodes[i] = Poseidon.hash([nodes[2 * i], nodes[2 * i + 1]]);
    }

    return new PoseidonMerkleTree(height, nodes);
  }

  /** Instant deserialization — no rehashing. */
  static fromNodes(height: number, nodes: Field[]): PoseidonMerkleTree {
    return new PoseidonMerkleTree(height, nodes);
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  getRoot(): Field {
    return this.nodes[1];
  }

  getLeaf(index: number): Field {
    const leafStart = 1 << (this.height - 1);
    if (index < 0 || index >= this.capacity) {
      throw new Error(`Leaf index ${index} out of bounds [0, ${this.capacity})`);
    }
    return this.nodes[leafStart + index];
  }

  // ---------------------------------------------------------------------------
  // Witness / Proof generation
  // ---------------------------------------------------------------------------

  /**
   * Returns the authentication path from leaf to root.
   * Format matches o1js MerkleWitness: array of { isLeft, sibling } from
   * leaf level upward.
   */
  getWitness(leafIndex: number): Array<{ isLeft: boolean; sibling: Field }> {
    if (leafIndex < 0 || leafIndex >= this.capacity) {
      throw new Error(`Leaf index ${leafIndex} out of bounds [0, ${this.capacity})`);
    }

    const path: Array<{ isLeft: boolean; sibling: Field }> = [];
    let nodeIndex = (1 << (this.height - 1)) + leafIndex;

    for (let level = 0; level < this.height - 1; level++) {
      const isLeft = nodeIndex % 2 === 0;
      const siblingIndex = isLeft ? nodeIndex + 1 : nodeIndex - 1;
      path.push({ isLeft, sibling: this.nodes[siblingIndex] });
      nodeIndex = Math.floor(nodeIndex / 2);
    }

    return path;
  }

  /**
   * Verify a leaf hash against the tree root using a witness.
   */
  static verifyWitness(
    leafHash: Field,
    witness: Array<{ isLeft: boolean; sibling: Field }>,
    expectedRoot: Field
  ): boolean {
    let current = leafHash;
    for (const { isLeft, sibling } of witness) {
      current = isLeft
        ? Poseidon.hash([current, sibling])
        : Poseidon.hash([sibling, current]);
    }
    return current.equals(expectedRoot).toBoolean();
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  toJSON(): { height: number; nodes: string[] } {
    return {
      height: this.height,
      nodes: this.nodes.map((f) => f.toString()),
    };
  }

  static fromJSON(data: { height: number; nodes: string[] }): PoseidonMerkleTree {
    const nodes = data.nodes.map((s) => Field(BigInt(s)));
    return new PoseidonMerkleTree(data.height, nodes);
  }
}
