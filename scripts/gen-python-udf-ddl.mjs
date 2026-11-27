// Generates bundle/python_udf_ddl.py from the canonical JS source
// (shared/pythonUdf.js), so the deploy-time job and the runtime app provision
// byte-for-byte the same UDF. Run: node scripts/gen-python-udf-ddl.mjs
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  PYTHON_UDF_BODY,
  PYTHON_UDF_PARAM_COMMENT,
  PYTHON_UDF_COMMENT,
} from '../shared/pythonUdf.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '..', 'bundle', 'python_udf_ddl.py')

// Ownership marker: the head of the COMMENT every AI Prism deploy writes on the UDF,
// up to and including the first closing parenthesis (the list of pre-imported modules).
// bundle/auto_config.py replaces an existing function only when its COMMENT carries
// it, so a same-named function that is not AI Prism's is never overwritten.
const OWNER_MARKER = PYTHON_UDF_COMMENT.slice(0, PYTHON_UDF_COMMENT.indexOf(')') + 1)
if (!OWNER_MARKER || !PYTHON_UDF_COMMENT.startsWith(OWNER_MARKER)) {
  throw new Error('shared/pythonUdf.ts: PYTHON_UDF_COMMENT has no ")" to cut the ownership marker at')
}

// Emit the pieces as Python literals, then a builder that assembles the same DDL
// string as shared/pythonUdf.js#pythonUdfDDL (CREATE OR REPLACE only when replace=True).
const py = `# AUTO-GENERATED from shared/pythonUdf.js by scripts/gen-python-udf-ddl.mjs.
# Do not edit by hand — edit the JS source and re-run the generator so the
# deploy-time (bundle job) and runtime (app) UDF definitions stay identical.

_BODY = r'''${PYTHON_UDF_BODY}'''

_PARAM_COMMENT = ${JSON.stringify(PYTHON_UDF_PARAM_COMMENT)}
_COMMENT = ${JSON.stringify(PYTHON_UDF_COMMENT)}

# Head of _COMMENT that marks a function as created by AI Prism (see auto_config.py).
OWNER_MARKER = ${JSON.stringify(OWNER_MARKER)}


def python_udf_ddl(fq_name: str, replace: bool = False) -> str:
    """DDL of the built-in Python UDF: CREATE FUNCTION, or CREATE OR REPLACE only when
    replace=True (bundle/auto_config.py passes it only for a function it owns)."""
    verb = "CREATE OR REPLACE FUNCTION" if replace else "CREATE FUNCTION"
    return (
        f"{verb} {fq_name}(code STRING COMMENT '{_PARAM_COMMENT}')\\n"
        " RETURNS STRING\\n"
        " LANGUAGE PYTHON\\n"
        f" COMMENT '{_COMMENT}'\\n"
        f" AS $$" + _BODY + "$$"
    )
`

writeFileSync(out, py)
console.log('Wrote', out)
