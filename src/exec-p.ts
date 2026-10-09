import { spawn, SpawnOptions } from 'child_process';
import { abortError } from './abort';

/**
 * Spawns a child process to run the specified command. When there is a non-zero exit code, and there has been
 * output to `stderr` the resulting promise will throw and must be caught by the caller.
 *
 * The promise also rejects when the process cannot be spawned, or with an `AbortError` when `options.signal` is
 * aborted - in which case the child process is sent `options.killSignal` (default `SIGTERM`).
 *
 * @returns {Promise<string>}
 */
export function execP (command: string, params: string[] = [], options: SpawnOptions = {}): Promise<string> {
   const { signal, ...spawnOptions } = options;

   return new Promise((ok, fail) => {

      if (signal?.aborted) {
         return fail(abortError(signal));
      }

      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const spawned = spawn(command, params, spawnOptions);

      const onAbort = () => {
         fail(abortError(signal!));
         spawned.kill(spawnOptions.killSignal);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      spawned.stdout?.on('data', data => out.push(data));
      spawned.stderr?.on('data', data => err.push(data));

      spawned.on('error', e => {
         signal?.removeEventListener('abort', onAbort);
         fail(e);
      });

      spawned.on('close', (exitCode) => {
         signal?.removeEventListener('abort', onAbort);
         if (exitCode && err.length) {
            return fail(new Error(Buffer.concat(err).toString('utf-8')));
         }

         ok(Buffer.concat(out).toString('utf-8'));
      });

   });
}
