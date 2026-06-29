# Changelog

## [0.4.0](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.3.3...v0.4.0) (2026-06-29)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.4.0`

### Changes

- Bump Bitsocial runtime dependencies ([e49cf00](https://github.com/bitsocialnet/bitsocial-seeder/commit/e49cf0060d0d2e433d28ef706f45edc72ac3d89d))
- Warn when reusing stale external daemons ([22fa5af](https://github.com/bitsocialnet/bitsocial-seeder/commit/22fa5afc40e0b461aaec51c5b10379aaf8780be0))
- chore: release 0.4.0 ([6924772](https://github.com/bitsocialnet/bitsocial-seeder/commit/6924772014663e4fa6fa2c69e7f9c72f68b36ab9))

## [0.3.3](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.3.2...v0.3.3) (2026-06-26)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.3.3`

### Changes

- chore: upgrade @bitsocial/bitsocial-cli to 0.19.78 ([7634761](https://github.com/bitsocialnet/bitsocial-seeder/commit/7634761e9cc8377bf691a133300eb6124c878759))
- chore: upgrade @bitsocial/bitsocial-cli to 0.19.79 ([5227c5b](https://github.com/bitsocialnet/bitsocial-seeder/commit/5227c5ba0211065193918fbc151cbafe9710fc3d))

## [0.3.2](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.3.1...v0.3.2) (2026-06-18)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.3.2`

### Changes

- fix: continue pubsub provides when pins already exist ([03a13bd](https://github.com/bitsocialnet/bitsocial-seeder/commit/03a13bdcdad3abbf8ac4329464698d0f7e033f3f))

## [0.3.1](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.3.0...v0.3.1) (2026-06-15)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.3.1`

### Changes

- chore: update bitsocial runtime for v0.3.1 ([20ebfdd](https://github.com/bitsocialnet/bitsocial-seeder/commit/20ebfdd3d76381d248083369d0985064c93c1588))

## [0.3.0](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.2.0...v0.3.0) (2026-05-31)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.3.0`

### Changes

- docs: add Setup section with step-by-step quick-start ([3383993](https://github.com/bitsocialnet/bitsocial-seeder/commit/3383993fbb901ce3fc47868f46cc3286c356d7da))
- Add extra community list sources ([1aa01dc](https://github.com/bitsocialnet/bitsocial-seeder/commit/1aa01dc69565e6d3db482c0b7a366a88f3b5f2b8))

## [0.2.0](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.1.3...v0.2.0) (2026-05-27)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.2.0`

### Changes

- feat: persist seeder state and durable work queues in SQLite via honker ([9a126ab](https://github.com/bitsocialnet/bitsocial-seeder/commit/9a126ab2e4c2489f46a6b6218d446386f85292e0))
- docs: position seeder as supplemental and document SQLite migration ([1529699](https://github.com/bitsocialnet/bitsocial-seeder/commit/1529699655637601a84e325be20ebb52953df264))
- fix: re-enqueue discover-tick on each wait iteration to prevent boot hang ([c2c4030](https://github.com/bitsocialnet/bitsocial-seeder/commit/c2c40301457751eec52f3dcfeae5c7c17643b23f))
- refactor: extract pubsub-routing throttle helper to dedupe enqueue logic ([fc68636](https://github.com/bitsocialnet/bitsocial-seeder/commit/fc68636b072edcd61c93de556aef1b26ab6ceadd))
- fix: clear communities table when setCommunitiesSeeding is called with [] ([57a2cf6](https://github.com/bitsocialnet/bitsocial-seeder/commit/57a2cf654177618cbed1da9dfdc25c0006dbe44f))

## [0.1.3](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.1.2...v0.1.3) (2026-05-26)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.1.3`

### Changes

- feat: alert when seeder updates are available ([a04e129](https://github.com/bitsocialnet/bitsocial-seeder/commit/a04e12900c34f376abb3026dbb105c06564e3d0d))

## [0.1.2](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.1.1...v0.1.2) (2026-05-26)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.1.2`

### Changes

- fix: seed pubsub routing cids ([e703be5](https://github.com/bitsocialnet/bitsocial-seeder/commit/e703be5ffa70142f5d8a9c56a6ddf60b0e55e2e6))
- chore: pin latest bitsocial runtime deps ([9ffe19b](https://github.com/bitsocialnet/bitsocial-seeder/commit/9ffe19b1ccdc3a80c17355ee6d4e9035cb36e918))
- chore: publish seeder package from release ci ([408d615](https://github.com/bitsocialnet/bitsocial-seeder/commit/408d6156e342e1d00588b726e26d463f77ac2a55))
- fix: include optional websocket deps in release lockfile ([3a3db99](https://github.com/bitsocialnet/bitsocial-seeder/commit/3a3db9934969b6cd3dfdda06b74543b5f9b7c3ed))

## [0.1.1](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.1.0...v0.1.1) (2026-05-24)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.1.1`

### Changes

- feat: autostart bundled bitsocial daemon ([10fd76e](https://github.com/bitsocialnet/bitsocial-seeder/commit/10fd76e82a3f18a35ecc4cfac9362002c248db2b))
- Update README.md ([4d50d5d](https://github.com/bitsocialnet/bitsocial-seeder/commit/4d50d5dddda61f1a277030e1316ed3f3876682bb))
- fix: include optional websocket deps in lockfile ([8ece52b](https://github.com/bitsocialnet/bitsocial-seeder/commit/8ece52b5259947f7484c1752a0ecc2761d439352))

## [0.1.0](https://github.com/bitsocialnet/bitsocial-seeder/releases/tag/v0.1.0) (2026-05-23)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.1.0`

### Changes

- Initial bitsocial seeder ([748ef62](https://github.com/bitsocialnet/bitsocial-seeder/commit/748ef62568e9108c82455175d6cd3b6e6bb96178))
- Avoid redundant pin churn ([d28cec3](https://github.com/bitsocialnet/bitsocial-seeder/commit/d28cec3072d6981487d5bd6a9413a195252e9fb2))
- Make systemd limits configurable ([9dcec0f](https://github.com/bitsocialnet/bitsocial-seeder/commit/9dcec0faa1c9297ed78bdadb7cc9c2b109537e1b))
- Add Docker deployment ([e439403](https://github.com/bitsocialnet/bitsocial-seeder/commit/e439403b935d605a830635bd328fc21559412d2b))
- Fix Docker npm ci lockfile ([c56e1aa](https://github.com/bitsocialnet/bitsocial-seeder/commit/c56e1aac88b2398975c8937b63dd9129535b0611))
- Add release automation ([4ad9211](https://github.com/bitsocialnet/bitsocial-seeder/commit/4ad92110c25b9f3fc05db2a54a94eefd679fb61e))
