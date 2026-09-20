# wzrdmail dev recipes (§17/§19)

install:
    pnpm install

dev:
    pnpm --filter @wzrdmail/api dev

typecheck:
    pnpm typecheck

lint:
    pnpm lint

test:
    pnpm test

check:
    pnpm check

setup env="dev":
    npx tsx scripts/setup.ts {{env}}

# The API must be deployed (and migrated) before the MCP Worker: the consent
# flow's connect endpoints have to exist before anything can authorize against
# them. See muse.md §9.1.
deploy env:
    pnpm --filter @wzrdmail/api deploy:{{env}}

deploy-mcp env:
    pnpm --filter @wzrdmail/mcp deploy:{{env}}

deploy-docs env:
    pnpm --filter @wzrdmail/docs deploy:{{env}}
    pnpm --filter @wzrdmail/www deploy:{{env}}

# M1 verification: seed inbox, send to PROBE_ADDRESS, reply, assert thread.
demo-roundtrip env="staging":
    npx tsx scripts/demo-roundtrip.ts {{env}}
