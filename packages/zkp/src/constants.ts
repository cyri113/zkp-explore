import { MerkleWitness } from 'o1js';
import { BATCH_TREE_HEIGHT, TOP_TREE_HEIGHT } from '@zkp/merkle';

export { BATCH_TREE_HEIGHT, TOP_TREE_HEIGHT };

/**
 * Merkle witness class for batch trees. Height matches BATCH_TREE_HEIGHT in
 * @zkp/merkle so every batch proof has path length BATCH_TREE_HEIGHT - 1 = 14.
 */
export class BatchMerkleWitness extends MerkleWitness(BATCH_TREE_HEIGHT) {}

/**
 * Merkle witness class for the top-level (snapshot) tree, whose leaves are
 * batch roots. Height matches TOP_TREE_HEIGHT in @zkp/merkle.
 */
export class TopMerkleWitness extends MerkleWitness(TOP_TREE_HEIGHT) {}
