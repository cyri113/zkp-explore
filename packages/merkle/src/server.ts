import http from 'http';
import { HashTree } from './HashTree';
import { MerkleDb } from './MerkleDb';
import { evmTransferToLeaf, rawToEvmTransferEvent, RawAlchemyTransfer } from './adapters/evm';

const PORT = Number(process.env.MERKLE_PORT || 3002);
const INDEXER_URL = process.env.INDEXER_URL || 'http://localhost:3001';

const merkleDb = new MerkleDb();

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

async function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    }).on('error', reject);
  });
}

function loadTreeFromDb(): HashTree | null {
  const saved = merkleDb.getLatestTree();
  if (!saved) return null;
  return HashTree.fromJSON(saved.treeJson);
}

async function buildTreeFromIndexer(): Promise<HashTree> {
  const countRes = await fetchJson(`${INDEXER_URL}/transactions/count`) as { count: number };
  const total = countRes.count;
  console.error(`[Merkle] Building tree from ${total.toLocaleString()} indexer transactions...`);

  const tree = new HashTree(20);
  const PAGE_SIZE = 10_000;
  let afterBlock = -1;
  let afterLog = -1;
  let leafCount = 0;
  const startTime = Date.now();

  while (true) {
    const page = await fetchJson(
      `${INDEXER_URL}/transactions?page_size=${PAGE_SIZE}&after_block=${afterBlock}&after_log=${afterLog}`
    ) as { transactions: RawAlchemyTransfer[]; lastBlock: number; lastLog: number };

    if (page.transactions.length === 0) break;

    for (const raw of page.transactions) {
      const event = rawToEvmTransferEvent(raw);
      tree.addLeaf(evmTransferToLeaf(event));
      leafCount++;
    }

    afterBlock = page.lastBlock;
    afterLog = page.lastLog;

    const pct = total > 0 ? ((leafCount / total) * 100).toFixed(1) : '?';
    const rate = Math.round(leafCount / ((Date.now() - startTime) / 1000));
    console.error(`[Merkle] ${leafCount.toLocaleString()}/${total.toLocaleString()} (${pct}%) | ${rate.toLocaleString()} leaves/s`);
  }

  // Persist to merkle.db
  const snapshots = tree.getSnapshots();
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  merkleDb.saveTree(
    leafCount,
    tree.getRoot().toString(),
    first?.timestamp ?? 0,
    last?.timestamp ?? 0,
    tree.toJSON()
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`[Merkle] Done: ${leafCount.toLocaleString()} leaves in ${elapsed}s, root: ${tree.getRoot().toString()}`);
  return tree;
}

// In-memory cached tree (loaded from DB or built on demand)
let cachedTree: HashTree | null = loadTreeFromDb();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const method = req.method || 'GET';

  try {
    // POST /tree/build — fetch from indexer and build tree
    if (method === 'POST' && url.pathname === '/tree/build') {
      cachedTree = await buildTreeFromIndexer();
      const snapshots = cachedTree.getSnapshots();
      return json(res, {
        leafCount: snapshots.length,
        root: cachedTree.getRoot().toString(),
        firstTimestamp: snapshots[0]?.timestamp,
        lastTimestamp: snapshots[snapshots.length - 1]?.timestamp,
      });
    }

    // GET /tree/summary
    if (method === 'GET' && url.pathname === '/tree/summary') {
      if (!cachedTree) return error(res, 'No tree built yet. POST /tree/build first.', 404);
      const snapshots = cachedTree.getSnapshots();
      const first = snapshots[0];
      const last = snapshots[snapshots.length - 1];
      return json(res, {
        leafCount: snapshots.length,
        root: cachedTree.getRoot().toString(),
        firstTimestamp: first.timestamp,
        lastTimestamp: last.timestamp,
        firstDate: new Date(first.timestamp * 1000).toISOString(),
        lastDate: new Date(last.timestamp * 1000).toISOString(),
      });
    }

    // GET /tree/root?timestamp=T
    if (method === 'GET' && url.pathname === '/tree/root') {
      if (!cachedTree) return error(res, 'No tree built yet. POST /tree/build first.', 404);
      const ts = Number(url.searchParams.get('timestamp'));
      if (!ts) return error(res, 'Missing ?timestamp= parameter');
      const root = cachedTree.getRootAt(ts);
      return json(res, { timestamp: ts, root: root.toString() });
    }

    // GET /tree/proof?id=txHash-logIndex
    if (method === 'GET' && url.pathname === '/tree/proof') {
      if (!cachedTree) return error(res, 'No tree built yet. POST /tree/build first.', 404);
      const leafId = url.searchParams.get('id');
      if (!leafId) return error(res, 'Missing ?id= parameter');

      const leafIndex = cachedTree.getLeafIndex(leafId);
      if (leafIndex === undefined) return error(res, `Leaf not found: ${leafId}`, 404);

      const witness = cachedTree.getWitness(leafIndex);
      const witnessPath = witness.map(({ isLeft, sibling }: { isLeft: boolean; sibling: { toString(): string } }) => ({
        isLeft,
        sibling: sibling.toString(),
      }));

      return json(res, { leafId, leafIndex: Number(leafIndex), witness: witnessPath });
    }

    // GET /health
    if (method === 'GET' && url.pathname === '/health') {
      return json(res, { status: 'ok', service: 'merkle', hasTree: !!cachedTree });
    }

    error(res, 'Not found', 404);
  } catch (err) {
    console.error('[Merkle] Error:', err);
    error(res, (err as Error).message, 500);
  }
});

server.listen(PORT, () => {
  console.log(`[Merkle] Listening on :${PORT} (tree ${cachedTree ? 'loaded from DB' : 'not built yet'})`);
});

process.on('SIGINT', () => {
  merkleDb.close();
  process.exit(0);
});
