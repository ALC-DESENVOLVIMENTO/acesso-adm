# Integração Portal Administrativo <-> pdfonline

## Contrato criado no Portal Administrativo

- `GET /api/integrations/pdfonline/compatibility-map`
- `GET /api/integrations/pdfonline/bridge?identifier=...`
- `POST /api/integrations/pdfonline/sync`

Arquivos principais:
- [apps/api/src/modules/integrations/pdfonline.routes.ts](../apps/api/src/modules/integrations/pdfonline.routes.ts)
- [apps/api/src/app.ts](../apps/api/src/app.ts)

## Autorização

Se o `PDFONLINE_BRIDGE_TOKEN` estiver definido no Portal Administrativo, envie um destes cabeçalhos:

- `Authorization: Bearer <token>`
- `x-bridge-token: <token>`
- `x-pdfonline-bridge-token: <token>`
- `x-portal-pdfonline-token: <token>`

## Exemplo para colar no projeto `pdfonline`

```js
const PORTAL_ADMIN_BASE_URL = process.env.PORTAL_ADMIN_BASE_URL || process.env.ACCESS_ADM_URL || '';
const PORTAL_ADMIN_TOKEN = process.env.PORTAL_ADMIN_TOKEN || process.env.PDFONLINE_BRIDGE_TOKEN || '';

function buildPortalAdminHeaders() {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (PORTAL_ADMIN_TOKEN) {
    headers.authorization = `Bearer ${PORTAL_ADMIN_TOKEN}`;
    headers['x-bridge-token'] = PORTAL_ADMIN_TOKEN;
    headers['x-pdfonline-bridge-token'] = PORTAL_ADMIN_TOKEN;
    headers['x-portal-pdfonline-token'] = PORTAL_ADMIN_TOKEN;
  }

  return headers;
}

async function fetchPortalAdminBridge(identifier) {
  if (!PORTAL_ADMIN_BASE_URL) {
    throw new Error('PORTAL_ADMIN_BASE_URL nao configurada');
  }

  const url = new URL('/api/integrations/pdfonline/bridge', PORTAL_ADMIN_BASE_URL);
  if (identifier) {
    url.searchParams.set('identifier', identifier);
  }

  const response = await fetch(url, {
    headers: buildPortalAdminHeaders()
  });

  if (!response.ok) {
    throw new Error(`Portal Administrativo bridge falhou: ${response.status}`);
  }

  return response.json();
}

async function syncPortalAdminBridge(payload) {
  if (!PORTAL_ADMIN_BASE_URL) {
    throw new Error('PORTAL_ADMIN_BASE_URL nao configurada');
  }

  const response = await fetch(new URL('/api/integrations/pdfonline/sync', PORTAL_ADMIN_BASE_URL), {
    method: 'POST',
    headers: buildPortalAdminHeaders(),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Portal Administrativo sync falhou: ${response.status}`);
  }

  return response.json();
}
```

## Payload de retorno do Portal Administrativo

O bridge retorna:

- `identity.motorista`
- `identity.usuario`
- `uploadsPdf`
- `driverPdfReceived`
- `atendimentos`
- `chamados`
- `notas`
- `periodos`
- `summary`

## Ordem recomendada de uso

1. O `pdfonline` chama `GET /api/integrations/pdfonline/bridge`.
2. O `pdfonline` processa ou complementa os dados.
3. O `pdfonline` chama `POST /api/integrations/pdfonline/sync` com o retorno consolidado.
4. O Portal grava auditoria e devolve novamente a ponte atualizada.
