#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();
program
  .name('rarp')
  .description('Local multi-agent orchestration — project scaffold')
  .version('0.1.0');
program.command('about').description('Show implementation status').action(() => {
  console.log('Rarp: TypeScript scaffold ready. Runtime and agent adapters are planned; see docs/PLAN.md.');
});
program.parse();
