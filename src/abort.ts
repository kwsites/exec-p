export function abortError (signal: AbortSignal): Error {
   return Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
      cause: signal.reason,
   });
}
