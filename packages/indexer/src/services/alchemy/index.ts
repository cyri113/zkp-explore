// services/alchemy/AlchemyService.ts
import { initializeAlchemy, Network } from '@alch/alchemy-sdk';
import { fetchChunk } from './fetchChunk';
import { AssetTransfer } from '../../types/assetTransfer';
import { toHex } from './utils';
import pLimit from 'p-limit';
import { CHUNK_SIZE, CONCURRENCY } from '../../config';

export class AlchemyService {
  private alchemy: any;

  constructor(private apiKey: string, private network: Network) {
    this.alchemy = initializeAlchemy({ apiKey, network });
  }

  /**
   * Fetch all transfers for a contract, chunked by block range with bounded concurrency.
   *
   * @param onPage   - called per API page (max 1000 transfers) for incremental DB inserts
   * @param onChunkDone - called with the highest *contiguously* completed block number,
   *                      safe to use as a resume checkpoint
   * @returns total number of transfers fetched
   */
  async fetchAllTransactions(
    contractAddress: string,
    fromBlockHex: string = '0x0',
    maxPages = 0,
    onPage?: (transfers: AssetTransfer[]) => void,
    onChunkDone?: (safeBlock: number) => void
  ): Promise<number> {
    const rpcUrl = `https://${this.network.toLowerCase().replace('eth_', '')}.g.alchemy.com/v2/${this.apiKey}`;
    const blockRes = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
    });
    const blockJson = await blockRes.json() as { result: string };
    const latestBlock = parseInt(blockJson.result, 16);
    const startBlock = parseInt(fromBlockHex, 16);

    const chunks: Array<{ from: number; to: number }> = [];
    for (let b = startBlock; b <= latestBlock; b += CHUNK_SIZE) {
      chunks.push({ from: b, to: Math.min(b + CHUNK_SIZE - 1, latestBlock) });
    }

    let totalFetched = 0;
    const chunkDone = new Array(chunks.length).fill(false);
    let lastReportedWatermark = -1;
    const limit = pLimit(CONCURRENCY);

    await Promise.all(
      chunks.map((chunk, i) =>
        limit(async () => {
          const transfers = await fetchChunk(
            this.alchemy,
            contractAddress,
            toHex(chunk.from),
            toHex(chunk.to),
            maxPages,
            onPage
          );
          totalFetched += transfers.length;
          chunkDone[i] = true;

          // Compute contiguous watermark: highest block where all prior chunks are done
          if (onChunkDone) {
            let watermark = -1;
            for (let j = 0; j < chunkDone.length; j++) {
              if (!chunkDone[j]) break;
              watermark = chunks[j].to;
            }
            if (watermark > lastReportedWatermark) {
              lastReportedWatermark = watermark;
              onChunkDone(watermark);
            }
          }
        })
      )
    );

    return totalFetched;
  }
}