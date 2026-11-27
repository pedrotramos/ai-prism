// Generates bundle/python_udf_ddl.py from the canonical JS source
// (shared/pythonUdf.js), so the deploy-time job and the tests use byte-for-byte
// the same UDF definition. Run: node scripts/gen-python-udf-ddl.mjs
import { createHash } from 'node:crypto'
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

// Body digest used by bundle/auto_config.py to recognise a function that earlier AI Prism
// versions created (and that carries no ownership record yet). Whitespace-normalised so it
// does not depend on how Unity Catalog hands the body back: CRLF -> LF, trailing blanks off
// every line, leading/trailing blank lines off. Keep in sync with normalize_body() below.
const normalizeBody = (s) =>
  s.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim()
const digest = (s) => createHash('sha256').update(normalizeBody(s), 'utf8').digest('hex')

// sha256 of every body AI Prism has ever deployed for this function, taken from git history
// (shared/pythonUdf.js and, before it existed, the inline body in server/tools.js). The current
// body is added below. When PYTHON_UDF_BODY changes, the previous value of the *current* digest
// MUST be appended here, or functions created by the previous release stop being recognised.
const LEGACY_BODY_SHA256 = [
  ['7eb8ebf (server/tools.js, first release, 4000-char cap)', '525103845cdb9e217b209c99426c777447352691ac93971491f31f2e4b835fe7'],
  ['0513755 (shared/pythonUdf.js, bundle-provisioned)', '7e87dd7434cf7fb18f8d070a43e3dac15c8b9fdcd39684c19a93ab8f5a03f594'],
  ['71c9a86 (shared/pythonUdf.js, per-call isolation; unchanged since)', 'cb34ff3579733b12a928848ecb3d3a161ddddfa90a27bc96f7e7041d65b9e9b8'],
]
const current = digest(PYTHON_UDF_BODY)
const known = [...LEGACY_BODY_SHA256.map(([, d]) => d), current].filter((d, i, a) => a.indexOf(d) === i)

// Emit the pieces as Python literals, then a builder that assembles the same DDL
// string as shared/pythonUdf.js#pythonUdfDDL (CREATE OR REPLACE only when replace=True).
const py = `# AUTO-GENERATED from shared/pythonUdf.js by scripts/gen-python-udf-ddl.mjs.
# Do not edit by hand — edit the JS source and re-run the generator so the
# deploy-time (bundle job) and test UDF definitions stay identical.

import hashlib

_BODY = r'''${PYTHON_UDF_BODY}'''

_PARAM_COMMENT = ${JSON.stringify(PYTHON_UDF_PARAM_COMMENT)}
_COMMENT = ${JSON.stringify(PYTHON_UDF_COMMENT)}

# (name, lower-case type) of the only parameter: what a function must declare to be this one.
UDF_SIGNATURE = (("code", "string"),)


def normalize_body(text: str) -> str:
    """CRLF -> LF, trailing blanks off every line, leading/trailing blank lines off."""
    return "\\n".join(line.rstrip() for line in (text or "").replace("\\r\\n", "\\n").split("\\n")).strip()


def body_sha256(text: str) -> str:
    return hashlib.sha256(normalize_body(text).encode("utf-8")).hexdigest()


# sha256 of every body AI Prism has deployed for this function (history in the generator + the
# current one). A function WITHOUT an ownership record is adopted only if its body is one of these.
KNOWN_BODY_SHA256 = frozenset((
${known.map((d) => `    "${d}",`).join('\n')}
))
CURRENT_BODY_SHA256 = "${current}"


def python_udf_ddl(fq_name: str, replace: bool = False, owner_tag: str = "") -> str:
    """DDL of the built-in Python UDF: CREATE FUNCTION, or CREATE OR REPLACE only when
    replace=True (bundle/auto_config.py passes it only for a function it owns). owner_tag, the
    per-deployment ownership record, is appended to the function COMMENT."""
    verb = "CREATE OR REPLACE FUNCTION" if replace else "CREATE FUNCTION"
    comment = _COMMENT + (" " + owner_tag if owner_tag else "")
    return (
        f"{verb} {fq_name}(code STRING COMMENT '{_PARAM_COMMENT}')\\n"
        " RETURNS STRING\\n"
        " LANGUAGE PYTHON\\n"
        f" COMMENT '{comment}'\\n"
        f" AS $$" + _BODY + "$$"
    )
`

writeFileSync(out, py)
console.log('Wrote', out)
