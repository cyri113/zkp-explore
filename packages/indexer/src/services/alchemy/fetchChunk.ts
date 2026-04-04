// services/alchemy/fetchChunk.ts
import { getAssetTransfers, AssetTransfersCategory, AssetTransfersOrder } from '@alch/alchemy-sdk';
import { AssetTransfer } from '../../types/assetTransfer';
import { mapTransfer } from './mapTransfer';
import { retry } from './retry';

const CATEGORIES: AssetTransfersCategory[] = [
  // AssetTransfersCategory.EXTERNAL,
  // AssetTransfersCategory.INTERNAL,
  AssetTransfersCategory.ERC20,
  // AssetTransfersCategory.ERC721,
  // AssetTransfersCategory.ERC1155,
];

export async function fetchChunk(
  alchemy: any,
  contractAddress: string,
  fromBlock: string,
  toBlock: string,
  maxPages: number,
  onPage?: (transfers: AssetTransfer[]) => void
): Promise<AssetTransfer[]> {
  const results: AssetTransfer[] = [];
  let pageKey: string | undefined;
  let pageCount = 0;

  do {
    const response = await retry(() =>
      getAssetTransfers(alchemy, {
        contractAddresses: [contractAddress],
        category: CATEGORIES,
        excludeZeroValue: false,
        order: AssetTransfersOrder.ASCENDING,
        maxCount: 1000,
        // withMetadata: true,
        ...(pageKey ? { pageKey } : { fromBlock, toBlock }),
      })
    );

    if (response.transfers?.length) {
      const mapped = response.transfers.map(mapTransfer);
      results.push(...mapped);
      onPage?.(mapped);
    }

    pageKey = response.pageKey;
    pageCount++;
    if (maxPages > 0 && pageCount >= maxPages) break;
  } while (pageKey);

  return results;
}