# AUTO-GENERATED from shared/pythonUdf.js by scripts/gen-python-udf-ddl.mjs.
# Do not edit by hand — edit the JS source and re-run the generator so the
# deploy-time (bundle job) and test UDF definitions stay identical.

import hashlib

_BODY = r'''import io, contextlib, math, statistics, decimal, fractions, cmath, random, itertools, functools, re, json as _json, datetime
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
return out[:_LIMIT] if out else "(execução concluída sem saída — defina uma variável `result` ou use print())"'''

_PARAM_COMMENT = "Código-fonte Python a executar. Defina uma variável \"result\" com a resposta final, ou use print()."
_COMMENT = "Executa código Python (math, statistics, decimal, fractions, cmath, random, itertools, functools, re, json, datetime disponíveis) e retorna a variável result como texto, ou a saída de print(). Use para cálculos que exigem precisão exata. Cada chamada roda ISOLADA, em um ambiente novo — variáveis, imports e funções definidos numa chamada NÃO existem na próxima. Se precisa reusar um valor, recalcule-o ou inclua tudo no mesmo código."

# (name, lower-case type) of the only parameter: what a function must declare to be this one.
UDF_SIGNATURE = (("code", "string"),)


def normalize_body(text: str) -> str:
    """CRLF -> LF, trailing blanks off every line, leading/trailing blank lines off."""
    return "\n".join(line.rstrip() for line in (text or "").replace("\r\n", "\n").split("\n")).strip()


def body_sha256(text: str) -> str:
    return hashlib.sha256(normalize_body(text).encode("utf-8")).hexdigest()


# sha256 of every body AI Prism has deployed for this function (history in the generator + the
# current one). A function WITHOUT an ownership record is adopted only if its body is one of these.
KNOWN_BODY_SHA256 = frozenset((
    "525103845cdb9e217b209c99426c777447352691ac93971491f31f2e4b835fe7",
    "7e87dd7434cf7fb18f8d070a43e3dac15c8b9fdcd39684c19a93ab8f5a03f594",
    "cb34ff3579733b12a928848ecb3d3a161ddddfa90a27bc96f7e7041d65b9e9b8",
))
CURRENT_BODY_SHA256 = "cb34ff3579733b12a928848ecb3d3a161ddddfa90a27bc96f7e7041d65b9e9b8"


def python_udf_ddl(fq_name: str, replace: bool = False, owner_tag: str = "") -> str:
    """DDL of the built-in Python UDF: CREATE FUNCTION, or CREATE OR REPLACE only when
    replace=True (bundle/auto_config.py passes it only for a function it owns). owner_tag, the
    per-deployment ownership record, is appended to the function COMMENT."""
    verb = "CREATE OR REPLACE FUNCTION" if replace else "CREATE FUNCTION"
    comment = _COMMENT + (" " + owner_tag if owner_tag else "")
    return (
        f"{verb} {fq_name}(code STRING COMMENT '{_PARAM_COMMENT}')\n"
        " RETURNS STRING\n"
        " LANGUAGE PYTHON\n"
        f" COMMENT '{comment}'\n"
        f" AS $$" + _BODY + "$$"
    )
