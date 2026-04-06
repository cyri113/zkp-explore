import { readFileSync, writeFileSync } from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Field, Poseidon } from 'o1js';
import {
  PoseidonMerkleTree,
  transferToLeafHash,
  TransferLeaf,
  BATCH_TREE_HEIGHT,
  TOP_TREE_HEIGHT,
} from '@zkp/merkle';
import {
  SnapshotMembership,
  SnapshotMembershipProof,
} from './SnapshotMembership';
import {
  transferLeafToCircuit,
  batchWitnessToCircuit,
  topWitnessToCircuit,
} from './proofAdapters';

interface ProveInput {
  /** Top-level (snapshot) root the proof is anchored to. */
  snapshotRoot: string;
  /** Private EVM transfer leaf. */
  leaf: TransferLeaf;
  /** Path leaf → batchRoot, length BATCH_TREE_HEIGHT - 1. */
  batchSiblings: Array<{ isLeft: boolean; sibling: string }>;
  /** Path batchRoot → snapshotRoot, length TOP_TREE_HEIGHT - 1. */
  topSiblings: Array<{ isLeft: boolean; sibling: string }>;
}

function argvForYargs(): string[] {
  return hideBin(process.argv).filter((a) => a !== '--');
}

function parseFieldString(s: string): Field {
  return Field(BigInt(s));
}

function readJson<T>(path: string): T {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as T;
}

async function runProve(inPath: string, outPath: string): Promise<void> {
  const input = readJson<ProveInput>(inPath);

  if (
    !input.snapshotRoot ||
    !input.leaf ||
    !Array.isArray(input.batchSiblings) ||
    !Array.isArray(input.topSiblings)
  ) {
    throw new Error(
      `Invalid input file: expected { snapshotRoot, leaf, batchSiblings, topSiblings } in ${inPath}`
    );
  }

  const expectedBatchSiblings = BATCH_TREE_HEIGHT - 1;
  const expectedTopSiblings = TOP_TREE_HEIGHT - 1;
  if (input.batchSiblings.length !== expectedBatchSiblings) {
    throw new Error(
      `Expected batchSiblings.length === ${expectedBatchSiblings} (BATCH_TREE_HEIGHT - 1), got ${input.batchSiblings.length}`
    );
  }
  if (input.topSiblings.length !== expectedTopSiblings) {
    throw new Error(
      `Expected topSiblings.length === ${expectedTopSiblings} (TOP_TREE_HEIGHT - 1), got ${input.topSiblings.length}`
    );
  }

  const snapshotRoot = parseFieldString(input.snapshotRoot);
  const leafHash = transferToLeafHash(input.leaf);

  const batchWitnessPlain = input.batchSiblings.map(({ isLeft, sibling }) => ({
    isLeft,
    sibling: Field(BigInt(sibling)),
  }));
  const topWitnessPlain = input.topSiblings.map(({ isLeft, sibling }) => ({
    isLeft,
    sibling: Field(BigInt(sibling)),
  }));

  // Off-circuit sanity check: leaf → batchRoot → snapshotRoot.
  let cursor = leafHash;
  for (const { isLeft, sibling } of batchWitnessPlain) {
    cursor = isLeft
      ? Poseidon.hash([cursor, sibling])
      : Poseidon.hash([sibling, cursor]);
  }
  const computedBatchRoot = cursor;
  for (const { isLeft, sibling } of topWitnessPlain) {
    cursor = isLeft
      ? Poseidon.hash([cursor, sibling])
      : Poseidon.hash([sibling, cursor]);
  }
  if (!cursor.equals(snapshotRoot).toBoolean()) {
    throw new Error(
      'Pre-flight check failed: leaf + batchSiblings + topSiblings do not derive the provided snapshotRoot. Refusing to run the circuit.'
    );
  }
  // computedBatchRoot is just for clarity above; lint will see it as used.
  void computedBatchRoot;

  process.stderr.write('Compiling SnapshotMembership… (first run is slow)\n');
  await SnapshotMembership.compile();

  const leafCircuit = transferLeafToCircuit(input.leaf);
  const batchWitnessCircuit = batchWitnessToCircuit(input.batchSiblings);
  const topWitnessCircuit = topWitnessToCircuit(input.topSiblings);

  process.stderr.write('Generating proof…\n');
  const { proof } = await SnapshotMembership.prove(
    snapshotRoot,
    leafCircuit,
    batchWitnessCircuit,
    topWitnessCircuit
  );

  process.stderr.write('Verifying proof…\n');
  const verified = await SnapshotMembership.verify(proof);

  const output = {
    verified,
    snapshotRoot: snapshotRoot.toString(),
    proof: proof.toJSON(),
  };

  writeFileSync(outPath, JSON.stringify(output, null, 2));
  process.stderr.write(
    `✓ proved | verified=${verified} | out=${outPath}\n`
  );

  if (!verified) process.exit(1);
}

async function runVerify(proofPath: string): Promise<void> {
  const parsed = readJson<{
    verified?: boolean;
    snapshotRoot: string;
    proof: unknown;
  }>(proofPath);

  if (!parsed.proof || !parsed.snapshotRoot) {
    throw new Error(
      `Invalid proof file: expected { snapshotRoot, proof } in ${proofPath}`
    );
  }

  process.stderr.write('Compiling SnapshotMembership… (first run is slow)\n');
  await SnapshotMembership.compile();

  const proof = await SnapshotMembershipProof.fromJSON(parsed.proof as any);
  const verified = await SnapshotMembership.verify(proof);

  process.stdout.write(
    JSON.stringify({ verified, snapshotRoot: parsed.snapshotRoot }) + '\n'
  );

  if (!verified) process.exit(1);
}

yargs(argvForYargs())
  .command(
    'prove',
    'Generate a ZK snapshot-membership proof from a JSON input file',
    (y) =>
      y
        .option('in', {
          type: 'string',
          demandOption: true,
          describe:
            'Path to input JSON with { snapshotRoot, leaf, batchSiblings, topSiblings }',
        })
        .option('out', {
          type: 'string',
          demandOption: true,
          describe: 'Path to write the proof JSON to',
        }),
    async (argv) => {
      try {
        await runProve(argv.in as string, argv.out as string);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exit(1);
      }
    }
  )
  .command(
    'verify',
    'Verify a previously generated proof JSON file',
    (y) =>
      y.option('proof', {
        type: 'string',
        demandOption: true,
        describe: 'Path to the proof JSON file produced by `prove`',
      }),
    async (argv) => {
      try {
        await runVerify(argv.proof as string);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exit(1);
      }
    }
  )
  .demandCommand(1)
  .strict()
  .help()
  .parse();
