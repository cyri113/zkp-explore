import { MerkleWitness } from 'o1js';

export const TREE_HEIGHT = 20;

export class HashTreeWitness extends MerkleWitness(TREE_HEIGHT) { }
