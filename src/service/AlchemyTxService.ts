import dotenv from 'dotenv';
import { initializeAlchemy, Network, AssetTransfersCategory, AssetTransfersOrder, getAssetTransfers } from '@alch/alchemy-sdk';

export type AssetTransfer = {
  uniqueId: string;
  hash: string;
  from: string;
  to: string | null;
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
      return Network.ETH_MAINNET;
    default:
      return Network.ETH_MAINNET;
  }
}

const CATEGORIES: AssetTransfersCategory[] = [
  AssetTransfersCategory.ERC20,
  AssetTransfersCategory.ERC721,
  AssetTransfersCategory.ERC1155,
];

const CHUNK_SIZE = 500_000; // blocks per chunk
const CONCURRENCY = 3; // parallel chunk fetches

async function fetchChunk(
  alchemy: any,
  contractAddress: string,
  fromBlock: string,
  toBlock: string,
  maxPages: number,
  onPage?: (transfers: AssetTransfer[]) => void
): Promise<AssetTransfer[]> {
  const results: AssetTransfer[] = [];
  let pageKey: string | undefined = undefined;
  let pageCount = 0;
  let retryCount = 0;

  do {
    try {
      const params: any = {
        contractAddresses: [contractAddress],
        category: CATEGORIES,
        excludeZeroValue: false,
        order: AssetTransfersOrder.ASCENDING,
        maxCount: 100,
        withMetadata: true,
        ...(pageKey ? { pageKey } : { fromBlock, toBlock }),
      };
      const response: { transfers: any[]; pageKey?: string } = await getAssetTransfers(alchemy, params);

      retryCount = 0;

      if (response.transfers) {
        const mapped = response.transfers.map((transfer: any) => ({
          uniqueId: transfer.uniqueId,
          hash: transfer.hash,
          from: transfer.from,
          to: transfer.to || null,
          value: transfer.value?.toString() ?? '0',
          asset: transfer.asset ?? null,
          category: transfer.category,
          blockNum: transfer.blockNum,
          metadata: transfer.metadata,
        }));
        for (const tx of mapped) results.push(tx);
        if (onPage) onPage(mapped);
      }

      pageKey = response.pageKey;
      pageCount++;

      if (maxPages > 0 && pageCount >= maxPages) {
        break;
      }
    } catch (error) {
      const err = error as any;
      const isRateLimit = err?.status === 429 || err?.code === 'RATE_LIMITED';

      if (isRateLimit && retryCount < 3) {
        const backoffMs = Math.pow(2, retryCount) * 1000;
        console.error(`[fetch] rate limited, retrying in ${backoffMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        retryCount++;
        continue;
      }

      throw error;
    }
  } while (pageKey);

  return results;
}

export async function fetchAllTransactions(
  apiKey: string,
  contractAddress: string,
  network = 'eth-mainnet',
  maxPages = 0,
  fromBlock: string = '0x0',
  onPage?: (transfers: AssetTransfer[]) => void
): Promise<{ transactions: AssetTransfer[] }> {
  const alchemy = initializeAlchemy({ apiKey, network: getNetwork(network) });

  // Fetch latest block via JSON-RPC directly (SDK provider causes stack overflow in v1.2.0)
  const rpcUrl = `https://${network}.g.alchemy.com/v2/${apiKey}`;
  const blockRes = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
  });
  const blockJson = await blockRes.json() as { result: string };
  const latestBlock = parseInt(blockJson.result, 16);
  const startBlock = parseInt(fromBlock, 16);

  console.error(`[Alchemy] contract=${contractAddress} network=${network} blocks=${startBlock}..${latestBlock}`);

  // Split into chunks
  const chunks: Array<{ from: number; to: number }> = [];
  for (let b = startBlock; b <= latestBlock; b += CHUNK_SIZE) {
    chunks.push({ from: b, to: Math.min(b + CHUNK_SIZE - 1, latestBlock) });
  }

  console.error(`[Alchemy] ${chunks.length} chunks, ${CONCURRENCY} concurrent`);

  const allResults: AssetTransfer[] = [];

  // Process chunks with concurrency limit
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const promises = batch.map((chunk, idx) => {
      const chunkIdx = i + idx + 1;
      const fromHex = '0x' + chunk.from.toString(16);
      const toHex = '0x' + chunk.to.toString(16);
      console.error(`[chunk ${chunkIdx}/${chunks.length}] blocks ${chunk.from}..${chunk.to}`);
      return fetchChunk(alchemy, contractAddress, fromHex, toHex, maxPages, onPage);
    });

    const results = await Promise.all(promises);
    for (const r of results) {
      for (const tx of r) {
        allResults.push(tx);
      }
    }
  }

  console.error(`[Alchemy] complete: ${allResults.length} total transfers`);
  return { transactions: allResults };
}

// CLI entrypoint
if (require.main === module) {
  const { TransactionDb } = require('./TransactionDb');

  dotenv.config();

  const key = process.env.ALCHEMY_API_KEY;
  const contractAddress = process.argv[2];
  const reset = process.argv.includes('--reset');

  let network = 'eth-mainnet';
  let maxPages = 0;

  for (let i = 3; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) continue;

    const num = parseInt(arg, 10);
    if (!isNaN(num)) {
      maxPages = num;
    } else {
      network = arg;
    }
  }

  if (!key) {
    console.error('ALCHEMY_API_KEY not found in .env or environment');
    process.exit(1);
  }
  if (!contractAddress) {
    console.error('Usage: pnpm evm <contractAddress> [network] [maxPages] [--reset]');
    console.error('  contractAddress: token/contract address to fetch transfers for');
    console.error('  network:  eth-mainnet (default), goerli, sepolia');
    console.error('  maxPages: max pages per chunk (0=no limit, default=0)');
    console.error('  --reset:  clear existing data and start from the beginning');
    process.exit(1);
  }

  const timeoutMs = 86400000; // 1 day
  const timeoutId = setTimeout(() => {
    console.error('\n[Timeout] Exiting.');
    process.exit(1);
  }, timeoutMs);

  (async () => {
    try {
      const db = new TransactionDb();

      try {
        const networkId = db.getOrCreateNetwork(network);
        const assetId = db.getOrCreateAsset(networkId, contractAddress);

        if (reset) {
          const cleared = db.clearTransactions();
          db.clearCheckpoints(assetId);
          console.error(`[DB] Reset: cleared ${cleared} transactions and checkpoints for ${contractAddress} on ${network}`);
        }

        let fromBlock = '0x0';
        if (!reset) {
          const lastBlock = db.getResumeBlock(assetId);
          if (lastBlock != null) {
            fromBlock = '0x' + BigInt(lastBlock).toString(16);
          }
          const existingCount = db.getTransactionCount();
          console.error(`[DB] Resume: ${existingCount} existing transactions, from block ${parseInt(fromBlock, 16)}`);
        }

        let totalInserted = 0;
        const fetchResult = await fetchAllTransactions(key, contractAddress, network, maxPages, fromBlock, (transfers) => {
          const inserted = db.insertTransactions(transfers, 'uniqueId', assetId);
          totalInserted += inserted;

          if (transfers.length > 0) {
            let maxBlock = 0;
            for (const tx of transfers) {
              const blockNum = Number(BigInt(tx.blockNum));
              if (blockNum > maxBlock) maxBlock = blockNum;
            }
            db.saveCheckpoint(assetId, maxBlock);
          }
        });

        console.error(`[DB] Stored ${totalInserted} new transactions (${fetchResult.transactions.length} fetched, duplicates skipped)`);

        const totalStored = db.getTransactionCount();

        clearTimeout(timeoutId);
        console.log(
          JSON.stringify(
            { contractAddress, network, totalStored, fetched: fetchResult.transactions.length, inserted: totalInserted },
            null,
            2
          )
        );
      } finally {
        db.close();
      }
    } catch (error) {
      clearTimeout(timeoutId);
      console.error('\n[Error]', (error as Error).message);
      process.exit(1);
    }
  })();
}
