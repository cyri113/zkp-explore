import { TransactionDb, RawTransaction } from '@zkp/db';
import { HashTree, evmTransferToLeaf, EvmTransferEvent, hashLeaf } from '@zkp/merkle';
import fs from 'fs';

function rawToEvmTransferEvent(raw: RawTransaction): EvmTransferEvent {
  const blockNum = raw.blockNum as string;
  const blockNumber = Number(BigInt(blockNum));

  const uniqueId = raw.uniqueId as string;
  const parts = uniqueId.split(':');
  const logIndex = Number(parts[parts.length - 1]);

  const metadata = raw.metadata as { blockTimestamp?: string } | undefined;
  const blockTimestamp = metadata?.blockTimestamp
    ? Math.floor(new Date(metadata.blockTimestamp).getTime() / 1000)
    : 0;

  return {
    transactionHash: raw.hash as string,
    logIndex,
    blockNumber,
    blockTimestamp,
    from: raw.from as string,
    to: (raw.to as string) || '0x0000000000000000000000000000000000000000',
    value: BigInt(Math.trunc(Number(raw.value as string || '0'))),
  };
}

const LOG_INTERVAL = 50_000;

function buildTree(db: TransactionDb): HashTree {
  const total = db.getTransactionCount();
  const tree = new HashTree(20);
  const startTime = Date.now();
  let leafCount = 0;

  console.error(`[Tree] Streaming ${total.toLocaleString()} rows (keyset pagination)...`);

  let dbMs = 0;
  let convertMs = 0;
  let hashMs = 0;
  let treeMs = 0;
  let batchDbMs = 0;

  // Track DB time at page boundaries via a wrapper
  const iter = db.iterateTransactionsOrdered();

  for (const raw of iter) {
    let t0 = Date.now();
    const event = rawToEvmTransferEvent(raw);
    convertMs += Date.now() - t0;

    t0 = Date.now();
    const leaf = evmTransferToLeaf(event);
    hashMs += Date.now() - t0;

    t0 = Date.now();
    tree.addLeaf(leaf);
    treeMs += Date.now() - t0;

    leafCount++;

    if (leafCount % LOG_INTERVAL === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const pct = ((leafCount / total) * 100).toFixed(1);
      const rate = Math.round(leafCount / ((Date.now() - startTime) / 1000));
      const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

      console.error(
        `[Tree] ${leafCount.toLocaleString()}/${total.toLocaleString()} (${pct}%) | ` +
        `${rate.toLocaleString()} leaves/s | ${mem}MB heap | ${elapsed}s elapsed\n` +
        `       convert ${convertMs}ms | poseidon ${hashMs}ms | tree ${treeMs}ms`
      );
    }
  }

  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  console.error(`[Tree] Done: ${leafCount.toLocaleString()} leaves in ${totalSec}s | ${mem}MB heap`);
  return tree;
}

function parseTimestamp(input: string): number {
  const asNum = Number(input);
  if (!isNaN(asNum) && asNum > 1_000_000) return asNum;
  const ms = new Date(input).getTime();
  if (isNaN(ms)) throw new Error(`Invalid timestamp: ${input}`);
  return Math.floor(ms / 1000);
}

if (require.main === module) {
  const args = process.argv.slice(2);

  let queryTimestamp: string | undefined;
  let proveId: string | undefined;
  let savePath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--query' && args[i + 1]) {
      queryTimestamp = args[++i];
    } else if (args[i] === '--prove' && args[i + 1]) {
      proveId = args[++i];
    } else if (args[i] === '--save' && args[i + 1]) {
      savePath = args[++i];
    }
  }

  const db = new TransactionDb();
  try {
    const total = db.getTransactionCount();
    if (total === 0) {
      console.error('No transactions found in database.');
      process.exit(1);
    }

    console.error(`[Tree] Building from ${total} transactions...`);
    const tree = buildTree(db);
    const snapshots = tree.getSnapshots();
    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];

    console.error(`[Tree] ${snapshots.length} leaves, root: ${tree.getRoot().toString()}`);
    console.error(`[Tree] Time range: ${new Date(first.timestamp * 1000).toISOString()} → ${new Date(last.timestamp * 1000).toISOString()}`);

    if (queryTimestamp) {
      const ts = parseTimestamp(queryTimestamp);
      const root = tree.getRootAt(ts);
      console.log(JSON.stringify({ timestamp: ts, root: root.toString() }, null, 2));
    }

    if (proveId) {
      // Accept txHash:logIndex format, convert to txHash-logIndex (leaf id format)
      const leafId = proveId.replace(':', '-');
      const leafIndex = tree.getLeafIndex(leafId);
      if (leafIndex === undefined) {
        console.error(`Leaf not found: ${leafId}`);
        process.exit(1);
      }

      const witness = tree.getWitness(leafIndex);
      const witnessPath = witness.map(({ isLeft, sibling }: { isLeft: boolean; sibling: { toString(): string } }) => ({
        isLeft,
        sibling: sibling.toString(),
      }));

      console.log(JSON.stringify({ leafId, leafIndex: Number(leafIndex), witness: witnessPath }, null, 2));
    }

    if (savePath) {
      fs.writeFileSync(savePath, tree.toJSON());
      console.error(`[Tree] Saved to ${savePath}`);
    }

    if (!queryTimestamp && !proveId && !savePath) {
      console.log(JSON.stringify({
        leafCount: snapshots.length,
        root: tree.getRoot().toString(),
        firstTimestamp: first.timestamp,
        lastTimestamp: last.timestamp,
        firstDate: new Date(first.timestamp * 1000).toISOString(),
        lastDate: new Date(last.timestamp * 1000).toISOString(),
      }, null, 2));
    }
  } finally {
    db.close();
  }
}

export { rawToEvmTransferEvent, buildTree };
