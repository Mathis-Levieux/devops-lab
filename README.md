# Chaos API

## Démarrage

```bash
docker compose up --build
```

L'API est disponible sur `http://localhost:3000`. PostgreSQL est persistant dans
le volume Docker `postgres_data`.

Routes principales : `GET /healthz`, `GET /readyz`, `GET /metrics`,
`GET|POST /items`, `POST /chaos/cpu?seconds=30`,
`POST /chaos/memory?mb=256` et `POST /chaos/hang`.

## Tests

```bash
cd app
npm test
```

Le serveur gère `SIGTERM` et `SIGINT` avec passage immédiat des probes en
indisponibilité, drainage des requêtes en cours, fermeture du serveur et du
pool PostgreSQL, avec délai maximal configurable via
`SHUTDOWN_TIMEOUT_MS`.