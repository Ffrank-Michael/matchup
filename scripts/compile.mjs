// Compiles the contracts with the same settings as foundry.toml (solc 0.8.28, cancun,
// optimizer on, 200 runs) so the deploy script does not need Foundry on this PC.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const solc = require('solc');

const FILES = [
  'contracts/PredictionArena.sol',
  'contracts/interfaces/AggregatorV3Interface.sol',
  'contracts/mocks/MockPriceFeed.sol',
];

export function compile() {
  if (solc.version().indexOf('0.8.28') !== 0) throw new Error('Expected solc 0.8.28, got ' + solc.version());
  const sources = {};
  for (const f of FILES) sources[f] = { content: fs.readFileSync(path.join(ROOT, f), 'utf8') };
  const ozDir = path.join(ROOT, 'node_modules', '@openzeppelin', 'contracts') + path.sep;

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      outputSelection: {
        '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] },
      },
    },
  };
  const findImports = (p) => {
    const prefix = '@openzeppelin/contracts/';
    if (p.startsWith(prefix)) {
      const f = path.join(ozDir, p.slice(prefix.length));
      if (fs.existsSync(f)) return { contents: fs.readFileSync(f, 'utf8') };
    }
    if (sources[p]) return { contents: sources[p].content };
    return { error: 'File not found: ' + p };
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error('Compile failed:\n' + errors.map((e) => e.formattedMessage).join('\n'));

  const pick = (file, name) => {
    const c = out.contracts[file][name];
    return {
      abi: c.abi,
      bytecode: '0x' + c.evm.bytecode.object,
      deployedBytecode: '0x' + c.evm.deployedBytecode.object,
      immutableReferences: c.evm.deployedBytecode.immutableReferences || {},
    };
  };
  // Standard JSON input listing every source file the build used (OpenZeppelin included), for
  // verifying the source on the block explorer.
  const used = {};
  for (const name of Object.keys(out.sources)) used[name] = { content: findImports(name).contents };
  const standardInput = {
    language: 'Solidity',
    sources: used,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'evm.methodIdentifiers', 'metadata'] } },
    },
  };
  return {
    standardInput,
    arena: pick('contracts/PredictionArena.sol', 'PredictionArena'),
    feed: pick('contracts/mocks/MockPriceFeed.sol', 'MockPriceFeed'),
  };
}

/** Runtime code with the compiler's metadata tail and the immutable slots zeroed, so code compiled
 *  here can be compared with code deployed elsewhere (which has its own constructor values). */
export function normalise(hex, immutableReferences) {
  let bytes = Buffer.from(hex.slice(2), 'hex');
  const metaLen = bytes.readUInt16BE(bytes.length - 2) + 2;
  bytes = bytes.subarray(0, bytes.length - metaLen);
  for (const refs of Object.values(immutableReferences)) {
    for (const { start, length } of refs) bytes.fill(0, start, start + length);
  }
  return bytes.toString('hex');
}
