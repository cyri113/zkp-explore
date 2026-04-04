import { Field } from 'o1js';
import { LeafEntry } from '../types';
import { hashString } from '../hash';

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
