import { Field } from 'o1js';
import { MerkleDb } from './MerkleDb';
import { PoseidonMerkleTree } from './PoseidonMerkleTree';
import { TransferLeaf, BATCH_SIZE, INITIAL_TOP_LEVEL_HEIGHT } from './types';
import { rawToTransferLeaf } from './adapters/evm';
import axios, { AxiosInstance } from 'axios';
import pLimit from 'p-limit';
import { computeBatchArtifacts, type PreparedBatch } from './batchArtifacts';

export type ProgressCallback = (info: {
  batchesBuilt: number;
  leavesProcessed: number;
  totalTransactions: number;
  ratePerSec: number;
}) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableIndexerError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const code = err.code;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED') return true;
  const status = err.response?.status;
  return status != null && status >= 500 && status < 600;
}

async function fetchJson(client: AxiosInstance, url: string, params: Record<string, unknown>): Promise<unknown> {
  const maxAttempts = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data } = await client.get(url, { params });
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && isRetryableIndexerError(err)) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      if (axios.isAxiosError(err)) {
        throw new Error(`Indexer request failed: ${err.message}`);
      }
      throw err;
    }
  }
  throw lastErr;
}

type TransactionsResponse = {
  transactions: Record<string, unknown>[];
  lastBlock: number;
  lastLog: number;
};

async function fetchTransactionsPage(
  client: AxiosInstance,
  assetId: number,
  afterBlock: number,
  afterLog: number,
  pageSize: number
): Promise<TransactionsResponse> {
  return (await fetchJson(client, `/transactions`, {
    asset_id: assetId,
    page_size: pageSize,
    after_block: afterBlock,
    after_log: afterLog,
  })) as TransactionsResponse;
}

/**
 * Indexer GET /transactions page_size: keep payloads small (memory, JSON parse, timeouts).
 * When `explicit` is set (CLI / env), it is clamped to [100, 50_000].
 * Otherwise: min(batchSize, 2000) with a floor of 500 so tiny batch sizes still paginate.
 */
export function resolveIndexerFetchPageSize(batchSize: number, explicit?: number): number {
  if (explicit != null && Number.isFinite(explicit)) {
    const n = Math.floor(explicit);
    if (n >= 100) return Math.min(50_000, n);
  }
  const maxPage = 2_000;
  const minPage = 500;
  return Math.min(maxPage, Math.max(minPage, Math.min(batchSize, maxPage)));
}

export class BatchBuilder {
  constructor(
    private db: MerkleDb,
    private assetId: number,
    private batchSize = BATCH_SIZE,
    private readonly batchComputeConcurrency = 1,
    private readonly indexerPageSize?: number
  ) {}

  /**
   * Fetch all transactions for this asset from the indexer API, build batch trees,
   * wallet indices, and a top-level snapshot. Supports incremental builds.
   */
  async buildFromIndexer(
    indexerUrl: string,
    onProgress?: ProgressCallback
  ): Promise<{ batchesBuilt: number; totalLeaves: number; root: string }> {
    const client = axios.create({
      baseURL: indexerUrl,
      timeout: 10_000,
    });

    const concurrency = Math.max(1, this.batchComputeConcurrency);
    const limit = pLimit(concurrency);

    // Resume from last batch for this asset if exists
    const lastBatch = this.db.getLastBatch(this.assetId);
    let afterBlock = lastBatch?.lastBlock ?? -1;
    let afterLog = lastBatch?.lastLogIndex ?? -1;
    const existingBatches = this.db.getBatchCount(this.assetId);

    const countRes = (await fetchJson(client, `/transactions/count`, { asset_id: this.assetId })) as {
      count: number;
    };
    const total = countRes.count;
    console.error(`Total transactions to process for asset ${this.assetId}: ${total.toLocaleString()}`);
    if (concurrency > 1) {
      console.error(
        `Batch prep concurrency: ${concurrency} (p-limit over batches; main-thread CPU, SQLite writes stay ordered)`
      );
    }

    const startTime = Date.now();
    let batchesBuilt = 0;
    let leavesProcessed = 0;
    const buffer: TransferLeaf[] = [];
    /** Full batches waiting to prep+flush — we drain in groups of `concurrency` so p-limit helps even with small indexer pages. */
    const pendingBatches: TransferLeaf[][] = [];

    const pageSize = resolveIndexerFetchPageSize(this.batchSize, this.indexerPageSize);

    const flushPrepared = async (slices: TransferLeaf[][]) => {
      if (slices.length === 0) return;

      const prepared = await Promise.all(
        slices.map((slice) => limit(() => Promise.resolve(computeBatchArtifacts(slice))))
      );

      for (const p of prepared) {
        this.persistPreparedBatch(p);
        batchesBuilt++;
        leavesProcessed += p.transfers.length;

        if (onProgress) {
          const elapsed = (Date.now() - startTime) / 1000;
          onProgress({
            batchesBuilt: existingBatches + batchesBuilt,
            leavesProcessed,
            totalTransactions: total,
            ratePerSec: Math.round(leavesProcessed / Math.max(elapsed, 1e-6)),
          });
        }
      }
    };

    const flushPendingWhenFull = async () => {
      while (pendingBatches.length >= concurrency) {
        await flushPrepared(pendingBatches.splice(0, concurrency));
      }
    };

    const flushAllPending = async () => {
      while (pendingBatches.length >= concurrency) {
        await flushPrepared(pendingBatches.splice(0, concurrency));
      }
      if (pendingBatches.length > 0) {
        await flushPrepared(pendingBatches.splice(0, pendingBatches.length));
      }
    };

    let nextPage = fetchTransactionsPage(client, this.assetId, afterBlock, afterLog, pageSize);

    while (true) {
      console.error(`Fetching transactions after block ${afterBlock}, log ${afterLog} (page_size=${pageSize})...`);
      const page = await nextPage;

      console.error(
        `Fetched page: ${page.transactions.length} transactions | afterBlock: ${afterBlock} | afterLog: ${afterLog}`
      );

      if (page.transactions.length === 0) break;

      afterBlock = page.lastBlock;
      afterLog = page.lastLog;
      nextPage = fetchTransactionsPage(client, this.assetId, afterBlock, afterLog, pageSize);

      for (const raw of page.transactions) {
        buffer.push(rawToTransferLeaf(raw));
      }

      while (buffer.length >= this.batchSize) {
        pendingBatches.push(buffer.splice(0, this.batchSize));
      }
      await flushPendingWhenFull();
    }

    await flushAllPending();

    if (buffer.length > 0) {
      console.error(`Building final batch with ${buffer.length} transfers`);
      await flushPrepared([buffer.splice(0, buffer.length)]);
    }

    const { root } = this.buildTopLevelTree();

    return {
      batchesBuilt,
      totalLeaves: leavesProcessed,
      root,
    };
  }

  /**
   * Persist a precomputed batch (main thread / SQLite only).
   */
  persistPreparedBatch(p: PreparedBatch): { batchId: number; root: string } {
    const batchId = this.db.saveBatch(
      this.assetId,
      p.transfers.length,
      p.root,
      p.firstBlock,
      p.lastBlock,
      p.firstLogIndex,
      p.lastLogIndex,
      p.treeHeight,
      p.treeJson
    );

    this.db.saveBatchLeaves(
      batchId,
      p.transfers.map((leaf, i) => ({
        leaf,
        leafHash: p.leafHashes[i],
        leafIndex: i,
      }))
    );

    this.db.saveWalletIndices(batchId, this.assetId, new Map(p.walletMapEntries));

    return { batchId, root: p.root };
  }

  /**
   * Build a single batch merkle tree, persist tree + leaves + wallet index to DB.
   */
  buildBatch(transfers: TransferLeaf[]): { batchId: number; root: string } {
    console.error(`Building batch with ${transfers.length} transfers...`);
    const prepared = computeBatchArtifacts(transfers);
    return this.persistPreparedBatch(prepared);
  }

  /**
   * Build (or rebuild) the top-level tree from all batch roots for this asset.
   * Height grows dynamically as needed.
   */
  buildTopLevelTree(): { root: string; batchCount: number } {
    const batchRoots = this.db.getAllBatchRoots(this.assetId);
    const batchCount = batchRoots.length;

    if (batchCount === 0) {
      throw new Error('No batches to build top-level tree from');
    }

    // Dynamic height: grow as needed
    const height = Math.max(
      INITIAL_TOP_LEVEL_HEIGHT,
      Math.ceil(Math.log2(Math.max(batchCount, 2))) + 1
    );

    const rootFields = batchRoots.map((b) => Field(BigInt(b.root)));
    const tree = PoseidonMerkleTree.fromLeaves(rootFields, height);

    const lastBatch = this.db.getBatch(batchRoots[batchRoots.length - 1].id);
    if (!lastBatch) throw new Error('Last batch not found');

    const treeJson = JSON.stringify(tree.toJSON());

    this.db.saveSnapshot(
      this.assetId,
      batchCount,
      height,
      tree.getRoot().toString(),
      lastBatch.lastBlock,
      lastBatch.lastLogIndex,
      treeJson
    );

    return {
      root: tree.getRoot().toString(),
      batchCount,
    };
  }
}
