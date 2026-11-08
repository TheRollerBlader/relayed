import {spawn, type ChildProcess} from 'node:child_process';

const children: ChildProcess[] = [];
function start(args: string[]) {
  const child = spawn(process.execPath, args, {stdio:'inherit'});
  child.on('exit', code => {
    if (code && code !== 0) shutdown(code);
  });
  children.push(child);
}

function shutdown(code = 0) {
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}

start(['--env-file=.env', '--import', 'tsx', 'services/gateway/index.ts']);
start(['--env-file=.env', '--import', 'tsx', 'services/sandbox/index.ts']);
start(['--import', 'tsx', 'node_modules/vite/bin/vite.js']);

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
