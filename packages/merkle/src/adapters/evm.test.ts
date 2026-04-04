// Jest globals (describe/it/expect) are available automatically
import { evmTransferToLeaf, EvmTransferEvent } from './evm';
import { hashString } from '../hash';

describe('EVM adapter', () => {
  it('maps event to leaf fields correctly', () => {
    const event: EvmTransferEvent = {
      transactionHash: '0xabc',
      logIndex: 5,
      blockNumber: 42,
      blockTimestamp: 1_700_000_000,
      from: '0x111',
      to: '0x222',
      value: 123n,
    };

    const leaf = evmTransferToLeaf(event);
    expect(leaf.id).toBe('0xabc-5');
    expect(leaf.timestamp).toBe(1_700_000_000);
    expect(leaf.sortKey).toBe('000000000042-000005');
    expect(leaf.fields[0].toString()).toBe(hashString(event.transactionHash).toString());
    expect(leaf.fields[1].toString()).toBe(hashString(event.from).toString());
    expect(leaf.fields[2].toString()).toBe(hashString(event.to).toString());
    expect(leaf.fields[3].toString()).toBe('123');
    expect(leaf.fields[4].toString()).toBe('1700000000');
  });

  it('deterministic: same event -> same leaf', () => {
    const event: EvmTransferEvent = {
      transactionHash: '0xabc',
      logIndex: 5,
      blockNumber: 42,
      blockTimestamp: 1_700_000_000,
      from: '0x111',
      to: '0x222',
      value: 123n,
    };

    const leaf1 = evmTransferToLeaf(event);
    const leaf2 = evmTransferToLeaf(event);

    expect(leaf1).toEqual(leaf2);
  });
});
