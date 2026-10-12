# Timeless Expression — Status

Página de estado dos serviços da Timeless Expression, alimentada inteiramente por GitHub Actions e GitHub Pages.

## Como funciona

| Peça | O que faz |
| --- | --- |
| [`sites.json`](sites.json) | Lista de websites monitorizados — **o único ficheiro que precisa de editar**. |
| [`scripts/monitor.mjs`](scripts/monitor.mjs) | Verifica cada site, calcula disponibilidade e regista incidentes. |
| [`.github/workflows/monitor.yml`](.github/workflows/monitor.yml) | Verifica os sites. É disparado a cada 5 minutos pelo [cron-job.org](https://cron-job.org) (ver abaixo); o cron do GitHub de 30 em 30 min é só uma reserva. |
| [`.github/workflows/pages.yml`](.github/workflows/pages.yml) | Publica a página (`site/`) no GitHub Pages. |
| [`site/`](site) | A página de estado. Lê os dados em direto do branch `data`. |

Os dados vivem num único commit no branch `data` (reescrito a cada verificação), por isso o histórico do `main` mantém-se limpo.

Quando um site falha, é aberta uma issue com a etiqueta `incidente` (o GitHub notifica quem segue o repositório) que fecha sozinha quando o serviço recupera.

## Adicionar um website

Edite `sites.json`:

```json
{
  "sites": [
    { "name": "Novo Serviço", "url": "https://exemplo.pt", "description": "Opcional" }
  ]
}
```

Campos opcionais por site:

| Campo | Predefinição | Descrição |
| --- | --- | --- |
| `slug` | gerado a partir do nome | Identificador estável (mantenha-o se mudar o nome, para não perder o histórico). |
| `method` | `GET` | Método HTTP. |
| `expectedStatus` | qualquer 2xx/3xx | Lista de códigos aceites, ex. `[200, 401]`. |
| `keyword` | — | Texto que tem de aparecer na resposta. |
| `timeout` | `15000` | Tempo limite em ms. |
| `degradedAfter` | `3000` | Acima deste tempo (ms) o site aparece como "Lento". |

## Domínio próprio

Em **Settings → Pages → Custom domain**, defina por exemplo `status.timelessexpression.pt` e crie um registo `CNAME` no DNS a apontar para `diogoalexsmachado.github.io`.

## Pré-visualizar localmente

```sh
node scripts/monitor.mjs sites.json site/data   # gera site/data/status.json
npx serve site                                   # ou qualquer servidor estático
```

## Agendamento (cron-job.org)

O cron do GitHub não é fiável, por isso o workflow `Monitor` é disparado de 5 em 5 minutos pelo cron-job.org:

- **URL:** `https://api.github.com/repos/diogoalexsmachado/timelessexpression-status/actions/workflows/monitor.yml/dispatches`
- **Método:** `POST` · **Corpo:** `{"ref":"main"}`
- **Cabeçalhos:** `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `Content-Type: application/json`
- **Token:** fine-grained, só com acesso a este repositório e a permissão **Actions: Read and write**. Resposta esperada: `204`.
