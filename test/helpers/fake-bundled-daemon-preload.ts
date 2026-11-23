// Loaded with `node --import` ahead of start.ts. lib/daemon.ts binds spawn from
// node:child_process at import time, so patching the builtin first (as test/daemon.test.ts
// does) makes its bundled daemon spawn run fake-bundled-daemon.ts instead of bitsocial-cli.
import childProcess from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import path from 'node:path'

const realSpawn = childProcess.spawn
childProcess.spawn = ((command: string, args: string[] = [], options: any = {}) => {
  if (args[1] === 'daemon') {
    return realSpawn(command, [path.join(import.meta.dirname, 'fake-bundled-daemon.ts'), ...args.slice(1)], options)
  }
  return realSpawn(command, args, options)
}) as typeof childProcess.spawn
syncBuiltinESMExports()
