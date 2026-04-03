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

    const txs = await fetchAllTransactions('fake-key', '0xAbc');

    expect(txs).toHaveLength(1);
    expect(txs[0].hash).toBe('0x1');
    expect(getAssetTransfers).toHaveBeenCalledTimes(2);
  });
});
