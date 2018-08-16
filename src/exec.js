
const {spawn} = require('child_process');

/**
 *
 * @param command
 * @param params
 * @returns {Promise<string>}
 */
module.exports = function exec (command, ...params) {
   return new Promise((ok, fail) => {

      const out = [];
      const err = [];
      const spawned = spawn(command, params, {});

      spawned.stdout.on('data', data => out.push(data));
      spawned.stderr.on('data', data => err.push(data));

      spawned.on('error', err => err.push(new Buffer(err.stack, 'ascii')));

      spawned.on('exit', (exitCode, exitSignal) => {
         if (exitCode && err.length) {
            return fail(new Error(Buffer.concat(err).toString('utf-8')));
         }

         ok(Buffer.concat(out).toString('utf-8'));
      });

   });
};
