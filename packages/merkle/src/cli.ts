import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { MerkleDb } from './MerkleDb';
import { BatchBuilder } from './BatchBuilder';
import { QueryService } from './QueryService';

dotenv.config();

/** pnpm passes a lone `--` through to the script; yargs would treat it as positional and ignore real flags */
function argvForYargs(): string[] {
  return hideBin(process.argv).filter((a) => a !== '--');
}

function assetIdFromEnv(): number | undefined {
  const raw = process.env.MERKLE_ASSET_ID;
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function defaultBatchConcurrency(): number {
  const raw = process.env.MERKLE_BATCH_CONCURRENCY;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.min(32, Math.floor(n));
  }
  return 1;
}

function indexerPageSizeFromEnv(): number | undefined {
  const raw = process.env.MERKLE_FETCH_PAGE_SIZE;
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 100) return undefined;
  return Math.min(50_000, Math.floor(n));
}

yargs(argvForYargs())
  .command(
    'build',
    'Fetch transfers from indexer and build hierarchical merkle tree for an asset',
    (y) =>
      y
        .option('asset-id', {
          type: 'number',
          default: assetIdFromEnv() ?? 1,
          describe:
            'Asset ID from the indexer (see GET /assets). Defaults to 1, or MERKLE_ASSET_ID from .env.',
        })
        .option('indexer-url', {
          type: 'string',
          default: 'http://localhost:3001',
          describe: 'URL of the indexer HTTP API',
        })
        .option('batch-size', {
          type: 'number',
          default: 10_000,
          describe: 'Number of transfers per batch',
        })
        .option('batch-concurrency', {
          type: 'number',
          default: defaultBatchConcurrency(),
          describe:
            'p-limit: prep up to N full batches before persisting (buffers batches even with small fetch pages). 1 = flush each batch immediately.',
        })
        .option('fetch-page-size', {
          type: 'number',
          default: 0,
          describe:
            'Indexer /transactions page_size (0 = auto, max 2000 rows, or MERKLE_FETCH_PAGE_SIZE).',
        })
        .option('reset', {
          type: 'boolean',
          default: false,
          describe:
            'Wipe the entire merkle SQLite DB (all assets), then build from scratch for --asset-id.',
        }),
    async (argv) => {
      const db = new MerkleDb();
      if (argv.reset) {
        console.error('[Build] --reset: clearing all tables in merkle database...');
        db.clearAll();
      }
      const explicitPage =
        argv.fetchPageSize > 0
          ? Math.min(50_000, Math.floor(argv.fetchPageSize))
          : indexerPageSizeFromEnv();
      const builder = new BatchBuilder(
        db,
        argv.assetId,
        argv.batchSize,
        argv.batchConcurrency,
        explicitPage
      );

      try {
        const result = await builder.buildFromIndexer(
          argv.indexerUrl,
          (info) => {
            console.error(
              `[Build] Asset ${argv.assetId} | Batch ${info.batchesBuilt} | ${info.leavesProcessed.toLocaleString()}/${info.totalTransactions.toLocaleString()} leaves | ${info.ratePerSec.toLocaleString()} leaves/s`
            );
          }
        );

        console.log(JSON.stringify({ assetId: argv.assetId, ...result }, null, 2));
      } catch (err: any) {
        console.error('[Error]', err.message);
        process.exit(1);
      } finally {
        db.close();
      }
    }
  )
  .command(
    'query',
    'Query wallet transfers with merkle proofs for a specific asset',
    (y) =>
      y
        .option('asset-id', {
          type: 'number',
          demandOption: true,
          describe: 'Asset ID from the indexer',
        })
        .option('wallet', {
          type: 'string',
          demandOption: true,
          describe: 'Wallet address (0x...)',
        })
        .option('block', {
          type: 'number',
          demandOption: true,
          describe: 'Block number to query at',
        })
        .option('limit', {
          type: 'number',
          default: 500,
          describe:
            'Max transfers to include with proofs (default 500). Use 0 for no limit — can fail on very active wallets.',
        }),
    (argv) => {
      const db = new MerkleDb();
      const queryService = new QueryService(db);

      try {
        const limit = argv.limit === 0 ? undefined : argv.limit;
        if (argv.limit === 0) {
          console.error('[Query] --limit 0: no cap on result size; JSON output may be huge or fail.');
        }
        const result = queryService.getWalletTransfersAtBlock(
          argv.assetId,
          argv.wallet,
          argv.block,
          limit
        );
        const indent = result.transfers.length <= 30 ? 2 : undefined;
        console.log(JSON.stringify(result, null, indent));
      } catch (err: any) {
        console.error('[Error]', err.message);
        process.exit(1);
      } finally {
        db.close();
      }
    }
  )
  .demandCommand(1, 'Please specify a command: build or query')
  .strict()
  .help()
  .parseAsync();
