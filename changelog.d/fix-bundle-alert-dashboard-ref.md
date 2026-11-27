### Fixed

- **`databricks bundle plan` and `bundle deploy` failed on the direct engine (Databricks CLI >= 1.20, where Terraform no
  longer exists)**: the descriptions of the SQL alerts A2 and A7 interpolated `${resources.dashboards.ai_prism_telemetry.url}`,
  a field the direct engine cannot resolve (`cannot plan resources.alerts...: schema mismatch: field "url" not found in
  dresources.DashboardState`), so planning aborted before anything was deployed. The descriptions now name the dashboard
  ("AI Prism — Telemetry") and interpolate its `id`, which the engine resolves at deploy time. `bundle validate` never
  caught this because it does not plan.
