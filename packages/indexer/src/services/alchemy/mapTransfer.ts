// services/alchemy/mapTransfer.ts
import { AssetTransfer } from '../../types/assetTransfer';

export function mapTransfer(transfer: any): AssetTransfer {
  return {
    uniqueId: transfer.uniqueId,
    hash: transfer.hash,
    from: transfer.from,
    to: transfer.to || null,
    value: transfer.value?.toString() ?? '0',
    asset: transfer.asset ?? null,
    category: transfer.category,
    blockNum: transfer.blockNum,
    metadata: transfer.metadata,
  };
}