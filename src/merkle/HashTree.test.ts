// Jest globals (describe/it/expect) are available automatically
import { Field } from 'o1js';
import { HashTree } from './HashTree';
import { hashString, hashLeaf } from './hash';
import { LeafEntry } from './types';

const makeEntry = (id: string, sortKey: string, timestamp: number, data: string): LeafEntry => ({
  id,
  sortKey,
  timestamp,
  fields: [hashString(data)],
});

describe('HashTree', () => {
  it('insert one leaf: root changes, snapshot recorded', () => {
    const tree = new HashTree(20);
    const entry = makeEntry('id1', '000001', 1, 'A');

    const snapshot = tree.addLeaf(entry);
    expect(snapshot.leafIndex).toBe(0);
    expect(tree.getLeafCount()).toBe(1n);
    expect(tree.getSnapshots().length).toBe(1);
    expect(tree.getRoot().toString()).toBe(snapshot.root);
  });

  it('insert multiple leaves: distinct roots, ordered snapshots', () => {
    const tree = new HashTree(20);
    const entries = [
      makeEntry('id1', '000001', 100, 'A'),
      makeEntry('id2', '000002', 200, 'B'),
      makeEntry('id3', '000003', 300, 'C'),
    ];

    const snapshots = tree.addLeaves(entries);
    expect(snapshots.length).toBe(3);
    expect(snapshots[0].timestamp).toBe(100);
    expect(snapshots[1].timestamp).toBe(200);
    expect(snapshots[2].timestamp).toBe(300);
    expect(snapshots[0].root).not.toBe(snapshots[2].root);
  });

  it('getRootAt returns correct historical root', () => {
    const tree = new HashTree(20);
    const entries = [
      makeEntry('id1', '000001', 10, 'A'),
      makeEntry('id2', '000002', 20, 'B'),
      makeEntry('id3', '000003', 30, 'C'),
    ];
    tree.addLeaves(entries);

    const exact = tree.getRootAt(20);
    expect(exact.toString()).toBe(tree.getSnapshots()[1].root);

    const between = tree.getRootAt(25);
    expect(between.toString()).toBe(tree.getSnapshots()[1].root);

    const after = tree.getRootAt(40);
    expect(after.toString()).toBe(tree.getSnapshots()[2].root);
  });

  it('getRootAt throws before first insertion', () => {
    const tree = new HashTree(20);
    const entry = makeEntry('id1', '000001', 100, 'A');
    tree.addLeaf(entry);

    expect(() => tree.getRootAt(50)).toThrow();
  });

  it('getWitness returns proof and tree.validate works', () => {
    const tree = new HashTree(20);
    const entry = makeEntry('id1', '000001', 100, 'A');
    tree.addLeaf(entry);

    const witness = tree.getWitness(0n);
    expect(Array.isArray(witness)).toBe(true);
    expect(tree.validate(0n)).toBe(true);
  });

  it('getLeafIndex works and unknown returns undefined', () => {
    const tree = new HashTree(20);
    const entry = makeEntry('id1', '000001', 100, 'A');
    tree.addLeaf(entry);

    expect(tree.getLeafIndex('id1')).toBe(0n);
    expect(tree.getLeafIndex('missing')).toBeUndefined();
  });

  it('out-of-order sortKey throws', () => {
    const tree = new HashTree(20);
    tree.addLeaf(makeEntry('id1', '000001', 100, 'A'));
    expect(() => tree.addLeaf(makeEntry('id2', '000000', 200, 'B'))).toThrow();
  });

  it('determinism: two trees same data same root', () => {
    const entries = [
      makeEntry('id1', '000001', 1, 'A'),
      makeEntry('id2', '000002', 2, 'B'),
    ];

    const tree1 = new HashTree(20);
    const tree2 = new HashTree(20);
    tree1.addLeaves(entries);
    tree2.addLeaves(entries);

    expect(tree1.getRoot().toString()).toBe(tree2.getRoot().toString());
  });

  it('fromJSON(toJSON()) has same root/snapshots/witness', () => {
    const tree = new HashTree(20);
    const entries = [
      makeEntry('id1', '000001', 1, 'A'),
      makeEntry('id2', '000002', 2, 'B'),
    ];
    tree.addLeaves(entries);

    const json = tree.toJSON();
    const restored = HashTree.fromJSON(json);

    expect(restored.getRoot().toString()).toBe(tree.getRoot().toString());
    expect(restored.getSnapshots()).toEqual(tree.getSnapshots());

    const witness = restored.getWitness(0n);
    expect(Array.isArray(witness)).toBe(true);
    expect(restored.validate(0n)).toBe(true);
  });

  it('addLeaves matches sequential addLeaf', () => {
    const entries = [
      makeEntry('id1', '000001', 1, 'A'),
      makeEntry('id2', '000002', 2, 'B'),
    ];

    const treeA = new HashTree(20);
    entries.forEach((entry) => treeA.addLeaf(entry));

    const treeB = new HashTree(20);
    treeB.addLeaves(entries);

    expect(treeA.getRoot().toString()).toBe(treeB.getRoot().toString());
    expect(treeA.getSnapshots()).toEqual(treeB.getSnapshots());
  });
});
