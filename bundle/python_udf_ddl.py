# AUTO-GENERATED from shared/pythonUdf.js by scripts/gen-python-udf-ddl.mjs.
# Do not edit by hand — edit the JS source and re-run the generator so the
# deploy-time (bundle job) and runtime (app) UDF definitions stay identical.

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


def python_udf_ddl(fq_name: str) -> str:
    """Idempotent CREATE OR REPLACE FUNCTION DDL for the built-in Python UDF."""
    return (
        f"CREATE OR REPLACE FUNCTION {fq_name}(code STRING COMMENT '{_PARAM_COMMENT}')\n"
        " RETURNS STRING\n"
        " LANGUAGE PYTHON\n"
        f" COMMENT '{_COMMENT}'\n"
        f" AS $$" + _BODY + "$$"
    )
