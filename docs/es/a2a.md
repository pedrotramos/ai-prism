<!-- i18n: source=docs/a2a.md source-hash=5dfc61f01a3c56f3c6aba10c55dfec98805dd59a status=machine -->
# Agentes A2A en AI Prism

[English](../a2a.md) · [Português (Brasil)](../pt-BR/a2a.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../a2a.md) es la referencia.

AI Prism llama a **agentes remotos mediante el protocolo A2A** (Agent2Agent, versión 1.0) como tools
en el chat. Un admin registra el agente una vez; desde entonces el modelo puede encargarle una tarea,
seguir su avance en streaming y usar la respuesta, y cada llamada se ejecuta con **la credencial del
propio usuario conectado**, nunca con el service principal de la app.

Esta página explica qué hace la función, cómo la activa un admin, cómo entran los usuarios a los
agentes, las reglas de seguridad y cómo probarla con un agente echo pequeño.

---

## Qué obtienes

- **Descubrimiento por card.** Le das a AI Prism la URL del card del agente (o el nombre de una
  Databricks App). Lee el Agent Card (`/.well-known/agent-card.json`), lo valida y muestra el nombre,
  la descripción, las skills y el inicio de sesión que el agente exige.
- **Envío de mensajes y streaming.** La llamada usa `SendMessage`, o `SendStreamingMessage` cuando el
  card dice que el agente hace streaming. Las actualizaciones de estado y los artefactos de la tarea
  vuelven al chat como resultado de la tool.
- **Agentes como tools del chat.** Cada agente habilitado en el catálogo se ofrece al modelo como una
  tool llamada `a2a__<slug>`. Un agente que el admin apaga desaparece de la lista de tools para todos.
- **Tres formas de iniciar sesión**, elegidas por agente al registrarlo (ver [Estrategias de autenticación](#estrategias-de-autenticación)).
- **Una tarjeta de autorización en el chat.** Cuando el agente necesita un inicio de sesión que el
  usuario aún no hizo, el turno se detiene con la tarjeta *Autorización necesaria*. El usuario autoriza
  en una ventana emergente y la respuesta se rehace. La misma tarjeta sirve para un servicio MCP que no
  está conectado para el usuario.
- **Una página de conexiones por usuario.** *Configuración → Conexiones MCP* tiene una sección
  *Agentes A2A* debajo de las conexiones MCP: conecta o desconecta cada proveedor de inicio de sesión y
  verifica cada agente con tu cuenta.

---

## Estrategias de autenticación

| Estrategia | A quién ve el agente | Adónde puede ir la credencial | Agente típico |
|---|---|---|---|
| `databricks-obo` | Al usuario conectado, mediante su token de Databricks (on-behalf-of) | Solo este workspace: su host, sus Databricks Apps (`*.databricksapps.com` de **este** workspace) y los hosts que el admin marcó con `databricks:` en `A2A_ALLOWED_HOSTS` | Otra Databricks App |
| `oauth2-user` | La cuenta del usuario en un proveedor de identidad externo (cualquier OIDC u OAuth 2.0), mediante authorization code + PKCE | Solo los hosts que coinciden con los `hostPatterns` de ese proveedor | Un agente detrás del IdP de la empresa o un SaaS |
| `none` | Nadie: no se envía ninguna credencial | Solo el origen del propio agente, y solo para un host que el admin permitió con una entrada simple en `A2A_ALLOWED_HOSTS` | Un agente público |

AI Prism elige la estrategia a partir del card y de la lista de hosts cuando el admin registra el
agente, y la vuelve a derivar del card actual antes de cada llamada. Un card que pide un proveedor de
identidad que ningún proveedor configurado cubre se rechaza: **nunca recurre al token de Databricks**.

### Databricks Apps (OBO)

Los scopes `user_authorization` de la app incluyen `apps` (`app.yaml`, y `databricks.yml` en el deploy
del bundle). Con él, el token del usuario llama a otra Databricks App del mismo workspace y esa App ve
al usuario real. Borra la línea `apps` para apagar el app-to-app. La App de destino debe dejar entrar a
ese usuario (su permiso `CAN_USE`); un rechazo aparece como *Sin acceso a este agente*.

La excepción `*.databricksapps.com` solo vale cuando AI Prism conoce el id de su propio workspace (el
runtime de Apps define `DATABRICKS_WORKSPACE_ID`, o el id se lee de `DATABRICKS_APP_URL`). Una App de
otro workspace nunca recibe el token del usuario por suposición.

### Proveedores externos (OAuth 2.0 authorization code + PKCE)

AI Prism ejecuta el inicio de sesión en una ventana emergente, con PKCE (S256) y un `state` de un solo
uso. Tras el intercambio comprueba la identidad (el ID token se verifica con las claves del proveedor
y, por defecto, el e-mail del proveedor debe ser el del usuario) y guarda los tokens **cifrados en
reposo** (AES-256-GCM; el dueño de la fila y el proveedor entran como dato autenticado, así que una
fila copiada a otro usuario o proveedor no se descifra). El navegador nunca recibe un token: la página
de la ventana solo informa un código de resultado fijo.

---

## Actívalo (admin)

1. **Permite el destino.** `A2A_ALLOWED_HOSTS` es una lista separada por comas de patrones
   `host[:puerto][/ruta]` (un `*.` al inicio coincide con una o más etiquetas):

   ```yaml
   env:
     # las entradas `databricks:` pueden recibir el token de Databricks del usuario (OBO).
     # Las entradas simples son agentes públicos (no se envía ninguna credencial).
     - name: A2A_ALLOWED_HOSTS
       value: 'databricks:agents.example-corp.com,public-agent.example.org'
   ```

   Los hosts de este workspace y sus Databricks Apps no necesitan entrada. Sin una regla que coincida,
   el host se rechaza, diga lo que diga el card.

2. **Para `oauth2-user`, configura un proveedor** (un array JSON en `A2A_OAUTH_PROVIDERS`), la clave de
   cifrado y la base del redirect:

   ```yaml
   - name: A2A_OAUTH_PROVIDERS
     value: >-
       [{"id":"corp-idp","name":"Corp IdP","issuer":"https://idp.example-corp.com",
         "clientId":"ai-prism","clientSecretEnv":"CORP_IDP_SECRET",
         "scopes":["openid","email","agents.invoke"],
         "hostPatterns":["agents.example-corp.com"]}]
   - name: CORP_IDP_SECRET
     valueFrom: 'corp-idp-secret'          # un secret resource, nunca un literal
   - name: A2A_TOKEN_ENC_KEY
     valueFrom: 'a2a-token-key'            # 32 bytes aleatorios en base64 o 64 caracteres hex
   - name: A2A_OAUTH_REDIRECT_BASE         # solo cuando difiere de DATABRICKS_APP_URL
     value: 'https://my-app.example.com'
   ```

   Registra `<URL de la app>/api/a2a/oauth/<id del proveedor>/callback` como redirect URI en el
   proveedor (*Configuración → Herramientas → Agentes A2A*, solo para admin, muestra el valor exacto por
   proveedor). Campos del proveedor:

   | Campo | Significado |
   |---|---|
   | `id` | `[a-z0-9_-]`, hasta 32 caracteres. Forma parte de la URL de callback |
   | `issuer` | Issuer OIDC; los endpoints salen del documento de discovery. O indica `authorizationEndpoint` + `tokenEndpoint` (y, si quieres, `userinfoEndpoint`, `jwksUri`, `revocationEndpoint`) |
   | `clientId`, `clientSecretEnv` | El client OAuth. El secreto se lee de la variable de entorno **nombrada** aquí; omítelo en un client público (`tokenEndpointAuthMethod: none`) |
   | `scopes` | Por defecto `openid email` en OIDC |
   | `hostPatterns` | Adónde puede enviarse el token. Cada entrada es un patrón, o `{ "pattern": "...", "send": "access-token" \| "id-token" }` |
   | `requireEmailMatch` | Por defecto `true`: el e-mail verificado de la cuenta del proveedor debe ser igual al del usuario |
   | `idTokenHeader` | Nombre de cabecera extra, opcional. Un patrón con `send: "id-token"` pasa a recibir también ahí el ID token (para un gateway que lo comprueba antes de reenviar) |
   | `authParams` | Parámetros extra de la solicitud de autorización (nunca `state`, `code_challenge` ni los demás del protocolo) |

   Sin `A2A_TOKEN_ENC_KEY` la estrategia queda apagada y el panel del admin lo indica.

3. **Registra el agente.** *Configuración → Herramientas → Agentes A2A* (admin): pega la URL del card,
   o el nombre de una Databricks App de este workspace, y pulsa *Registrar*. AI Prism lee el card sin
   ninguna credencial, deriva la estrategia y lista el agente con su estado. *Verificar de nuevo*
   vuelve a leer el card; el interruptor ofrece u oculta el agente; *Quitar* lo saca del catálogo. El
   inicio de sesión pertenece al proveedor, no al agente, así que quitar un agente conserva las
   conexiones de los usuarios.

Otros límites (todos opcionales): `A2A_REQUEST_TIMEOUT_MS`, `A2A_STREAM_TIMEOUT_MS`,
`A2A_MAX_RESPONSE_BYTES` y `A2A_ALLOW_INSECURE_LOCAL=1` (http a loopback, **solo para desarrollo
local**).

---

## Para los usuarios

- Pide en el chat algo que hace un agente. Si el agente necesita un inicio de sesión, aparece la
  tarjeta *Autorización necesaria*. Pulsa *Autorizar con …*, completa la ventana emergente y la
  respuesta se rehace.
- *Configuración → Conexiones MCP → Agentes A2A* lista los inicios de sesión y los agentes. *Verificar*
  prueba un agente con tu propia cuenta; *Desconectar* pide al proveedor que revoque la concesión y
  borra los tokens cifrados. Si el proveedor no confirma la revocación, la conexión se conserva y
  puedes usar *Quitar aquí de todos modos*.

---

## Reglas de seguridad

- **Nunca la identidad de la app.** Toda estrategia usa la credencial del usuario final para el destino.
- **Una audiencia por credencial.** Una credencial solo va a los hosts que su estrategia permite
  (tabla de arriba); se adjunta en el transporte y nunca se copia al contexto del modelo, a los logs ni
  al navegador.
- **Salida protegida** (`server/a2aGuard.ts`, compartido con las reglas anti-SSRF de `web_fetch`):
  solo https (http a loopback solo con `A2A_ALLOW_INSECURE_LOCAL=1`), el destino debe cumplir la lista
  de la estrategia, cada dirección resuelta se comprueba al conectar (loopback, link-local, metadata,
  ULA y otros rangos reservados se bloquean; los rangos privados solo para un host comprobado del
  workspace), los redirects nunca se siguen, las solicitudes tienen timeout, los cuerpos tienen
  límite y las cabeceras enviadas se reconstruyen a partir de una lista corta.
- **Tokens en reposo.** `a2a_oauth_tokens` es solo del dueño bajo row-level security (ni un admin lo
  lee) y sus columnas se cifran con AES-256-GCM. Perder la clave significa que los usuarios inician
  sesión de nuevo.
- **Salida no confiable.** Lo que devuelve un agente es dato, no instrucción: se envuelve y trunca
  como otros resultados de tool, y el texto del card (nombre, descripción, skills) se sanea y se cita
  como metadato antes de llegar al prompt.
- **Auditoría.** Registrar, habilitar y quitar un agente quedan en el registro de auditoría de admin
  (`a2a.agent.add`, `a2a.agent.update`, `a2a.agent.remove`).

Ver el [modelo de amenazas](security-threat-model.md) (TB6) y las [preguntas frecuentes de seguridad](security-faq.md).

---

## Pruébalo con el agente echo

`server/testing/a2aEchoAgent.ts` es un agente A2A 1.0 diminuto que usan las pruebas. Repite tu mensaje
y tiene palabras de disparo: `input needed` (la tarea pide más información), `fail` (la tarea falla) y
`slow` (sigue trabajando unos 20 s, salvo que se cancele).

En local, con AI Prism en modo dev:

```bash
A2A_ALLOW_INSECURE_LOCAL=1 A2A_ALLOWED_HOSTS=127.0.0.1:4590 \
  node -e "import('./server/testing/a2aEchoAgent.ts').then(m => m.startEchoAgent({ port: 4590, streaming: true }))"
```

luego registra `http://127.0.0.1:4590/.well-known/agent-card.json` en *Configuración → Herramientas →
Agentes A2A* y pide al modelo que *le pida al agente echo que diga hola*.

Como Databricks App (para ver el camino OBO de punta a punta), el mismo agente está empaquetado en
`examples/a2a-echo/`. Despliégalo como una App propia, dale `CAN_USE` al usuario y registra el nombre
de la App. Borra la App cuando termines.

---

## Referencia

| Ajuste | Dónde | Para qué |
|---|---|---|
| `apps` | `user_authorization` en `app.yaml`, `databricks.yml` | Deja que el token del usuario llame a otra Databricks App (OBO) |
| `A2A_ALLOWED_HOSTS` | env | prefijo `databricks:` = puede recibir el token de Databricks; entrada simple = agente público |
| `A2A_OAUTH_PROVIDERS` | env (JSON) | Proveedores de inicio de sesión externos |
| `A2A_TOKEN_ENC_KEY` | env (secret) | Clave de 32 bytes (base64 o hex) que sella los tokens guardados |
| `A2A_OAUTH_REDIRECT_BASE` | env | URL pública base del callback; por defecto `DATABRICKS_APP_URL` |
| `A2A_REQUEST_TIMEOUT_MS`, `A2A_STREAM_TIMEOUT_MS`, `A2A_MAX_RESPONSE_BYTES` | env | Límites de salida |
| `A2A_ALLOW_INSECURE_LOCAL` | env | `1` permite http a loopback (solo desarrollo) |

| Ruta | Quién | Para qué |
|---|---|---|
| `GET /api/a2a/agents` | cualquier usuario | Catálogo con el estado de este usuario por agente |
| `POST /api/a2a/agents`, `POST /api/a2a/agents/:id/verify`, `PUT /api/a2a/agents/:id/enabled`, `DELETE /api/a2a/agents/:id` | admin | Registrar, releer el card, ofrecer u ocultar, quitar |
| `POST /api/a2a/agents/:id/check` | cualquier usuario | Probar un agente con la credencial del propio usuario |
| `GET /api/a2a/providers`, `GET /api/admin/a2a/providers` | usuario, admin | Proveedores (la vista de admin suma el redirect URI y los errores de configuración) |
| `GET /api/a2a/oauth/:provider/start`, `GET /api/a2a/oauth/:provider/callback`, `DELETE /api/a2a/oauth/:provider` | usuario | Inicio de sesión en ventana emergente, callback, desconectar |
