### Added

- **Roteador de intenção com o OpenJev (Qwen3.5 4B), atrás de `INTENT_ROUTER`.** O classificador de intenção
  do turno (deck, documento, planilha, imagem, dados da empresa) agora pode consultar o OpenJev no System One:
  uma única requisição em lote por turno, com uma pergunta de sim/não por rota e por ferramenta habilitada
  (cerca de 0,3 s e US$ 0,04 por 1.000 turnos). Regras sobre as probabilidades e o sinal dos regex decidem
  quando o modelo está confiante. `INTENT_ROUTER=race` (padrão: os dois saem juntos; o OpenJev decide quando confiante e o Haiku é abortado,
  senão o Haiku decide; se os dois falham, decidem os regex), `shadow` (o Haiku decide; o OpenJev roda em
  paralelo, sem ser aguardado, e só alimenta a telemetria) e `haiku` (só o classificador de antes: a reversão).
  No re-score offline de 40 itens novos, o race acertou 40/40, igual ao Haiku, com 7/7 de recall de deck nos
  pedidos multi-rota. O roteador nunca remove uma ferramenta habilitada nem a busca na web: o veredito sobre
  elas é só dica e telemetria. `INTENT_OPENJEV_ENDPOINT` troca o modelo (padrão `system.ai.openjev-qwen35-4b`);
  vazio, ou um workspace sem o endpoint (404), volta ao Haiku com uma linha de log. Cada chamada vira uma linha
  `intent_openjev` no taxímetro (entrada US$ 0,042 por 1M de tokens, saída 0), o modelo não entra no seletor e o
  evento `intent_router` leva só decisões e probabilidades, nunca o texto da mensagem. Operações §6.18 (EN,
  pt-BR, es).

### Changed

- **O gate do classificador de intenção entende espanhol e o orçamento do Haiku subiu de 60 para 150 tokens.**
  Pedidos em espanhol (presentación, diapositivas, hoja de cálculo, informe, carta, imagen, logotipo, com e
  sem acento) agora chegam ao classificador, e uma resposta sem texto por raciocínio oculto
  (`finish_reason: length`) deixou de ser comum. O orçamento do título não mudou.

### Deploy notes

- O padrão agora é `INTENT_ROUTER=race` com o endpoint `system.ai.openjev-qwen35-4b`; um workspace sem o
  endpoint (404) cai para o Haiku sozinho, com uma linha de log. Para reverter, descomente `INTENT_ROUTER` com
  o valor `haiku` no `env` do `app.yaml` e faça o redeploy do mesmo build (sem migração).
