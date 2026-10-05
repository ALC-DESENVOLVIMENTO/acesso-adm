# Integracao de bases ARCHI -> Portal Administrativo

O ARCHI e a fonte oficial do cadastro de bases. O Portal armazena uma copia em
`portal_administrativo.archi_bases`; esta integracao nao altera `bases_pagamento`
nem periodos financeiros existentes.

## Configuracao Railway (production)

- ARCHI: `ACCESS_ADM_WEBHOOK_TOKEN` (mesmo valor do Portal),
  `ACCESS_ADM_WEBHOOK_SECRET` (mesmo valor do Portal) e
  `ACCESS_ADM_BASES_WEBHOOK_URL=https://portal-administrativo.up.railway.app/api/webhooks/archi/bases`.
- Portal: `ACCESS_ADM_WEBHOOK_TOKEN`, `ACCESS_ADM_WEBHOOK_SECRET` e
  `ARCHI_BASE_URL=https://alc-archi-production.up.railway.app`.

Os valores de token e secret devem ser configurados apenas como variaveis de
ambiente. Nunca devem ir para o frontend ou para o repositorio.

## Contrato

- Eventos: `POST /api/webhooks/archi/bases` no Portal.
- Eventos aceitos: `archi.base.created`, `archi.base.updated`, `archi.base.deleted`.
- Cabecalhos: `X-Webhook-Token` e, quando o secret esta configurado,
  `X-Webhook-Signature` com HMAC-SHA256 hexadecimal do corpo JSON bruto.
- Corpo: `{ event, eventId, data, meta: { source: "archi", occurredAt } }`.
- `data`: `externalId`, `code`, `name`, `baseType`, `location`, `manager`,
  `operation`, `status`, `paymentFrequencies` e `createdAt`.
- `paymentFrequencies`: array com zero ou mais de `Semanal`, `Quinzenal`,
  `Mensal`. Array vazio significa que a base ainda nao foi configurada no ARCHI.
- `externalId` e a chave estavel; eventos repetidos ou mais antigos nao
  sobrescrevem eventos mais recentes. Exclusoes preservam o registro com
  `deleted: true` para auditoria.

## Carga inicial e consulta

1. Apos publicar ambos os servicos e configurar as variaveis, chamar
   `POST https://portal-administrativo.up.railway.app/api/webhooks/archi/bases/sync`
   com o mesmo token e assinatura do corpo `{}` (se houver secret).
2. O Portal busca a lista real em
   `GET https://alc-archi-production.up.railway.app/api/integrations/access-adm/bases`
   com `X-Webhook-Token`.
3. Usuarios autorizados do Portal consultam a copia com seu Bearer de sessao em
   `GET https://portal-administrativo.up.railway.app/api/webhooks/archi/bases`.

O endpoint de consulta retorna `{ bases: [...] }`, incluindo `deleted` e
`syncedAt`. Nao consultar diretamente o banco do ARCHI nem usar o token de
integracao no navegador.
