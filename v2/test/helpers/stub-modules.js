// Inject fake module exports into require.cache BEFORE the module under test
// is required, so heavy deps (supabase client, SDKs) never load and no env
// secrets are needed. node --test runs each test file in its own process, so
// stubs never leak between files.

const Module = require('module');
const path = require('path');

// Resolve a project-relative id (e.g. 'server/lib/supabase') or a bare package
// name (e.g. 'ws') to its absolute resolved path, then plant fake exports.
function stubModule(id, exports) {
  const resolved = id.startsWith('server/') || id.startsWith('./') || id.startsWith('../')
    ? require.resolve(path.join(__dirname, '..', '..', id))
    : require.resolve(id, { paths: [path.join(__dirname, '..', '..')] });
  const m = new Module(resolved);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
  return exports;
}

// Require a project module fresh (after stubs are planted).
function loadReal(id) {
  return require(path.join(__dirname, '..', '..', id));
}

module.exports = { stubModule, loadReal };
