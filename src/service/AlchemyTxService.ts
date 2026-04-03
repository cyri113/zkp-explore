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
  network = 'eth-mainnet'
): Promise<AssetTransfer[]> {
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

    do {
      const response = await getAssetTransfers(alchemy, {
        ...filters,
        fromBlock: '0x0',
        toBlock: 'latest',
        category: categories,
        pageKey,
        excludeZeroValue: false,
        order: AssetTransfersOrder.ASCENDING,
      });

      if (response.transfers) {
        results.push(
          ...response.transfers.map((transfer: any) => ({
            hash: transfer.hash,
            from: transfer.from,
            to: transfer.to,
            value: transfer.value.toString(),
            asset: transfer.asset ?? null,
            category: transfer.category,
            blockNum: transfer.blockNum,
            metadata: transfer.metadata,
          }))
        );
      }

      pageKey = response.pageKey;
    } while (pageKey);

    return results;
  };

  const incoming = await mergeTransfers({ toAddress: address });
  const outgoing = await mergeTransfers({ fromAddress: address });

  const all = [...incoming, ...outgoing];

  const uniqueMap = new Map<string, AssetTransfer>();
  for (const tx of all) {
    if (!uniqueMap.has(tx.hash)) {
      uniqueMap.set(tx.hash, tx);
    }
  }

  return [...uniqueMap.values()].sort((a, b) => Number(BigInt(a.blockNum) - BigInt(b.blockNum)));
}

// CLI entrypoint
if (require.main === module) {
  const key = process.env.ALCHEMY_API_KEY;
  const address = process.argv[2];
  const network = process.argv[3] ?? 'eth-mainnet';

  if (!key) {
    console.error('ALCHEMY_API_KEY env var required');
    process.exit(1);
  }
  if (!address) {
    console.error('Usage: pnpm evm <address> [network]');
    process.exit(1);
  }

  fetchAllTransactions(key, address, network)
    .then((txs) => {
      console.log(JSON.stringify({ address, network, count: txs.length, transactions: txs }, null, 2));
    })
    .catch((error) => {
      console.error('Error:', error.message);
      process.exit(1);
    });
}
