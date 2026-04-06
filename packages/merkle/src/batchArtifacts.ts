import { PoseidonMerkleTree } from './PoseidonMerkleTree';
import { TransferLeaf, BATCH_TREE_HEIGHT } from './types';
import { normalizeEvmAddress, transferToLeafHash } from './adapters/evm';

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
  const tree = PoseidonMerkleTree.fromLeaves(leafHashes, BATCH_TREE_HEIGHT);
  const root = tree.getRoot().toString();

  const walletMap = new Map<string, number[]>();
  for (let i = 0; i < transfers.length; i++) {
    const t = transfers[i];
    const fromKey = normalizeEvmAddress(t.from);
    const toKey = normalizeEvmAddress(t.to);

    let fromIndices = walletMap.get(fromKey);
    if (!fromIndices) {
      fromIndices = [];
      walletMap.set(fromKey, fromIndices);
    }
    fromIndices.push(i);

    if (toKey !== fromKey) {
      let toIndices = walletMap.get(toKey);
      if (!toIndices) {
        toIndices = [];
        walletMap.set(toKey, toIndices);
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
