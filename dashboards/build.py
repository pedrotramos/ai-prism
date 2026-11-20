#!/usr/bin/env python3
"""Generate the AI Prism telemetry dashboard (dashboards/ai-telemetry.lvdash.json).

The dashboard reads the three Unity Catalog tables the Databricks Apps telemetry export
fills (otel_spans, ...). Their catalog.schema is chosen by the operator, and a Lakeview file
cannot take a bundle variable, so the JSON is GENERATED for a given schema:

    python3 dashboards/build.py                              # default ai_prism.telemetry
    python3 dashboards/build.py --catalog C --schema S       # your schema
    python3 dashboards/build.py --check                      # exit 1 if the file on disk differs

Edit this generator, never the JSON by hand. Output is deterministic (tests/dashboardsBuild.test.mjs).
Python 3.9+, standard library only.
"""
import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT_NAME = "ai-telemetry.lvdash.json"
DEFAULT_CATALOG = "ai_prism"
DEFAULT_SCHEMA = "telemetry"
IDENT = re.compile(r"^[A-Za-z0-9_]+$")
WINDOW_DAYS = 30
FAILURE_DAYS = 7

SPANS_DUR = "(end_time_unix_nano - start_time_unix_nano) / 1e6"


def lines(sql):
    """queryLines: elements are joined verbatim, so every line ends with a newline."""
    return [ln + "\n" for ln in sql.strip().split("\n")]


def datasets(spans):
    since = "date_add(current_date(), -%d)" % WINDOW_DAYS
    return [
        {
            "name": "tel_http",
            "displayName": "Telemetria · requisições HTTP",
            "queryLines": lines(
                f"""
SELECT
  date(time) AS day,
  regexp_replace(name, '^[A-Z]+ ', '') AS route,
  CASE WHEN attributes:['http.status_code']::int >= 500 THEN '5xx'
       WHEN attributes:['http.status_code']::int >= 400 THEN '4xx'
       ELSE '2xx-3xx' END AS status_class,
  COUNT(*) AS requests,
  SUM(CASE WHEN attributes:['http.status_code']::int >= 500 THEN 1 ELSE 0 END) AS errors_5xx,
  percentile({SPANS_DUR}, 0.95) AS p95_ms
FROM {spans}
WHERE kind = 'SPAN_KIND_SERVER'
  AND name LIKE '% /api/%'
  AND date(time) >= {since}
GROUP BY 1, 2, 3"""
            ),
        },
        {
            "name": "tel_turns",
            "displayName": "Telemetria · turnos de chat",
            "queryLines": lines(
                f"""
SELECT
  date(time) AS day,
  coalesce(attributes:['status']::string, 'unknown') AS status,
  COUNT(*) AS turns,
  percentile({SPANS_DUR}, 0.95) AS p95_ms
FROM {spans}
WHERE name = 'chat.turn'
  AND date(time) >= {since}
GROUP BY 1, 2"""
            ),
        },
        {
            "name": "tel_llm",
            "displayName": "Telemetria · chamadas ao gateway",
            "queryLines": lines(
                f"""
SELECT
  date(time) AS day,
  coalesce(attributes:['gen_ai.request.model']::string, 'unknown') AS model,
  COUNT(*) AS calls,
  SUM(CASE WHEN attributes:['status']::string = 'error' THEN 1 ELSE 0 END) AS errors,
  coalesce(SUM(attributes:['gen_ai.usage.input_tokens']::bigint), 0) AS input_tokens,
  coalesce(SUM(attributes:['gen_ai.usage.output_tokens']::bigint), 0) AS output_tokens,
  coalesce(SUM(attributes:['cost_usd']::double), 0) AS cost_usd,
  percentile({SPANS_DUR}, 0.95) AS p95_ms
FROM {spans}
WHERE name = 'llm.call'
  AND date(time) >= {since}
GROUP BY 1, 2"""
            ),
        },
        {
            "name": "tel_tools",
            "displayName": "Telemetria · ferramentas",
            "queryLines": lines(
                f"""
SELECT
  date(time) AS day,
  coalesce(attributes:['tool.name']::string, 'unknown') AS tool,
  COUNT(*) AS calls,
  SUM(CASE WHEN attributes:['status']::string = 'error' THEN 1 ELSE 0 END) AS errors,
  percentile({SPANS_DUR}, 0.95) AS p95_ms
FROM {spans}
WHERE name = 'tool.call'
  AND date(time) >= {since}
GROUP BY 1, 2"""
            ),
        },
        {
            "name": "tel_failures",
            "displayName": "Telemetria · falhas recentes",
            "queryLines": lines(
                f"""
SELECT
  date(time) AS day,
  time,
  trace_id,
  name AS span,
  coalesce(attributes:['http.status_code']::string, attributes:['status']::string) AS outcome,
  coalesce(attributes:['route']::string, attributes:['http.target']::string, attributes:['tool.name']::string,
           attributes:['gen_ai.request.model']::string) AS detail,
  round({SPANS_DUR}, 1) AS duration_ms
FROM {spans}
WHERE date(time) >= date_add(current_date(), -{FAILURE_DAYS})
  AND (attributes:['http.status_code']::int >= 500
       OR (name IN ('chat.turn', 'llm.call', 'tool.call') AND attributes:['status']::string = 'error'))
ORDER BY time DESC
LIMIT 500"""
            ),
        },
        {
            "name": "tel_trace",
            "displayName": "Telemetria · spans dos traces com falha",
            "queryLines": lines(
                f"""
SELECT
  s.trace_id,
  s.time,
  s.name AS span,
  s.span_id,
  s.parent_span_id,
  coalesce(s.attributes:['http.status_code']::string, s.attributes:['status']::string) AS outcome,
  coalesce(s.attributes:['tool.name']::string, s.attributes:['gen_ai.request.model']::string,
           s.attributes:['route']::string, s.attributes:['http.target']::string) AS detail,
  round(({SPANS_DUR.replace('end_time_unix_nano', 's.end_time_unix_nano').replace('start_time_unix_nano', 's.start_time_unix_nano')}), 1) AS duration_ms
FROM {spans} s
WHERE s.trace_id IN (
  SELECT trace_id FROM {spans}
  WHERE date(time) >= date_add(current_date(), -{FAILURE_DAYS})
    AND (attributes:['http.status_code']::int >= 500
         OR (name IN ('chat.turn', 'llm.call', 'tool.call') AND attributes:['status']::string = 'error'))
)
AND date(s.time) >= date_add(current_date(), -{FAILURE_DAYS})
ORDER BY s.time
LIMIT 5000"""
            ),
        },
    ]


def field(name, expr=None):
    return {"name": name, "expression": expr or "`%s`" % name}


def frame(title):
    return {"showTitle": True, "title": title}


def counter(name, title, dataset, agg_name, agg_expr, display, fmt="number-plain"):
    return {
        "name": name,
        "queries": [{"name": "main_query", "query": {"datasetName": dataset, "fields": [field(agg_name, agg_expr)], "disaggregated": False}}],
        "spec": {
            "version": 2,
            "widgetType": "counter",
            "frame": frame(title),
            "encodings": {
                "value": {
                    "fieldName": agg_name,
                    "displayName": display,
                    "format": {"type": fmt, "abbreviation": "compact", "decimalPlaces": {"type": "max", "places": 1}},
                }
            },
            "data": {"queryName": "main_query"},
        },
    }


def palette(n):
    return [{"themeColorType": "visualizationColors", "position": i} for i in range(1, n + 1)]


def bar(name, title, dataset, x, y_name, y_expr, y_display, color, color_display, stacked=False):
    y = {"fieldName": y_name, "displayName": y_display, "scale": {"type": "quantitative"}}
    return {
        "name": name,
        "queries": [{"name": "main_query", "query": {"datasetName": dataset, "fields": [field(x), field(y_name, y_expr), field(color)], "disaggregated": False}}],
        "spec": {
            "version": 3,
            "widgetType": "bar",
            "frame": frame(title),
            "mark": {"colors": palette(10)},
            "encodings": {
                "x": {"fieldName": x, "displayName": "Dia", "scale": {"type": "temporal"}},
                "y": y,
                "color": {"fieldName": color, "displayName": color_display, "scale": {"type": "categorical"}},
            },
            "data": {"queryName": "main_query"},
        },
    }


def table(name, title, dataset, columns, aggregated=False):
    """columns: [(field name, expression, display name)]."""
    return {
        "name": name,
        "queries": [{"name": "main_query", "query": {"datasetName": dataset, "fields": [field(n, e) for n, e, _ in columns], "disaggregated": not aggregated}}],
        "spec": {
            "version": 2,
            "widgetType": "table",
            "frame": frame(title),
            "encodings": {"columns": [{"fieldName": n, "displayName": d} for n, _, d in columns]},
        },
    }


def text(name, md):
    return {"name": name, "multilineTextboxSpec": {"lines": [md]}}


def date_filter(name, datasets_):
    queries = [
        {"name": "f_" + d, "query": {"datasetName": d, "fields": [field("day")], "disaggregated": False}} for d in datasets_
    ]
    return {
        "name": name,
        "queries": queries,
        "spec": {
            "version": 2,
            "widgetType": "filter-date-range-picker",
            "frame": frame("Período"),
            "selection": {"defaultSelection": {"range": {"dataType": "DATE", "min": {"value": "now-7d/d"}, "max": {"value": "now/d"}}}},
            "encodings": {"fields": [{"fieldName": "day", "queryName": q["name"]} for q in queries]},
        },
    }


def trace_filter(name):
    return {
        "name": name,
        "queries": [{"name": "f_trace", "query": {"datasetName": "tel_trace", "fields": [field("trace_id")], "disaggregated": False}}],
        "spec": {
            "version": 2,
            "widgetType": "filter-single-select",
            "frame": frame("Trace id"),
            "encodings": {"fields": [{"fieldName": "trace_id", "displayName": "Trace id", "queryName": "f_trace"}]},
        },
    }


def at(widget, x, y, w, h):
    return {"widget": widget, "position": {"x": x, "y": y, "width": w, "height": h}}


def build(catalog=DEFAULT_CATALOG, schema=DEFAULT_SCHEMA):
    spans = "%s.%s.otel_spans" % (catalog, schema)
    overview = [
        at(date_filter("flt_tel_day", ["tel_http", "tel_turns", "tel_llm", "tel_tools", "tel_failures"]), 0, 0, 4, 3),
        at(counter("kpi_tel_requests", "Requisições /api", "tel_http", "sum(requests)", "SUM(`requests`)", "Requisições"), 4, 0, 2, 3),
        at(counter("kpi_tel_5xx", "Erros 5xx", "tel_http", "sum(errors_5xx)", "SUM(`errors_5xx`)", "Erros 5xx"), 6, 0, 2, 3),
        at(counter("kpi_tel_turns", "Turnos de chat", "tel_turns", "sum(turns)", "SUM(`turns`)", "Turnos"), 8, 0, 2, 3),
        at(counter("kpi_tel_llm", "Chamadas ao gateway", "tel_llm", "sum(calls)", "SUM(`calls`)", "Chamadas"), 10, 0, 2, 3),
        at(bar("bar_tel_http", "Requisições por dia × classe de status", "tel_http", "day", "sum(requests)", "SUM(`requests`)", "Requisições", "status_class", "Status"), 0, 3, 6, 6),
        at(bar("bar_tel_turns", "Turnos por dia × desfecho", "tel_turns", "day", "sum(turns)", "SUM(`turns`)", "Turnos", "status", "Desfecho"), 6, 3, 6, 6),
        at(
            table(
                "tbl_tel_routes",
                "Rotas: volume, erros 5xx e p95 (ms)",
                "tel_http",
                [
                    ("route", "`route`", "Rota"),
                    ("sum(requests)", "SUM(`requests`)", "Requisições"),
                    ("sum(errors_5xx)", "SUM(`errors_5xx`)", "5xx"),
                    ("max(p95_ms)", "MAX(`p95_ms`)", "p95 (ms)"),
                ],
                aggregated=True,
            ),
            0, 9, 6, 7,
        ),
        at(
            table(
                "tbl_tel_llm",
                "Modelos: chamadas, erros, tokens, custo e p95 (ms)",
                "tel_llm",
                [
                    ("model", "`model`", "Modelo"),
                    ("sum(calls)", "SUM(`calls`)", "Chamadas"),
                    ("sum(errors)", "SUM(`errors`)", "Erros"),
                    ("sum(input_tokens)", "SUM(`input_tokens`)", "Tokens de entrada"),
                    ("sum(output_tokens)", "SUM(`output_tokens`)", "Tokens de saída"),
                    ("sum(cost_usd)", "SUM(`cost_usd`)", "Custo (USD)"),
                    ("max(p95_ms)", "MAX(`p95_ms`)", "p95 (ms)"),
                ],
                aggregated=True,
            ),
            6, 9, 6, 7,
        ),
        at(
            table(
                "tbl_tel_tools",
                "Ferramentas: chamadas, erros e p95 (ms)",
                "tel_tools",
                [
                    ("tool", "`tool`", "Ferramenta"),
                    ("sum(calls)", "SUM(`calls`)", "Chamadas"),
                    ("sum(errors)", "SUM(`errors`)", "Erros"),
                    ("max(p95_ms)", "MAX(`p95_ms`)", "p95 (ms)"),
                ],
                aggregated=True,
            ),
            0, 16, 12, 6,
        ),
    ]
    failures = [
        at(text("txt_tel_failures", "Falhas dos últimos %d dias (resposta 5xx, turno, chamada ao gateway ou ferramenta com erro). Escolha o **trace id** de uma falha no filtro abaixo para ver o turno inteiro: `chat.turn`, as chamadas `llm.call`/`tool.call` e a requisição HTTP, em ordem de início." % FAILURE_DAYS), 0, 0, 12, 2),
        at(date_filter("flt_tel_fail_day", ["tel_failures"]), 0, 2, 4, 3),
        at(trace_filter("flt_tel_trace"), 4, 2, 8, 3),
        at(
            table(
                "tbl_tel_failures",
                "Falhas recentes (copie o trace id)",
                "tel_failures",
                [
                    ("time", "`time`", "Quando (UTC)"),
                    ("trace_id", "`trace_id`", "Trace id"),
                    ("span", "`span`", "Span"),
                    ("outcome", "`outcome`", "Desfecho"),
                    ("detail", "`detail`", "Detalhe"),
                    ("duration_ms", "`duration_ms`", "Duração (ms)"),
                ],
            ),
            0, 5, 12, 7,
        ),
        at(
            table(
                "tbl_tel_trace",
                "Spans do trace escolhido",
                "tel_trace",
                [
                    ("time", "`time`", "Início (UTC)"),
                    ("span", "`span`", "Span"),
                    ("outcome", "`outcome`", "Desfecho"),
                    ("detail", "`detail`", "Detalhe"),
                    ("duration_ms", "`duration_ms`", "Duração (ms)"),
                    ("span_id", "`span_id`", "Span id"),
                    ("parent_span_id", "`parent_span_id`", "Pai"),
                ],
            ),
            0, 12, 12, 8,
        ),
    ]

    def page(name, display, layout):
        return {"name": name, "displayName": display, "pageType": "PAGE_TYPE_CANVAS", "layoutVersion": "GRID_V1", "layout": layout}

    return {
        "datasets": datasets(spans),
        "pages": [
            page("ai_tel_overview", "Telemetria", overview),
            page("ai_tel_failures", "Falhas e trace", failures),
        ],
        "uiSettings": {"theme": {"widgetHeaderAlignment": "ALIGNMENT_UNSPECIFIED"}, "applyModeEnabled": False},
    }


def render(catalog=DEFAULT_CATALOG, schema=DEFAULT_SCHEMA):
    return json.dumps(build(catalog, schema), indent=2, ensure_ascii=False) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--catalog", default=DEFAULT_CATALOG)
    ap.add_argument("--schema", default=DEFAULT_SCHEMA)
    ap.add_argument("--out", default=str(HERE / OUT_NAME), help="output file (default dashboards/%s)" % OUT_NAME)
    ap.add_argument("--check", action="store_true", help="compare with the file on disk instead of writing")
    a = ap.parse_args(argv)
    for label, v in (("catalog", a.catalog), ("schema", a.schema)):
        if not IDENT.match(v):
            ap.error("--%s must be letters, digits and _ only" % label)
    text_ = render(a.catalog, a.schema)
    out = Path(a.out)
    if a.check:
        if not out.exists() or out.read_text(encoding="utf-8") != text_:
            sys.stderr.write("%s is out of date: run python3 dashboards/build.py\n" % out)
            return 1
        return 0
    out.write_text(text_, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
