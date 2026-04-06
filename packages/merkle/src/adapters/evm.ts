import { Field, Poseidon } from 'o1js';
import { LeafEntry, TransferLeaf } from '../types';
import { hashString } from '../hash';

// --- Legacy types (kept for backward compat) ---

export type EvmTransferEvent = {
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  blockTimestamp: number;
  from: string;
  to: string;
  value: bigint;
};

const pad = (n: number | bigint, width: number): string => String(n).padStart(width, '0');

const hashCache = new Map<string, Field>();

function cachedHashString(s: string): Field {
  let result = hashCache.get(s);
  if (result === undefined) {
    result = hashString(s);
    hashCache.set(s, result);
  }
  return result;
}

export type RawAlchemyTransfer = Record<string, unknown>;

export function rawToEvmTransferEvent(raw: RawAlchemyTransfer): EvmTransferEvent {
  const blockNum = raw.blockNum as string;
  const blockNumber = Number(BigInt(blockNum));

  const uniqueId = raw.uniqueId as string;
  const parts = uniqueId.split(':');
  const logIndex = Number(parts[parts.length - 1]);

  const metadata = raw.metadata as { blockTimestamp?: string } | undefined;
  const blockTimestamp = metadata?.blockTimestamp
    ? Math.floor(new Date(metadata.blockTimestamp).getTime() / 1000)
    : 0;

  return {
    transactionHash: raw.hash as string,
    logIndex,
    blockNumber,
    blockTimestamp,
    from: raw.from as string,
    to: (raw.to as string) || '0x0000000000000000000000000000000000000000',
    value: BigInt(Math.trunc(Number(raw.value as string || '0'))),
  };
}

export function evmTransferToLeaf(event: EvmTransferEvent): LeafEntry {
  const id = `${event.transactionHash}-${event.logIndex}`;
  const sortKey = `${pad(event.blockNumber, 12)}-${pad(event.logIndex, 6)}`;

  const fields: Field[] = [
    cachedHashString(event.transactionHash),
    cachedHashString(event.from),
    cachedHashString(event.to),
    Field(event.value),
    Field(event.blockTimestamp),
  ];

  return {
    id,
    fields,
    timestamp: event.blockTimestamp,
    sortKey,
  };
}

export function clearHashCache(): void {
  hashCache.clear();
}

// --- New hierarchical tree functions ---

const MASK_128 = (1n << 128n) - 1n;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Canonical 0x + 40 hex (20 bytes), lowercase. Strips left ABI padding (hex longer than 40 uses the
 * last 20 bytes). Short forms are left-padded so wallet_index keys match RPC and user queries.
 */
export function normalizeEvmAddress(addr: string | null | undefined): string {
  if (addr == null || addr === '') return ZERO_ADDRESS;
  let s = String(addr).trim().toLowerCase();
  if (!s.startsWith('0x')) s = '0x' + s;
  let hex = s.slice(2);
  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`Invalid EVM address (non-hex): ${addr}`);
  }
  if (hex.length > 40) {
    hex = hex.slice(-40);
  }
  if (hex.length < 40) {
    hex = hex.padStart(40, '0');
  }
  return '0x' + hex;
}

/**
 * Convert raw indexer API JSON to a TransferLeaf.
 * Handles the Alchemy-style JSON format stored in the indexer DB.
 */
export function rawToTransferLeaf(raw: Record<string, unknown>): TransferLeaf {
  const blockNum = raw.blockNum as string;
  const blockNumber = Number(BigInt(blockNum));

  const uniqueId = raw.uniqueId as string;
  const parts = uniqueId.split(':');
  const logIndex = Number(parts[parts.length - 1]);

  // console.error(`Processing transaction ${raw.hash} | block ${blockNumber} | log ${logIndex}`);

  return {
    from: normalizeEvmAddress((raw.from as string) || ZERO_ADDRESS),
    to: normalizeEvmAddress((raw.to as string) || ZERO_ADDRESS),
    value: String(raw.value ?? '0'),
    txHash: (raw.hash as string).toLowerCase(),
    logIndex,
    blockNumber,
  };
}

/**
 * Hash a TransferLeaf using direct BigInt→Field conversion.
 *
 * - Addresses (160 bits) fit in a single Field (254-bit modulus)
 * - txHash (256 bits) is split into two 128-bit Fields
 * - value, logIndex, blockNumber are direct conversions
 * - Single Poseidon.hash call with 7 Fields
 *
 * This is orders of magnitude faster than the legacy hashString approach
 * which called Poseidon per-character.
 */
export function transferToLeafHash(leaf: TransferLeaf): Field {
  const fromField = Field(BigInt(normalizeEvmAddress(leaf.from)));
  const toField = Field(BigInt(normalizeEvmAddress(leaf.to)));

  // Value may be a decimal string, hex string, or "0"
  const valueBigInt = leaf.value.startsWith('0x')
    ? BigInt(leaf.value)
    : BigInt(Math.trunc(Number(leaf.value)));
  const valueField = Field(valueBigInt);

  // txHash is 256 bits — split into high/low 128-bit halves
  const txHashBigInt = BigInt(leaf.txHash);
  const txHashHigh = Field(txHashBigInt >> 128n);
  const txHashLow = Field(txHashBigInt & MASK_128);

  const logIndexField = Field(BigInt(leaf.logIndex));
  const blockField = Field(BigInt(leaf.blockNumber));

  return Poseidon.hash([
    fromField,
    toField,
    valueField,
    txHashHigh,
    txHashLow,
    logIndexField,
    blockField,
  ]);
}
