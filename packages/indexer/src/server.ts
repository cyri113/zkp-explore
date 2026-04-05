import http from 'http';
import { IndexerDb } from './db';

const PORT = Number(process.env.INDEXER_PORT || 3001);

const db = new IndexerDb();

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

/** Parse optional asset_id from query params (number or undefined) */
function parseAssetId(url: URL): number | undefined {
  const raw = url.searchParams.get('asset_id');
  if (raw == null) return undefined;
  const n = Number(raw);
  return isNaN(n) ? undefined : n;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const method = req.method || 'GET';

  try {
    // GET /assets — list all indexed assets
    if (method === 'GET' && url.pathname === '/assets') {
      const assets = db.getAssets();
      return json(res, { assets });
    }

    // GET /transactions/count?asset_id=ID (optional)
    if (method === 'GET' && url.pathname === '/transactions/count') {
      const assetId = parseAssetId(url);
      const count = db.getTransactionCount(assetId);
      return json(res, { count, assetId: assetId ?? null });
    }

    // GET /transactions?asset_id=ID&page_size=N&after_block=B&after_log=L
    if (method === 'GET' && url.pathname === '/transactions') {
      const assetId = parseAssetId(url);
      const pageSize = Number(url.searchParams.get('page_size') || '1000');
      const afterBlock = Number(url.searchParams.get('after_block') ?? '-1');
      const afterLog = Number(url.searchParams.get('after_log') ?? '-1');

      const page = db.getTransactionPage(pageSize, afterBlock, afterLog, assetId);
      return json(res, { ...page, assetId: assetId ?? null });
    }

    // GET /health
    if (method === 'GET' && url.pathname === '/health') {
      return json(res, { status: 'ok', service: 'indexer' });
    }

    error(res, 'Not found', 404);
  } catch (err) {
    console.error('[Indexer] Error:', err);
    error(res, (err as Error).message, 500);
  }
});

server.listen(PORT, () => {
  const count = db.getTransactionCount();
  const assets = db.getAssets();
  console.log(`[Indexer] Listening on :${PORT} (${count.toLocaleString()} transactions, ${assets.length} assets)`);
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
