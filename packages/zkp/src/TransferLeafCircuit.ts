import { Field, Poseidon, Struct } from 'o1js';

/**
 * Circuit-friendly representation of an EVM TransferLeaf. Field encoding
 * matches `transferToLeafHash` in @zkp/merkle so that the hash computed
 * in-circuit equals the one stored in the batch Merkle tree.
 *
 * - from/to: 160-bit address packed into a single Field
 * - txHash: 256-bit hash split into 128-bit high/low halves
 * - value, logIndex, blockNumber: direct BigInt → Field conversions
 */
export class TransferLeafCircuit extends Struct({
  from: Field,
  to: Field,
  value: Field,
  txHashHigh: Field,
  txHashLow: Field,
  logIndex: Field,
  blockNumber: Field,
}) {
  hash(): Field {
    return Poseidon.hash([
      this.from,
      this.to,
      this.value,
      this.txHashHigh,
      this.txHashLow,
      this.logIndex,
      this.blockNumber,
    ]);
  }
}
