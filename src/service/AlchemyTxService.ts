import dotenv from 'dotenv';
import { initializeAlchemy, Network, AssetTransfersCategory, AssetTransfersOrder, getAssetTransfers } from '@alch/alchemy-sdk';

export type AssetTransfer = {
  hash: string;
  from: string;
  to: string;
  value: string;
  asset: string | null;
  category: string;
  blockNum: string;
  metadata?: unknown;
};

function getNetwork(network: string): Network {
  switch (network) {
    case 'mainnet':
    case 'eth-mainnet':
      return Network.ETH_MAINNET;
    case 'goerli':
      return Network.ETH_GOERLI;
    case 'sepolia':
      return Network.ETH_MAINNET; // sepolia is not available in this SDK version; fallback to mainnet
    default:
      return Network.ETH_MAINNET;
  }
}

export async function fetchAllTransactions(
  apiKey: string,
  address: string,
  network = 'eth-mainnet',
  maxPages = 0 // 0 = no limit, >0 = max pages per direction
): Promise<AssetTransfer[]> {
  console.error(`[Alchemy] fetching transactions for ${address} on ${network}${maxPages > 0 ? ` (max ${maxPages} pages)` : ''}`);

  const alchemy = initializeAlchemy({ apiKey, network: getNetwork(network) });

  const categories: AssetTransfersCategory[] = [
    AssetTransfersCategory.EXTERNAL,
    AssetTransfersCategory.ERC20,
    AssetTransfersCategory.ERC721,
    AssetTransfersCategory.ERC1155,
  ];

  const mergeTransfers = async (filters: { fromAddress?: string; toAddress?: string }) => {
    let pageKey: string | undefined = undefined;
    const results: AssetTransfer[] = [];
    let pageCount = 0;
    const directionLabel = filters.fromAddress ? 'outgoing' : 'incoming';

    do {
      try {
        console.error(`[${directionLabel}] fetching page ${pageCount + 1}...`);
        const response = await getAssetTransfers(alchemy, {
          ...filters,
          fromBlock: '0x0',
          toBlock: 'latest',
          category: categories,
          pageKey,
          excludeZeroValue: false,
          order: AssetTransfersOrder.ASCENDING,
          maxCount: 100,
        });

        if (response.transfers) {
          results.push(
            ...response.transfers.map((transfer: any) => ({
              hash: transfer.hash,
              from: transfer.from,
              to: transfer.to || null,
              value: transfer.value?.toString() ?? '0',
              asset: transfer.asset ?? null,
              category: transfer.category,
              blockNum: transfer.blockNum,
              metadata: transfer.metadata,
            }))
          );
          console.error(`[${directionLabel}] page ${pageCount + 1} fetched: ${response.transfers.length} transfers`);
        }

        pageKey = response.pageKey;
        pageCount++;

        // Safety limit: max pages (user-configurable or hard limit of 100)
        const pageLimit = maxPages > 0 ? Math.min(maxPages, 100) : 100;
        if (pageCount >= pageLimit) {
          console.error(`[${directionLabel}] reached page limit (${pageLimit})`);
          break;
        }
      } catch (error) {
        console.error(`[${directionLabel}] error on page ${pageCount + 1}:`, (error as Error).message);
        throw error;
      }
    } while (pageKey);

    console.error(`[${directionLabel}] complete: ${pageCount} pages, ${results.length} total transfers`);
    return results;
  };

  const incoming = await mergeTransfers({ toAddress: address });
  const outgoing = await mergeTransfers({ fromAddress: address });

  const all = [...incoming, ...outgoing];
  console.error(`[Alchemy] total transfers (before dedup): ${all.length}`);

  const uniqueMap = new Map<string, AssetTransfer>();
  for (const tx of all) {
    if (!uniqueMap.has(tx.hash)) {
      uniqueMap.set(tx.hash, tx);
    }
  }

  const sorted = [...uniqueMap.values()].sort((a, b) => Number(BigInt(a.blockNum) - BigInt(b.blockNum)));
  console.error(`[Alchemy] unique transfers (after dedup): ${sorted.length}`);

  return sorted;
}
// CLI entrypoint
if (require.main === module) {
  dotenv.config();

  const key = process.env.ALCHEMY_API_KEY;
  const address = process.argv[2];
  const network = process.argv[3] ?? 'eth-mainnet';
  const maxPages = parseInt(process.argv[4] ?? '0', 10);

  if (!key) {
    console.error('ALCHEMY_API_KEY not found in .env or environment');
    process.exit(1);
  }
  if (!address) {
    console.error('Usage: pnpm evm <address> [network] [maxPages]');
    console.error('  maxPages: max pages per direction (0=no limit, def=0, max=100)');
    process.exit(1);
  }

  const timeoutMs = 300000; // 5 min timeout
  const timeoutId = setTimeout(() => {
    console.error('\n[Timeout] Command exceeded 5 minutes. Exiting.');
    process.exit(1);
  }, timeoutMs);

  fetchAllTransactions(key, address, network, maxPages)
    .then((txs) => {
      clearTimeout(timeoutId);
      console.log(JSON.stringify({ address, network, count: txs.length, transactions: txs }, null, 2));
    })
    .catch((error) => {
      clearTimeout(timeoutId);
      console.error('\n[Error]', error.message);
      process.exit(1);
    });
}
