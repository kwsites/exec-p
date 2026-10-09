import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import debug from 'debug';
import { abortError } from './abort';

const log = debug('@kwsites/exec-p:iterator');
let instances = 0;

export type ExecChannel = 'stdout' | 'stderr';

export interface ExecChunk {
   channel: ExecChannel;
   content: Buffer;
}

export interface ExecExit {
   code: number | null;
   signal: NodeJS.Signals | null;
}

/**
 * What to do with the child process when a consumer leaves the `chunks()` iterator early - either through `break`,
 * `return` or an exception thrown in the body of the `for await` loop.
 *
 * - `kill` (default) sends `killSignal` to the child process.
 * - `keep-running` leaves the child running, it continues to be buffered and a later call to `chunks()` resumes
 *   from the next unread chunk.
 */
export type ExecBreakBehaviour = 'kill' | 'keep-running';

export interface ExecIteratorOptions {
   /** Aborting kills the child process and rejects any further reads from the iterator with an `AbortError`. */
   signal?: AbortSignal;

   /** What to do when the iterator is exited early, see `ExecBreakBehaviour`. */
   onBreak?: ExecBreakBehaviour;

   /**
    * Environment for the child process, used in place of `process.env` (not merged with it). Only own, string-valued
    * properties are passed through.
    */
   env?: Record<string, string | undefined>;

   /** Working directory of the child process. */
   cwd?: string;

   /** Milliseconds after which the child process is sent `killSignal`. */
   timeout?: number;

   /** Signal used when killing the child process for any reason. Defaults to `SIGTERM`. */
   killSignal?: NodeJS.Signals | number;

   /** Hide the console window of the child process on Windows. Defaults to `true`. */
   windowsHide?: boolean;

   /**
    * When set, reading from the child process is paused while more than this many bytes are buffered and not yet
    * consumed by the iterator - the child will block on writing once the OS pipe buffer is full. Defaults to no limit.
    */
   highWaterMark?: number;
}

export interface ExecIteratorStream {
   readonly pid: number | undefined;

   /** Resolves once the child process has exited and its output streams have closed. Never rejects. */
   readonly exit: Promise<ExecExit>;

   /**
    * Iterates the chunks emitted by the child process in the order they were received, including any chunks buffered
    * before iteration started. Only one iterator may be active at a time.
    */
   chunks(): AsyncIterableIterator<ExecChunk>;

   /** Sends a signal to the child process, defaulting to the configured `killSignal`. */
   kill(signal?: NodeJS.Signals | number): boolean;
}

const OPTION_KEYS: ReadonlyArray<keyof ExecIteratorOptions> = [
   'signal', 'onBreak', 'env', 'cwd', 'timeout', 'killSignal', 'windowsHide', 'highWaterMark',
];

/**
 * Spawns `command` with `args` (never through a shell) and resolves with a stream once the process has started.
 * Rejects when the process cannot be started (for example `ENOENT`) or when the `signal` is already aborted.
 */
export function execIterator (
   command: string, args: ReadonlyArray<string> = [], options: ExecIteratorOptions = {},
): Promise<ExecIteratorStream> {
   return new Promise((resolve, reject) => {
      const config = parseOptions(options);
      assertCommand(command, args);

      const id = ++instances;
      const logChild = log.extend(`${id}:child`);
      const logConsumer = log.extend(`${id}:consumer`);

      if (config.signal?.aborted) {
         logChild('signal already aborted, not spawning %s', command);
         return reject(abortError(config.signal));
      }

      logChild('spawning %s with %d argument(s)', command, args.length);
      const child = spawn(command, args, config.spawnOptions);

      child.once('error', (err) => {
         logChild('failed to spawn: %s', err.message);
         reject(err);
      });
      child.once('spawn', () => {
         logChild('spawned pid=%d', child.pid);
         resolve(createStream(child, config, logChild, logConsumer));
      });
   });
}

interface ParsedOptions {
   signal?: AbortSignal;
   onBreak: ExecBreakBehaviour;
   killSignal: NodeJS.Signals | number;
   highWaterMark: number;
   spawnOptions: SpawnOptions;
}

function parseOptions (options: ExecIteratorOptions): ParsedOptions {
   if (!options || typeof options !== 'object') {
      throw new TypeError('execIterator: options must be an object');
   }

   for (const key of Object.keys(options)) {
      if (!OPTION_KEYS.includes(key as keyof ExecIteratorOptions)) {
         throw new TypeError(`execIterator: unsupported option "${key}"`);
      }
   }

   const { signal, onBreak = 'kill', env, cwd, timeout, killSignal = 'SIGTERM', windowsHide = true, highWaterMark = Infinity } = options;

   if (onBreak !== 'kill' && onBreak !== 'keep-running') {
      throw new TypeError(`execIterator: onBreak must be "kill" or "keep-running"`);
   }
   if (cwd !== undefined && (typeof cwd !== 'string' || cwd.includes('\0'))) {
      throw new TypeError('execIterator: cwd must be a string');
   }
   if (timeout !== undefined && !(Number.isInteger(timeout) && timeout >= 0)) {
      throw new TypeError('execIterator: timeout must be a non-negative integer');
   }
   if (typeof killSignal !== 'string' && !Number.isInteger(killSignal)) {
      throw new TypeError('execIterator: killSignal must be a signal name or number');
   }
   if (typeof windowsHide !== 'boolean') {
      throw new TypeError('execIterator: windowsHide must be a boolean');
   }
   if (!(highWaterMark > 0)) {
      throw new TypeError('execIterator: highWaterMark must be a positive number');
   }

   // spawn options are built from an explicit allow-list so nothing like `shell`, `argv0`, `uid`, `detached` or
   // `windowsVerbatimArguments` can reach `child_process.spawn`
   const spawnOptions: SpawnOptions = {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide,
      killSignal,
   };
   if (env !== undefined) spawnOptions.env = parseEnv(env);
   if (cwd !== undefined) spawnOptions.cwd = cwd;
   if (timeout !== undefined) spawnOptions.timeout = timeout;

   return { signal, onBreak, killSignal, highWaterMark, spawnOptions };
}

function parseEnv (env: Record<string, string | undefined>): NodeJS.ProcessEnv {
   if (!env || typeof env !== 'object') {
      throw new TypeError('execIterator: env must be an object');
   }

   const out: NodeJS.ProcessEnv = {};
   for (const key of Object.keys(env)) {
      const value = env[key];
      if (value === undefined) continue;

      if (!key || key.includes('=') || key.includes('\0')) {
         throw new TypeError(`execIterator: invalid environment variable name "${key}"`);
      }
      if (typeof value !== 'string' || value.includes('\0')) {
         throw new TypeError(`execIterator: environment variable "${key}" must be a string`);
      }
      out[key] = value;
   }
   return out;
}

function assertCommand (command: string, args: ReadonlyArray<string>) {
   if (typeof command !== 'string' || !command || command.includes('\0')) {
      throw new TypeError('execIterator: command must be a non-empty string');
   }
   if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
      throw new TypeError('execIterator: args must be an array of strings');
   }
}

interface PendingRead {
   resolve (result: IteratorResult<ExecChunk>): void;
   reject (err: Error): void;
}

function createStream (
   child: ChildProcess, config: ParsedOptions, logChild: debug.Debugger, logConsumer: debug.Debugger,
): ExecIteratorStream {
   const outputs = [child.stdout!, child.stderr!];
   const queue: ExecChunk[] = [];
   let bufferedBytes = 0;
   let paused = false;
   let closed = false;
   let failure: Error | null = null;
   let pending: PendingRead | null = null;
   let consumer: object | null = null;

   const takePending = () => {
      const read = pending;
      pending = null;
      return read;
   };

   const kill = (signal: NodeJS.Signals | number = config.killSignal) => {
      if (closed) return false;
      logChild('sending %s', signal);
      return child.kill(signal);
   };

   const fail = (err: Error) => {
      if (failure) return;
      failure = err;
      queue.length = bufferedBytes = 0;
      takePending()?.reject(err);
   };

   const onAbort = () => {
      logChild('signal aborted');
      fail(abortError(config.signal!));
      kill();
   };
   config.signal?.addEventListener('abort', onAbort, { once: true });

   const setPaused = (pause: boolean) => {
      if (pause === paused) return;
      paused = pause;
      logChild('%s reading output, %d bytes buffered', pause ? 'pausing' : 'resuming', bufferedBytes);
      outputs.forEach(output => pause ? output.pause() : output.resume());
   };

   const receive = (channel: ExecChannel) => (content: Buffer) => {
      logChild('%s: %d bytes', channel, content.length);
      if (failure) return;

      const chunk = { channel, content };
      const read = takePending();
      if (read) {
         return read.resolve({ value: chunk, done: false });
      }

      queue.push(chunk);
      bufferedBytes += content.length;
      setPaused(bufferedBytes > config.highWaterMark);
   };

   child.stdout!.on('data', receive('stdout'));
   child.stderr!.on('data', receive('stderr'));
   outputs.forEach(output => output.on('error', fail));
   child.on('error', fail);

   const exit = new Promise<ExecExit>(done => {
      child.once('close', (code, signal) => {
         logChild('closed code=%s signal=%s', code, signal);
         closed = true;
         config.signal?.removeEventListener('abort', onAbort);
         takePending()?.resolve({ value: undefined, done: true });
         done({ code, signal });
      });
   });

   const chunks = (): AsyncIterableIterator<ExecChunk> => {
      if (consumer) {
         throw new Error('execIterator: chunks() is already being iterated');
      }

      const self = consumer = {};
      const isActive = () => consumer === self;
      logConsumer('started, %d chunk(s) buffered', queue.length);

      const release = () => {
         if (!isActive()) return;
         consumer = null;
         takePending()?.resolve({ value: undefined, done: true });
      };

      const iterator: AsyncIterableIterator<ExecChunk> = {
         [Symbol.asyncIterator] () {
            return iterator;
         },

         next () {
            if (!isActive()) {
               return Promise.resolve({ value: undefined, done: true });
            }
            if (failure) {
               logConsumer('read failed: %s', failure.message);
               release();
               return Promise.reject(failure);
            }
            if (pending) {
               return Promise.reject(new Error('execIterator: next() called before the previous read resolved'));
            }

            const chunk = queue.shift();
            if (chunk) {
               bufferedBytes -= chunk.content.length;
               setPaused(bufferedBytes > config.highWaterMark);
               logConsumer('read %s: %d bytes (buffered)', chunk.channel, chunk.content.length);
               return Promise.resolve({ value: chunk, done: false });
            }

            if (closed) {
               logConsumer('done');
               release();
               return Promise.resolve({ value: undefined, done: true });
            }

            return new Promise<IteratorResult<ExecChunk>>((resolve, reject) => {
               pending = {
                  resolve (result) {
                     if (result.done) {
                        logConsumer('done');
                        release();
                     }
                     else {
                        logConsumer('read %s: %d bytes', result.value.channel, result.value.content.length);
                     }
                     resolve(result);
                  },
                  reject (err) {
                     logConsumer('read failed: %s', err.message);
                     release();
                     reject(err);
                  },
               };
            });
         },

         return () {
            if (isActive()) {
               logConsumer('exited early, onBreak=%s', config.onBreak);
               release();
               if (config.onBreak === 'kill') {
                  kill();
               }
            }
            return Promise.resolve({ value: undefined, done: true });
         },
      };

      return iterator;
   };

   return {
      get pid () {
         return child.pid;
      },
      exit,
      chunks,
      kill,
   };
}
