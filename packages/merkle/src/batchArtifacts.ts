import { PoseidonMerkleTree } from './PoseidonMerkleTree';
import { TransferLeaf } from './types';
import { transferToLeafHash } from './adapters/evm';

export type PreparedBatch = {
  transfers: TransferLeaf[];
  leafHashes: string[];
  root: string;
  treeHeight: number;
  treeJson: string;
  walletMapEntries: [string, number[]][];
  firstBlock: number;
  lastBlock: number;
  firstLogIndex: number;
  lastLogIndex: number;
};

/** Pure CPU step: hashes, Poseidon tree, wallet index — no I/O. */
export function computeBatchArtifacts(transfers: TransferLeaf[]): PreparedBatch {
  if (transfers.length === 0) {
    throw new Error('Cannot build an empty batch');
  }

  const leafHashes = transfers.map((t) => transferToLeafHash(t));
  const tree = PoseidonMerkleTree.fromLeaves(leafHashes);
  const root = tree.getRoot().toString();

  const walletMap = new Map<string, number[]>();
  for (let i = 0; i < transfers.length; i++) {
    const t = transfers[i];
    const fromLower = t.from.toLowerCase();
    const toLower = t.to.toLowerCase();

    let fromIndices = walletMap.get(fromLower);
    if (!fromIndices) {
      fromIndices = [];
      walletMap.set(fromLower, fromIndices);
    }
    fromIndices.push(i);

    if (toLower !== fromLower) {
      let toIndices = walletMap.get(toLower);
      if (!toIndices) {
        toIndices = [];
        walletMap.set(toLower, toIndices);
      }
      toIndices.push(i);
    }
  }

  const firstTransfer = transfers[0];
  const lastTransfer = transfers[transfers.length - 1];
  const treeJson = JSON.stringify(tree.toJSON());

  return {
    transfers,
    leafHashes: leafHashes.map((h) => h.toString()),
    root,
    treeHeight: tree.height,
    treeJson,
    walletMapEntries: [...walletMap.entries()],
    firstBlock: firstTransfer.blockNumber,
    lastBlock: lastTransfer.blockNumber,
    firstLogIndex: firstTransfer.logIndex,
    lastLogIndex: lastTransfer.logIndex,
  };
}
