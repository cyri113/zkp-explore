import http from 'http';
import { MerkleDb } from './MerkleDb';
import { BatchBuilder } from './BatchBuilder';
import { QueryService } from './QueryService';
import { BATCH_SIZE } from './types';

const PORT = Number(process.env.MERKLE_PORT || 3002);
const INDEXER_URL = process.env.INDEXER_URL || 'http://localhost:3001';
const MERKLE_BATCH_CONCURRENCY = Math.max(
  1,
  Math.min(32, Number(process.env.MERKLE_BATCH_CONCURRENCY || 1))
);

function parseIndexerFetchPageSize(): number | undefined {
  const raw = process.env.MERKLE_FETCH_PAGE_SIZE;
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 100) return undefined;
  return Math.min(50_000, Math.floor(n));
}

const db = new MerkleDb();
const queryService = new QueryService(db);

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

function requireAssetId(url: URL): number | null {
  const raw = url.searchParams.get('asset_id');
  if (raw == null) return null;
  const n = Number(raw);
  return isNaN(n) ? null : n;
}

// Match /wallet/:address/transfers
const walletPattern = /^\/wallet\/([^/]+)\/transfers$/;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const method = req.method || 'GET';

  try {
    // POST /tree/build?asset_id=N — fetch from indexer and build hierarchical tree for an asset
    if (method === 'POST' && url.pathname === '/tree/build') {
      const assetId = requireAssetId(url);
      if (assetId == null) return error(res, 'Missing or invalid ?asset_id= parameter');

      const builder = new BatchBuilder(
        db,
        assetId,
        BATCH_SIZE,
        MERKLE_BATCH_CONCURRENCY,
        parseIndexerFetchPageSize()
      );
      const result = await builder.buildFromIndexer(INDEXER_URL, (info) => {
        console.error(
          `[Build] Asset ${assetId} | Batch ${info.batchesBuilt} | ${info.leavesProcessed.toLocaleString()}/${info.totalTransactions.toLocaleString()} leaves | ${info.ratePerSec.toLocaleString()} leaves/s`
        );
      });
      return json(res, { assetId, ...result });
    }

    // GET /wallet/:address/transfers?asset_id=N&block=B
    const walletMatch = url.pathname.match(walletPattern);
    if (method === 'GET' && walletMatch) {
      const wallet = walletMatch[1];
      const assetId = requireAssetId(url);
      if (assetId == null) return error(res, 'Missing or invalid ?asset_id= parameter');

      const blockStr = url.searchParams.get('block');
      if (!blockStr) return error(res, 'Missing ?block= parameter');
      const blockNumber = Number(blockStr);
      if (isNaN(blockNumber)) return error(res, 'Invalid block number');

      const result = queryService.getWalletTransfersAtBlock(assetId, wallet, blockNumber);
      return json(res, result);
    }

    // GET /tree/summary?asset_id=N
    if (method === 'GET' && url.pathname === '/tree/summary') {
      const assetId = requireAssetId(url);
      if (assetId == null) return error(res, 'Missing or invalid ?asset_id= parameter');

      const snapshot = db.getLatestSnapshot(assetId);
      if (!snapshot) return error(res, 'No tree built yet for this asset. POST /tree/build first.', 404);

      const batchRoots = db.getAllBatchRoots(assetId);
      return json(res, {
        assetId,
        batchCount: snapshot.batchCount,
        treeHeight: snapshot.treeHeight,
        root: snapshot.root,
        throughBlock: snapshot.throughBlock,
        batchRoots: batchRoots.map((b) => ({ id: b.id, root: b.root })),
      });
    }

    // GET /tree/proof?batch=B&leaf=L
    if (method === 'GET' && url.pathname === '/tree/proof') {
      const batchId = Number(url.searchParams.get('batch'));
      const leafIndex = Number(url.searchParams.get('leaf'));
      if (isNaN(batchId) || isNaN(leafIndex)) {
        return error(res, 'Missing or invalid ?batch= and ?leaf= parameters');
      }

      const proof = queryService.getBatchLeafProof(batchId, leafIndex);
      if (!proof) return error(res, 'Batch or leaf not found', 404);
      return json(res, proof);
    }

    // GET /health
    if (method === 'GET' && url.pathname === '/health') {
      return json(res, {
        status: 'ok',
        service: 'merkle',
      });
    }

    error(res, 'Not found', 404);
  } catch (err) {
    console.error('[Merkle] Error:', err);
    error(res, (err as Error).message, 500);
  }
});

server.listen(PORT, () => {
  console.log(`[Merkle] Listening on :${PORT}`);
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
