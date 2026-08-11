// Canonical definition of the built-in Python execution UDF, shared by:
//   • server/tools.js — provisions it lazily at runtime (CREATE OR REPLACE)
//   • the bundle's auto-config job — provisions it at deploy time, so every
//     workspace gets the SAME capability without waiting for the first tool call.
//
// We deliberately ship our OWN UDF instead of leaning on system.ai.python_exec:
// the platform function captures only stdout and FAILS the whole SQL statement
// on any exception, whereas this one honors a `result` variable, captures
// stdout, and returns "ERROR: ..." gracefully so a bad snippet never kills the
// turn. Keeping one source of truth means the runtime and the deploy-time job
// can never drift.

// The UDF's Python body. `code` (a STRING param) is exec'd with a curated set of
// stdlib modules pre-imported; the function returns the `result` variable if set,
// else captured stdout, else a friendly "no output" note.
//
// EXPLICIT ISOLATION: every invocation must behave as a clean slate — one Python
// tool call MUST NOT see anything a previous call did, whether earlier in the
// same turn or in an earlier turn. Two layers give that guarantee:
//   1. User bindings: `ns` (the exec globals) is a FRESH dict built on every
//      invocation — the whole body re-runs per call — so variables, imports and
//      function defs from a prior call are never visible.
//   2. Mutable module state: the curated modules are objects the warehouse's
//      Python worker can reuse across invocations, so their GLOBAL mutable state
//      would leak even though `ns` is fresh. The two vectors among our imports
//      are the `random` global RNG and the thread-local `decimal` context — both
//      are reset at the top of every call, so e.g. a `random.seed(...)` or a
//      `getcontext().prec = 2` in one call can't change the numbers a later call
//      produces. The remaining imports (math/statistics/fractions/cmath/
//      itertools/functools/re/json/datetime) carry no semantics-affecting global
//      state. Keep this reset in sync if the import list grows a stateful module.
export const PYTHON_UDF_BODY = `
import io, contextlib, math, statistics, decimal, fractions, cmath, random, itertools, functools, re, json as _json, datetime
# reset the mutable module-global state a reused worker could carry between calls
random.seed()                       # fresh OS entropy → no dependence on a prior seed/draws
decimal.setcontext(decimal.Context())  # back to the default precision/rounding
ns = {
    "math": math, "statistics": statistics, "decimal": decimal, "fractions": fractions,
    "cmath": cmath, "random": random, "itertools": itertools, "functools": functools,
    "re": re, "json": _json, "datetime": datetime,
}
buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf):
        exec(code, ns)
except Exception as e:
    return "ERROR: " + repr(e)
# Cap is a runaway backstop only (a stray dump of a whole table shouldn't blow
# up the turn), set generously so it never truncates a legitimate result — not
# a quality limit. Speed comes from prompt caching, not from shrinking outputs.
_LIMIT = 200000
if "result" in ns:
    return str(ns["result"])[:_LIMIT]
out = buf.getvalue().strip()
return out[:_LIMIT] if out else "(execução concluída sem saída — defina uma variável \`result\` ou use print())"
`.trim()

// The COMMENT strings, kept here so the DDL reads identically wherever it runs.
export const PYTHON_UDF_PARAM_COMMENT =
  'Código-fonte Python a executar. Defina uma variável "result" com a resposta final, ou use print().'
export const PYTHON_UDF_COMMENT =
  'Executa código Python (math, statistics, decimal, fractions, cmath, random, itertools, functools, re, json, datetime disponíveis) e retorna a variável result como texto, ou a saída de print(). Use para cálculos que exigem precisão exata. Cada chamada roda ISOLADA, em um ambiente novo — variáveis, imports e funções definidos numa chamada NÃO existem na próxima. Se precisa reusar um valor, recalcule-o ou inclua tudo no mesmo código.'

/**
 * Build the idempotent CREATE OR REPLACE FUNCTION DDL for the given
 * fully-qualified name (e.g. "main.default.ai_prism_python_exec").
 */
export function pythonUdfDDL(fqName) {
  return `CREATE OR REPLACE FUNCTION ${fqName}(code STRING COMMENT '${PYTHON_UDF_PARAM_COMMENT}')
 RETURNS STRING
 LANGUAGE PYTHON
 COMMENT '${PYTHON_UDF_COMMENT}'
 AS $$${PYTHON_UDF_BODY}$$`
}
