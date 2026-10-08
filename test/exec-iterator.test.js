const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { execIterator } = require('../dist');

const node = process.execPath;
const script = (source) => ['-e', source];

async function collect (iterable) {
   const chunks = [];
   for await (const chunk of iterable) chunks.push(chunk);
   return chunks;
}

const text = (chunks, channel) => Buffer.concat(
   chunks.filter(c => c.channel === channel).map(c => c.content)
).toString();

describe('execIterator', () => {

   it('iterates stdout and stderr chunks', async () => {
      const stream = await execIterator(node, script(`
         process.stdout.write('out');
         process.stderr.write('err');
      `));
      const chunks = await collect(stream.chunks());

      assert.strictEqual(text(chunks, 'stdout'), 'out');
      assert.strictEqual(text(chunks, 'stderr'), 'err');
      assert.ok(chunks.every(c => Buffer.isBuffer(c.content)));
      assert.deepStrictEqual(await stream.exit, { code: 0, signal: null });
   });

   it('buffers output emitted before iteration starts', async () => {
      const stream = await execIterator(node, script(`console.log('early')`));
      await stream.exit;

      assert.strictEqual(text(await collect(stream.chunks()), 'stdout'), 'early\n');
   });

   it('buffers output emitted faster than it is consumed', async () => {
      const stream = await execIterator(node, script(`for (let i = 0; i < 200; i++) console.log(i)`));
      let out = '';
      for await (const chunk of stream.chunks()) {
         out += chunk.content;
         await delay(5);
      }
      assert.strictEqual(out, Array.from({ length: 200 }, (_, i) => `${i}\n`).join(''));
   });

   it('kills the child on break by default', async () => {
      const stream = await execIterator(node, script(`setInterval(() => console.log('tick'), 10)`));
      for await (const _ of stream.chunks()) break;

      assert.deepStrictEqual(await stream.exit, { code: null, signal: 'SIGTERM' });
   });

   it('kills the child when the loop body throws', async () => {
      const stream = await execIterator(node, script(`setInterval(() => console.log('tick'), 10)`));
      await assert.rejects(async () => {
         for await (const _ of stream.chunks()) throw new Error('boom');
      }, /boom/);

      assert.strictEqual((await stream.exit).signal, 'SIGTERM');
   });

   it('can resume after break with onBreak: keep-running', async () => {
      const stream = await execIterator(node, script(`
         console.log('one');
         setTimeout(() => console.log('two'), 50);
      `), { onBreak: 'keep-running' });

      let first = '';
      for await (const chunk of stream.chunks()) {
         first += chunk.content;
         break;
      }
      assert.strictEqual(first, 'one\n');

      assert.strictEqual(text(await collect(stream.chunks()), 'stdout'), 'two\n');
      assert.deepStrictEqual(await stream.exit, { code: 0, signal: null });
   });

   it('rejects concurrent iterators', async () => {
      const stream = await execIterator(node, script(`setTimeout(() => {}, 50)`));
      const iterator = stream.chunks();
      assert.throws(() => stream.chunks(), /already being iterated/);
      await iterator.return();
      await stream.exit;
   });

   it('aborts with the AbortController', async () => {
      const controller = new AbortController();
      const stream = await execIterator(node, script(`setInterval(() => console.log('tick'), 10)`), {
         signal: controller.signal,
      });

      await assert.rejects(async () => {
         for await (const _ of stream.chunks()) controller.abort();
      }, { name: 'AbortError' });
      assert.strictEqual((await stream.exit).signal, 'SIGTERM');
   });

   it('rejects without spawning when already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(execIterator(node, ['-v'], { signal: controller.signal }), { name: 'AbortError' });
   });

   it('rejects when the command cannot be spawned', async () => {
      await assert.rejects(execIterator('definitely-not-a-real-command-xyz'), { code: 'ENOENT' });
   });

   it('passes env and cwd through', async () => {
      const stream = await execIterator(node, script(`console.log(process.env.EXEC_P_TEST + ':' + process.cwd())`), {
         env: { EXEC_P_TEST: 'yes' },
         cwd: __dirname,
      });
      assert.strictEqual(text(await collect(stream.chunks()), 'stdout'), `yes:${__dirname}\n`);
   });

   it('never runs through a shell', async () => {
      const stream = await execIterator(node, ['-e', 'console.log(process.argv[1])', '$(echo injected); echo nope']);
      assert.strictEqual(text(await collect(stream.chunks()), 'stdout'), '$(echo injected); echo nope\n');
   });

   it('rejects unsupported and invalid options', async () => {
      await assert.rejects(execIterator(node, [], { shell: true }), /unsupported option "shell"/);
      await assert.rejects(execIterator(node, [], { onBreak: 'nope' }), /onBreak/);
      await assert.rejects(execIterator(node, [], { env: { 'A=B': 'x' } }), /invalid environment variable/);
      await assert.rejects(execIterator(node, [1]), /args must be an array of strings/);
      await assert.rejects(execIterator(''), /command must be a non-empty string/);
   });

   it('pauses reading above highWaterMark until consumed', async () => {
      const stream = await execIterator(node, script(`
         const chunk = 'x'.repeat(64 * 1024);
         let written = 0;
         (function write () {
            while (written < 64 && process.stdout.write(chunk)) written++;
            if (written < 64) process.stdout.once('drain', () => { written++; write(); });
         })();
      `), { highWaterMark: 1024 });

      await delay(200);
      let total = 0;
      for await (const chunk of stream.chunks()) total += chunk.content.length;
      assert.strictEqual(total, 64 * 64 * 1024);
   });

});
