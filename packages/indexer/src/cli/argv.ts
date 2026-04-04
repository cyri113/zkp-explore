import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

interface CLIArgs {
  contractAddress: string;
  network: string;
  maxPages: number;
  reset: boolean;
}

// Build yargs
const argv = yargs(hideBin(process.argv))
  .scriptName('sync')
  .usage('$0 <contractAddress> [options]')
  .positional('contractAddress', {
    describe: 'Token/contract address to fetch transfers for',
    type: 'string',
    demandOption: true,
  })
  .option('network', {
    type: 'string',
    default: 'eth-mainnet',
    describe: 'Ethereum network (eth-mainnet, goerli, sepolia)',
  })
  .option('maxPages', {
    type: 'number',
    default: 0,
    describe: 'Max pages per chunk (0 = unlimited)',
  })
  .option('reset', {
    type: 'boolean',
    default: false,
    describe: 'Clear existing data and start from scratch',
  })
  .strict()
  .help()
  .parseSync() as CLIArgs;

export default argv;