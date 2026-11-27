### Changed

- **Títulos de conversa sem emoji, mais profissionais** (`server/llm.ts`, `server/turn.ts`). O modelo auxiliar (Haiku 5.5)
  agora recebe a instrução de gerar um título conciso e específico de 3 a 6 palavras, no idioma da conversa, em
  sentence case, sem emoji, aspas ou ponto final. A saída passa por um sanitizador no servidor (`sanitizeTitle`) que
  remove emoji/pictogramas, aspas, pontuação final e espaços extras, e usa o início do prompt quando nada sobra. O
  título provisório e o de fallback também deixam de ter emoji ("Nova conversa"). Títulos já gravados não são migrados.
