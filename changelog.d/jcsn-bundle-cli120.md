### Alterado

- **Databricks CLI ≥ 1.20 passa a ser obrigatória (a partir da 2.0.0)**: a partir da 1.20 o único motor de bundle é o
  direct (sem Terraform), e `bundle plan`/`bundle deploy` falhavam com a referência `.url` do dashboard nos alertas A2/A7
  (correção do commit de jcsn13 acima, que passa a interpolar o `id`). O `deploy.sh` agora para cedo, com erro claro, numa
  CLI mais antiga; o gate de release roda `bundle plan -o json`, não só `bundle validate`. Docs (en, pt-BR, es) e
  CONTRIBUTING atualizados; um teste varre o `databricks.yml` inteiro e falha em qualquer `${resources.dashboards.*.url}`.
  Ideia de jcsn13.
