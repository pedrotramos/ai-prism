// node:test custom reporter used by tests/run.mjs: one JSON line per finished
// test or suite, carrying the file it came from. The built-in TAP reporter only
// prints a test's location when it fails, so per-file pass counts (e.g.
// "isolation 10/10") need this, and so does the skip reason --fail-on-skip
// reads (see INFRA_SKIP_PREFIX in tests/run.mjs).
export default async function* summaryReporter(source) {
  for await (const { type, data } of source) {
    if (type !== 'test:pass' && type !== 'test:fail') continue
    yield JSON.stringify({
      event: type === 'test:pass' ? 'pass' : 'fail',
      file: data.file || null,
      name: data.name,
      nesting: data.nesting,
      type: data.details?.type || 'test',
      skip: data.skip !== undefined && data.skip !== false,
      // t.skip('reason') / { skip: 'reason' } carry the reason as a string;
      // tests/run.mjs lets '[infra-skip:' reasons through --fail-on-skip.
      skipReason: typeof data.skip === 'string' ? data.skip : null,
      todo: data.todo !== undefined && data.todo !== false,
    }) + '\n'
  }
}
