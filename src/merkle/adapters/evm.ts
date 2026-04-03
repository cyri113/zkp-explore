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

export function evmTransferToLeaf(event: EvmTransferEvent): LeafEntry {
  const id = `${event.transactionHash}-${event.logIndex}`;
  const sortKey = `${pad(event.blockNumber, 12)}-${pad(event.logIndex, 6)}`;

  const fields: Field[] = [
    hashString(event.transactionHash),
    hashString(event.from),
    hashString(event.to),
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
