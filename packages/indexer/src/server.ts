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

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const method = req.method || 'GET';

  try {
    // GET /transactions/count
    if (method === 'GET' && url.pathname === '/transactions/count') {
      const count = db.getTransactionCount();
      return json(res, { count });
    }

    // GET /transactions?page_size=N&after_block=B&after_log=L
    if (method === 'GET' && url.pathname === '/transactions') {
      const pageSize = Number(url.searchParams.get('page_size') || '1000');
      const afterBlock = Number(url.searchParams.get('after_block') ?? '-1');
      const afterLog = Number(url.searchParams.get('after_log') ?? '-1');

      const page = db.getTransactionPage(pageSize, afterBlock, afterLog);
      return json(res, page);
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
  console.log(`[Indexer] Listening on :${PORT} (${count.toLocaleString()} transactions)`);
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
