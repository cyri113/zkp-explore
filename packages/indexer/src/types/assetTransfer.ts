export type AssetTransfer = Readonly<{
  uniqueId: string;
  hash: string;
  from: string;
  to: string | null;
  value: string;
  asset: string | null;
  category: string;
  blockNum: string;
  metadata?: unknown;
}>;