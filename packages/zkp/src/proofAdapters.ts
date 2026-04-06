import { Field } from 'o1js';
import type { BatchProof, TopLevelProof, TransferLeaf } from '@zkp/merkle';
import { normalizeEvmAddress } from '@zkp/merkle';
import { BatchMerkleWitness, TopMerkleWitness } from './constants';
import { TransferLeafCircuit } from './TransferLeafCircuit';

const MASK_128 = (1n << 128n) - 1n;

/**
 * Convert a TransferLeaf (plain JSON shape) to its circuit representation.
 * Uses the exact same BigInt → Field encoding as
 * `transferToLeafHash` in @zkp/merkle/src/adapters/evm.ts, so the hash
 * computed in-circuit equals the leaf hash stored in the batch tree.
 */
export function transferLeafToCircuit(leaf: TransferLeaf): TransferLeafCircuit {
  const valueBig = leaf.value.startsWith('0x')
    ? BigInt(leaf.value)
    : BigInt(Math.trunc(Number(leaf.value)));
  const txHashBig = BigInt(leaf.txHash);

  return new TransferLeafCircuit({
    from: Field(BigInt(normalizeEvmAddress(leaf.from))),
    to: Field(BigInt(normalizeEvmAddress(leaf.to))),
    value: Field(valueBig),
    txHashHigh: Field(txHashBig >> 128n),
    txHashLow: Field(txHashBig & MASK_128),
    logIndex: Field(BigInt(leaf.logIndex)),
    blockNumber: Field(BigInt(leaf.blockNumber)),
  });
}

/**
 * Convert the serialized batch Merkle witness emitted by @zkp/merkle
 * (BatchProof.batchWitness) into a circuit-compatible BatchMerkleWitness.
 */
export function batchWitnessToCircuit(
  witness: BatchProof['batchWitness']
): BatchMerkleWitness {
  return new BatchMerkleWitness(
    witness.map(({ isLeft, sibling }) => ({
      isLeft,
      sibling: Field(BigInt(sibling)),
    }))
  );
}

/**
 * Convert the serialized top-level Merkle witness emitted by @zkp/merkle
 * (TopLevelProof.topWitness) into a circuit-compatible TopMerkleWitness.
 */
export function topWitnessToCircuit(
  witness: TopLevelProof['topWitness']
): TopMerkleWitness {
  return new TopMerkleWitness(
    witness.map(({ isLeft, sibling }) => ({
      isLeft,
      sibling: Field(BigInt(sibling)),
    }))
  );
}
