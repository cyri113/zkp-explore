import dotenv from 'dotenv';
dotenv.config();

export const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY ?? '';
export const CHUNK_SIZE = 500_000;
export const CONCURRENCY = 3;

if (!ALCHEMY_API_KEY) {
  throw new Error('Missing ALCHEMY_API_KEY in environment.');
}