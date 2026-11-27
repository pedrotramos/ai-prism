### Added

- **Roteador de intenção com o OpenJev (Qwen3.5 4B), atrás de `INTENT_ROUTER`.** O classificador de intenção
  do turno (deck, documento, planilha, imagem, dados da empresa) agora pode consultar o OpenJev no System One:
  uma única requisição em lote por turno, com uma pergunta de sim/não por rota e por ferramenta habilitada
  (cerca de 0,3 s e US$ 0,04 por 1.000 turnos). Regras sobre as probabilidades e o sinal dos regex decidem
  quando o modelo está confiante. `INTENT_ROUTER=haiku` (padrão, comportamento de sempre), `shadow` (o Haiku
  decide; o OpenJev roda em paralelo, sem ser aguardado, e só alimenta a telemetria) e `race` (os dois saem
  juntos; o OpenJev decide quando confiante e o Haiku é abortado, senão o Haiku decide; se os dois falham,
  decidem os regex). O roteador nunca remove uma ferramenta habilitada nem a busca na web: o veredito sobre
  elas é só dica e telemetria. `INTENT_OPENJEV_ENDPOINT` troca o modelo (padrão `system.ai.openjev-qwen35-4b`);
  vazio, ou um workspace sem o endpoint (404), volta ao Haiku com uma linha de log. Cada chamada vira uma linha
  `intent_openjev` no taxímetro (entrada US$ 0,042 por 1M de tokens, saída 0), o modelo não entra no seletor e o
  evento `intent_router` leva só decisões e probabilidades, nunca o texto da mensagem. Operações §6.18 (EN,
  pt-BR, es).

### Deploy notes

- Nada muda sem configuração: o padrão continua `INTENT_ROUTER=haiku`. Para medir, ligue `shadow` no `env` do
  `app.yaml`; voltar a `haiku` é todo o rollback (sem migração).
