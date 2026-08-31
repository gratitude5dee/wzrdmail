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

deploy env:
    pnpm --filter @wzrdmail/api deploy:{{env}}

# M1 verification: seed inbox, send to PROBE_ADDRESS, reply, assert thread.
demo-roundtrip env="staging":
    npx tsx scripts/demo-roundtrip.ts {{env}}
