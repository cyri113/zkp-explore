import dotenv from 'dotenv';
import { initializeAlchemy, Network, AssetTransfersCategory, AssetTransfersOrder, getAssetTransfers } from '@alch/alchemy-sdk';

export type AssetTransfer = {
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
      return Network.ETH_MAINNET; // sepolia is not available in this SDK version; fallback to mainnet
    default:
      return Network.ETH_MAINNET;
  }
}

export async function fetchAllTransactions(
  apiKey: string,
  address: string,
  network = 'eth-mainnet',
  maxPages = 0, // 0 = no limit, >0 = max pages per direction
  fromBlock: string = '0x0' // starting block for resume
): Promise<{ transactions: AssetTransfer[]; incomingPageKey?: string; outgoingPageKey?: string }> {
  console.error(
    `[Alchemy] fetching transactions for ${address} on ${network}${maxPages > 0 ? ` (max ${maxPages} pages)` : ''}${fromBlock !== '0x0' ? ` (from block ${parseInt(fromBlock, 16)})` : ''}`
  );

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
    let retryCount = 0;
    const directionLabel = filters.fromAddress ? 'outgoing' : 'incoming';

    do {
      try {
        console.error(`[${directionLabel}] fetching page ${pageCount + 1}...`);
        const response: { transfers: any[]; pageKey?: string } = await getAssetTransfers(alchemy, pageKey ? {
          pageKey,
          category: categories,
          excludeZeroValue: false,
          order: AssetTransfersOrder.ASCENDING,
          maxCount: 100,
        } : {
          ...filters,
          fromBlock,
          toBlock: 'latest',
          category: categories,
          excludeZeroValue: false,
          order: AssetTransfersOrder.ASCENDING,
          maxCount: 100,
        });

        retryCount = 0; // reset on success

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
          pageKey = undefined; // Prevent next iteration
          break;
        }
      } catch (error) {
        const err = error as any;
        const isRateLimit = err?.status === 429 || err?.code === 'RATE_LIMITED';

        if (isRateLimit && retryCount < 3) {
          const backoffMs = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
          console.error(`[${directionLabel}] rate limited, retrying in ${backoffMs}ms...`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          retryCount++;
          continue;
        }

        console.error(`[${directionLabel}] error on page ${pageCount + 1}:`, (error as Error).message);
        throw error;
      }
    } while (pageKey);

    console.error(`[${directionLabel}] complete: ${pageCount} pages, ${results.length} total transfers`);
    return { results, finalPageKey: pageKey };
  };

  console.error(`[Alchemy] fetching incoming and outgoing in parallel...`);
  const startTime = Date.now();

  const [incomingResult, outgoingResult] = await Promise.all([
    mergeTransfers({ toAddress: address }),
    mergeTransfers({ fromAddress: address }),
  ]);

  const elapsedMs = Date.now() - startTime;
  console.error(`[Alchemy] fetch completed in ${elapsedMs}ms`);

  const all = [...incomingResult.results, ...outgoingResult.results];
  console.error(`[Alchemy] total transfers (before dedup): ${all.length}`);

  const uniqueMap = new Map<string, AssetTransfer>();
  for (const tx of all) {
    if (!uniqueMap.has(tx.hash)) {
      uniqueMap.set(tx.hash, tx);
    }
  }

  const sorted = [...uniqueMap.values()].sort((a, b) => Number(BigInt(a.blockNum) - BigInt(b.blockNum)));
  console.error(`[Alchemy] unique transfers (after dedup): ${sorted.length}`);

  return {
    transactions: sorted,
    incomingPageKey: incomingResult.finalPageKey,
    outgoingPageKey: outgoingResult.finalPageKey,
  };
}
// CLI entrypoint
if (require.main === module) {
  const { TransactionDb } = require('./TransactionDb');

  dotenv.config();

  const key = process.env.ALCHEMY_API_KEY;
  const address = process.argv[2];
  const reset = process.argv.includes('--reset');

  // Parse network and maxPages, skipping flags
  let network = 'eth-mainnet';
  let maxPages = 0;

  for (let i = 3; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--reset') continue;
    if (arg.startsWith('--')) continue;

    // Try to parse as a number (maxPages)
    const num = parseInt(arg, 10);
    if (!isNaN(num)) {
      maxPages = num;
    } else {
      // Otherwise it's the network
      network = arg;
    }
  }

  if (!key) {
    console.error('ALCHEMY_API_KEY not found in .env or environment');
    process.exit(1);
  }
  if (!address) {
    console.error('Usage: pnpm evm <address> [network] [maxPages] [--reset]');
    console.error('  network:  eth-mainnet (default), goerli, sepolia');
    console.error('  maxPages: max pages per direction (0=no limit, default=0, max=100)');
    console.error('  --reset:  clear existing data and start from the beginning');
    process.exit(1);
  }

  const timeoutMs = 300000; // 5 min timeout
  const timeoutId = setTimeout(() => {
    console.error('\n[Timeout] Command exceeded 5 minutes. Exiting.');
    process.exit(1);
  }, timeoutMs);

  (async () => {
    try {
      const db = new TransactionDb();

      try {
        // Handle reset
        if (reset) {
          const cleared = db.clearTransactions(address, network);
          db.clearCheckpoints(address, network);
          console.error(`[DB] Reset: cleared ${cleared} existing transactions and checkpoints for ${address} on ${network}`);
        } else {
          const existingCount = db.getTransactionCount(address, network);
          if (existingCount > 0) {
            const incomingCheckpoint = db.getCheckpoint(address, network, 'incoming');
            const outgoingCheckpoint = db.getCheckpoint(address, network, 'outgoing');
            console.error(
              `[DB] Resume: found ${existingCount} existing transactions, resuming from checkpoints`
            );
            if (incomingCheckpoint || outgoingCheckpoint) {
              console.error(`[DB] Checkpoints: incoming=${!!incomingCheckpoint}, outgoing=${!!outgoingCheckpoint}`);
            }
          }
        }

        // Load checkpoints for resuming (only if not resetting)
        let fromBlock: string = '0x0';

        if (!reset) {
          const existingCount = db.getTransactionCount(address, network);
          if (existingCount > 0) {
            const latestBlockNum = db.getLatestBlockNum(address, network);
            if (latestBlockNum) {
              // Start from the next block after the latest we have
              const nextBlock = BigInt(latestBlockNum) + 1n;
              fromBlock = '0x' + nextBlock.toString(16);
              console.error(
                `[DB] Resume: found ${existingCount} existing transactions, latest at block ${latestBlockNum}, resuming from block ${nextBlock}`
              );
            } else {
              console.error(`[DB] Resume: found ${existingCount} existing transactions but no block info`);
            }
          }
        }

        // Fetch transactions with block-based resume
        const fetchResult = await fetchAllTransactions(key, address, network, maxPages, fromBlock);
        const txs = fetchResult.transactions;

        // Store transactions in database (raw JSON dumps)
        const inserted = db.insertTransactions(address, network, txs, 'hash');
        console.error(`[DB] Stored ${inserted} new transactions (${txs.length} fetched, duplicates skipped)`);

        // Retrieve all transactions from database (for consistent output)
        const allStoredTxs = db.getTransactions(address, network);

        clearTimeout(timeoutId);
        console.log(
          JSON.stringify(
            { address, network, totalStored: allStoredTxs.length, transactions: allStoredTxs },
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
