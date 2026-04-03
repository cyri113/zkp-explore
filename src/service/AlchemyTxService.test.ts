import { fetchAllTransactions } from './AlchemyTxService';

jest.mock('@alch/alchemy-sdk');

describe('AlchemyTxService', () => {
  let mockGetAssetTransfers: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const { getAssetTransfers } = require('@alch/alchemy-sdk');
    mockGetAssetTransfers = getAssetTransfers as jest.Mock;
    mockGetAssetTransfers.mockClear();
  });

  it('fetchAllTransactions returns merged unique transactions', async () => {
    const { getAssetTransfers, initializeAlchemy } = require('@alch/alchemy-sdk');
    (getAssetTransfers as jest.Mock)
      .mockResolvedValueOnce({
        transfers: [
          {
            hash: '0x1',
            from: 'A',
            to: 'B',
            value: 1,
            asset: 'ETH',
            category: 'external',
            blockNum: '0x1',
            rawContract: {},
          },
        ],
        pageKey: undefined,
      })
      .mockResolvedValueOnce({
        transfers: [
          {
            hash: '0x1',
            from: 'A',
            to: 'B',
            value: 1,
            asset: 'ETH',
            category: 'external',
            blockNum: '0x1',
            rawContract: {},
          },
        ],
        pageKey: undefined,
      });

    const result = await fetchAllTransactions('fake-key', '0xAbc');

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].hash).toBe('0x1');
    expect(result.incomingPageKey).toBeUndefined();
    expect(result.outgoingPageKey).toBeUndefined();
    expect(getAssetTransfers).toHaveBeenCalledTimes(2);
  });
});
