// Legacy flat tree
export { LeafEntry, RootSnapshot } from './types';
export { hashLeaf, hashString } from './hash';
export { HashTree } from './HashTree';
export { HashTreeWitness, TREE_HEIGHT } from './HashTreeWitness';

// Legacy EVM adapter
export { evmTransferToLeaf, rawToEvmTransferEvent, clearHashCache, EvmTransferEvent, RawAlchemyTransfer } from './adapters/evm';

// Hierarchical merkle tree
export { TransferLeaf, BatchProof, TopLevelProof, WalletTransferResult, BATCH_SIZE, INITIAL_TOP_LEVEL_HEIGHT, BATCH_TREE_HEIGHT, TOP_TREE_HEIGHT } from './types';
export { PoseidonMerkleTree } from './PoseidonMerkleTree';
export { computeBatchArtifacts, PreparedBatch } from './batchArtifacts';
export { BatchBuilder } from './BatchBuilder';
export { QueryService } from './QueryService';
export { MerkleDb } from './MerkleDb';
export { transferToLeafHash, rawToTransferLeaf, normalizeEvmAddress, ZERO_ADDRESS } from './adapters/evm';
