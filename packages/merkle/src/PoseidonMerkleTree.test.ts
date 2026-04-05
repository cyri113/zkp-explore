import { Field, Poseidon, MerkleTree } from 'o1js';
import { PoseidonMerkleTree } from './PoseidonMerkleTree';

describe('PoseidonMerkleTree', () => {
  it('empty tree has deterministic root', () => {
    const t1 = PoseidonMerkleTree.empty(4);
    const t2 = PoseidonMerkleTree.empty(4);
    expect(t1.getRoot().toString()).toBe(t2.getRoot().toString());
  });

  it('single leaf produces correct root', () => {
    const leaf = Poseidon.hash([Field(42)]);
    const tree = PoseidonMerkleTree.fromLeaves([leaf]);
    expect(tree.getRoot().toString()).not.toBe(Field(0).toString());
    expect(tree.getLeaf(0).toString()).toBe(leaf.toString());
  });

  it('determinism: same leaves produce same root', () => {
    const leaves = [10, 20, 30, 40, 50].map((n) => Poseidon.hash([Field(n)]));
    const t1 = PoseidonMerkleTree.fromLeaves(leaves);
    const t2 = PoseidonMerkleTree.fromLeaves(leaves);
    expect(t1.getRoot().toString()).toBe(t2.getRoot().toString());
  });

  it('different leaves produce different roots', () => {
    const leavesA = [1, 2, 3].map((n) => Poseidon.hash([Field(n)]));
    const leavesB = [4, 5, 6].map((n) => Poseidon.hash([Field(n)]));
    const tA = PoseidonMerkleTree.fromLeaves(leavesA);
    const tB = PoseidonMerkleTree.fromLeaves(leavesB);
    expect(tA.getRoot().toString()).not.toBe(tB.getRoot().toString());
  });

  it('cross-verifies with o1js MerkleTree', () => {
    const leaves = [100, 200, 300, 400].map((n) => Poseidon.hash([Field(n)]));
    const height = Math.ceil(Math.log2(Math.max(leaves.length, 2))) + 1;

    // Build with our tree
    const custom = PoseidonMerkleTree.fromLeaves(leaves, height);

    // Build with o1js MerkleTree
    const o1tree = new MerkleTree(height);
    for (let i = 0; i < leaves.length; i++) {
      o1tree.setLeaf(BigInt(i), leaves[i]);
    }

    expect(custom.getRoot().toString()).toBe(o1tree.getRoot().toString());
  });

  it('cross-verifies with o1js for non-power-of-2 leaves', () => {
    const leaves = [1, 2, 3, 4, 5].map((n) => Poseidon.hash([Field(n)]));
    const height = Math.ceil(Math.log2(Math.max(leaves.length, 2))) + 1;

    const custom = PoseidonMerkleTree.fromLeaves(leaves, height);
    const o1tree = new MerkleTree(height);
    for (let i = 0; i < leaves.length; i++) {
      o1tree.setLeaf(BigInt(i), leaves[i]);
    }

    expect(custom.getRoot().toString()).toBe(o1tree.getRoot().toString());
  });

  it('witness verification works for all leaves', () => {
    const leaves = [10, 20, 30, 40, 50, 60, 70, 80].map((n) =>
      Poseidon.hash([Field(n)])
    );
    const tree = PoseidonMerkleTree.fromLeaves(leaves);

    for (let i = 0; i < leaves.length; i++) {
      const witness = tree.getWitness(i);
      const valid = PoseidonMerkleTree.verifyWitness(
        leaves[i],
        witness,
        tree.getRoot()
      );
      expect(valid).toBe(true);
    }
  });

  it('witness verification fails for wrong leaf', () => {
    const leaves = [1, 2, 3, 4].map((n) => Poseidon.hash([Field(n)]));
    const tree = PoseidonMerkleTree.fromLeaves(leaves);
    const witness = tree.getWitness(0);
    const wrongLeaf = Poseidon.hash([Field(999)]);
    const valid = PoseidonMerkleTree.verifyWitness(
      wrongLeaf,
      witness,
      tree.getRoot()
    );
    expect(valid).toBe(false);
  });

  it('getLeaf returns correct values', () => {
    const leaves = [11, 22, 33].map((n) => Poseidon.hash([Field(n)]));
    const tree = PoseidonMerkleTree.fromLeaves(leaves);

    for (let i = 0; i < leaves.length; i++) {
      expect(tree.getLeaf(i).toString()).toBe(leaves[i].toString());
    }
    // Empty slot
    expect(tree.getLeaf(3).toString()).toBe(Field(0).toString());
  });

  it('getLeaf throws for out-of-bounds', () => {
    const tree = PoseidonMerkleTree.fromLeaves([Field(1)]);
    expect(() => tree.getLeaf(-1)).toThrow('out of bounds');
    expect(() => tree.getLeaf(tree.capacity)).toThrow('out of bounds');
  });

  it('getWitness throws for out-of-bounds', () => {
    const tree = PoseidonMerkleTree.fromLeaves([Field(1)]);
    expect(() => tree.getWitness(-1)).toThrow('out of bounds');
    expect(() => tree.getWitness(tree.capacity)).toThrow('out of bounds');
  });

  it('JSON round-trip preserves root and witnesses', () => {
    const leaves = [5, 10, 15, 20, 25].map((n) => Poseidon.hash([Field(n)]));
    const tree = PoseidonMerkleTree.fromLeaves(leaves);
    const root = tree.getRoot().toString();
    const witness2 = tree.getWitness(2);

    const json = tree.toJSON();
    const restored = PoseidonMerkleTree.fromJSON(json);

    expect(restored.getRoot().toString()).toBe(root);
    expect(restored.height).toBe(tree.height);

    const restoredWitness2 = restored.getWitness(2);
    expect(restoredWitness2.length).toBe(witness2.length);
    for (let i = 0; i < witness2.length; i++) {
      expect(restoredWitness2[i].isLeft).toBe(witness2[i].isLeft);
      expect(restoredWitness2[i].sibling.toString()).toBe(
        witness2[i].sibling.toString()
      );
    }

    // Verify proof still works after round-trip
    const valid = PoseidonMerkleTree.verifyWitness(
      leaves[2],
      restoredWitness2,
      restored.getRoot()
    );
    expect(valid).toBe(true);
  });

  it('handles minHeight parameter', () => {
    const leaves = [Field(1), Field(2)];
    const tree = PoseidonMerkleTree.fromLeaves(leaves, 10);
    expect(tree.height).toBe(10);
    expect(tree.capacity).toBe(512);
    expect(tree.getLeaf(0).toString()).toBe(Field(1).toString());
  });
});
