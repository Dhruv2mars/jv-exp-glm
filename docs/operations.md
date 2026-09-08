# Operations

How to run, back up, and deploy the Javelin data plane.

## Run javelind and web locally

From the repository root:

```sh
bun install
bun run apps/javelind/src/main.ts --port 8080 --root ./javelind-data
bun run apps/web/src/main.ts --javelind http://localhost:8080 --port 3000
```

Both processes accept the same values as environment variables: `JAVELIND_PORT`, `JAVELIND_ROOT`, `JAVELIND_TOKEN` for javelind; `JAVELIND_URL`, `WEB_PORT`, `JAVELIN_TOKEN` for web.

## Token auth

Passing a token to javelind turns on bearer auth for every JRP request:

```sh
JAVELIND_TOKEN=secret bun run apps/javelind/src/main.ts
JAVELIN_TOKEN=secret bun run apps/web/src/main.ts
```

CLI remotes carry their own token:

```sh
javelin remote add origin http://localhost:8080/myrepo --token secret
```

An empty or unset token disables auth; that is fine for local development only.

## Backup and restore

Backup is a plain recursive file copy of every repository directory in a javelind root into a timestamped archive directory (no tar). Stop javelind first, or accept that a copy taken while writers are active may be torn; objects are immutable and refs are atomically renamed, so a quiescent root always copies consistently.

```sh
bun run ops/backup.ts --root ./javelind-data --archive ./backups
bun run ops/restore.ts --archive ./backups/<timestamp> --root ./javelind-restored
```

Backup prints the archive path and repository list; a `manifest.json` inside the archive records both. Restore refuses to write into a non-empty root, so recovery means pointing javelind at a fresh root directory (`--root ./javelind-restored`) after moving the damaged one aside.

`bun test ops` covers the round trip: a real javelind server root seeded through git-bridge, backed up, deleted, restored, and compared ref by ref.

## Deploy with Docker Compose

```sh
docker compose -f ops/docker-compose.yml up --build
```

That starts javelind on port 8080 with its repository root on the `javelind-data` volume, and the web app on port 3000 with `JAVELIND_URL=http://javelind:8080`. The images build from `ops/Dockerfile` and `ops/Dockerfile.web`; both run the TypeScript entrypoints directly under Bun, no build step. To require tokens, uncomment the `JAVELIND_TOKEN` environment block in `ops/docker-compose.yml` and set the same value for the web service.

## Limitations

- **No multi-process ref locking.** Ref updates are serialized in-process per repository. Running more than one javelind against the same root can interleave compare-and-swap updates; run one process per root.
- **Loose object storage.** Every object is its own file. Large repositories pay filesystem overhead per object; there is no packing or garbage collection yet.
- **No TLS.** Serve behind a reverse proxy if you need transport encryption. Tokens travel as plain bearer headers.
- **UTF-8 blob framing.** Blobs cross JRP as UTF-8 strings, so arbitrary binary files can be corrupted on round trip. Text content is safe; keep binaries out until framing becomes byte-exact.
