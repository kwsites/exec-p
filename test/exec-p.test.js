const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execP } = require('../dist');

const node = process.execPath;
const script = (source) => ['-e', source];

describe('execP', () => {

   it('resolves with stdout', async () => {
      assert.strictEqual(await execP(node, script(`console.log('hello')`)), 'hello\n');
   });

   it('resolves with stdout when exiting non-zero without stderr', async () => {
      assert.strictEqual(await execP(node, script(`console.log('partial'); process.exit(2)`)), 'partial\n');
   });

   it('rejects with stderr when exiting non-zero', async () => {
      await assert.rejects(
         execP(node, script(`process.stderr.write('bad thing'); process.exit(1)`)),
         { message: 'bad thing' },
      );
   });

   it('resolves when writing to stderr and exiting zero', async () => {
      assert.strictEqual(await execP(node, script(`console.error('warning'); console.log('ok')`)), 'ok\n');
   });

   it('collects all output from large writes', async () => {
      const out = await execP(node, script(`process.stdout.write('x'.repeat(1024 * 1024))`));
      assert.strictEqual(out.length, 1024 * 1024);
   });

   it('passes spawn options through', async () => {
      const out = await execP(node, script(`console.log(process.env.EXEC_P_TEST + ':' + process.cwd())`), {
         env: { EXEC_P_TEST: 'yes' },
         cwd: __dirname,
      });
      assert.strictEqual(out, `yes:${__dirname}\n`);
   });

   it('rejects when the command cannot be spawned', async () => {
      await assert.rejects(execP('definitely-not-a-real-command-xyz'), { code: 'ENOENT' });
   });

   it('rejects with AbortError and kills the child when aborted', async () => {
      const controller = new AbortController();
      const pending = execP(node, script(`console.log('started'); setTimeout(() => {}, 10000)`), {
         signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 100);

      const started = Date.now();
      await assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' });
      assert.ok(Date.now() - started < 5000, 'child should not run to completion');
   });

   it('rejects without spawning when already aborted', async () => {
      const controller = new AbortController();
      controller.abort(new Error('reason'));
      await assert.rejects(
         execP(node, script(`console.log('never')`), { signal: controller.signal }),
         (err) => err.name === 'AbortError' && err.cause.message === 'reason',
      );
   });

   it('ignores aborts after the process has completed', async () => {
      const controller = new AbortController();
      const out = await execP(node, script(`console.log('done')`), { signal: controller.signal });
      controller.abort();
      assert.strictEqual(out, 'done\n');
   });

});
