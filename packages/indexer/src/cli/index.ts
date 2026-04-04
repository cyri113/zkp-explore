// cli.ts
import { IndexerDb } from '../db';
import { AlchemyService } from '../services/alchemy';
import { resolveNetwork } from '../services/alchemy/networkMap';
import { ALCHEMY_API_KEY } from '../config';
import argv from './argv';

if (!ALCHEMY_API_KEY) {
  console.error('ALCHEMY_API_KEY not found in environment');
  process.exit(1);
}

(async () => {
  const { contractAddress, network, maxPages, reset } = argv;
  const db = new IndexerDb();

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
      if (lastBlock != null) fromBlock = '0x' + BigInt(lastBlock).toString(16);
      const existingCount = db.getTransactionCount();
      console.error(`[DB] Resume: ${existingCount} existing transactions, from block ${parseInt(fromBlock, 16)}`);
    }

    const service = new AlchemyService(ALCHEMY_API_KEY, resolveNetwork(network));
    let totalInserted = 0;

    const totalFetched = await service.fetchAllTransactions(
      contractAddress,
      fromBlock,
      maxPages,
      // onPage: insert transfers incrementally
      (pageTransfers) => {
        const inserted = db.insertTransactions(pageTransfers, 'uniqueId', assetId);
        totalInserted += inserted;
        console.error(`[Progress] Fetched ${pageTransfers.length} transfers, inserted ${inserted} (total ${totalInserted})`);
      },
      // onChunkDone: save checkpoint only at contiguous watermark (safe for resume)
      (safeBlock) => {
        db.saveCheckpoint(assetId, safeBlock);
        console.error(`[Checkpoint] Safe resume block: ${safeBlock}`);
      }
    );

    const totalStored = db.getTransactionCount();
    console.log(
      JSON.stringify(
        { contractAddress, network, totalStored, fetched: totalFetched, inserted: totalInserted },
        null,
        2
      )
    );
  } catch (err: any) {
    console.error('[Error]', err.message);
    process.exit(1);
  } finally {
    db.close();
  }
})();