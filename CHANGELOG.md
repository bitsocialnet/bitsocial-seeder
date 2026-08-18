# Changelog

## [0.10.2](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.10.0...v0.10.2) (2026-08-18)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.10.2`

### Changes

- chore(deps): bump bitsocial-cli to 0.19.92 and pkc-js to 0.0.83 ([d02d993](https://github.com/bitsocialnet/bitsocial-seeder/commit/d02d9939c31cf99feb99a7341b8813e4466c4692))
- chore(deps): upgrade honker-node to 0.4.5, drop patch-package ([029e584](https://github.com/bitsocialnet/bitsocial-seeder/commit/029e5843f3fcc4a0d6a30d391819040c4b32a089))
- fix(docker): drop patches COPY, add libsqlite3 for honker 0.4.5 ([167ccc6](https://github.com/bitsocialnet/bitsocial-seeder/commit/167ccc6288d817093d7dce9d0515810155939537))
- chore(deps): upgrade bitsocial-cli, pkc-js and honker-node, release 0.10.1 ([5fba06d](https://github.com/bitsocialnet/bitsocial-seeder/commit/5fba06da51fb1975495aeddbebf4b0c45dd1e488))
- ci(release): derive the version from conventional commits ([8de0c4b](https://github.com/bitsocialnet/bitsocial-seeder/commit/8de0c4b2168585e2257aad5d2cbab09d60c8fdb7))

## [0.10.0](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.9.0...v0.10.0) (2026-08-17)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.10.0`

### Changes

- feat(votes)!: upgrade @bitsocial/pubsub-voting to 0.5.0, release 0.10.0 ([188980d](https://github.com/bitsocialnet/bitsocial-seeder/commit/188980d602ce89e5a746a60210da32e89b8f4d75))

## [0.9.0](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.8.2...v0.9.0) (2026-08-09)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.9.0`

### Changes

- chore(deps): bump @bitsocial/pubsub-voting to 0.3.0, release 0.9.0 ([31d1ebc](https://github.com/bitsocialnet/bitsocial-seeder/commit/31d1ebc8f651116409521ce16372178f4da0fb9d))

## [0.8.2](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.8.1...v0.8.2) (2026-08-08)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.8.2`

### Changes

- chore(deps): upgrade the bundled bitsocial-cli and pkc-js, release 0.8.2 ([8c185c1](https://github.com/bitsocialnet/bitsocial-seeder/commit/8c185c1335c0e932f4356e7bb8c5b6f815cc42ed))

## [0.8.1](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.8.0...v0.8.1) (2026-08-07)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.8.1`

### Changes

- chore(deps): upgrade the bundled bitsocial-cli and pkc-js, release 0.8.1 ([27d0b26](https://github.com/bitsocialnet/bitsocial-seeder/commit/27d0b2634dad2f76de55684ebc483732af97dbbc))

## [0.8.0](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.7.0...v0.8.0) (2026-08-07)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.8.0`

### Changes

- feat!: upgrade @bitsocial/pubsub-voting to 0.2.0 (ERC-5192 gate) ([d0edb7b](https://github.com/bitsocialnet/bitsocial-seeder/commit/d0edb7bf5bccccb88506cee75302be79a02d9afe))
- chore: release 0.8.0 ([dc5d416](https://github.com/bitsocialnet/bitsocial-seeder/commit/dc5d4168066f77db69249156bf0c0638808cdbbe))

## [0.7.0](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.6.1...v0.7.0) (2026-07-30)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.7.0`

### Changes

- fix: a votes-only seeder no longer requires or starts a bitsocial daemon ([6d89977](https://github.com/bitsocialnet/bitsocial-seeder/commit/6d89977e1d6d05909e0c6fd476a055cf2b8b0b40))
- chore: release 0.7.0 ([b1219a8](https://github.com/bitsocialnet/bitsocial-seeder/commit/b1219a85a4886b3747ffb092fc9ca68a8c09af0a))

## [0.6.1](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.6.0...v0.6.1) (2026-07-30)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.6.1`

### Changes

- fix(votes): describe bulk root answers in the fetch-serve log ([07350a6](https://github.com/bitsocialnet/bitsocial-seeder/commit/07350a64c6a8b1b14344a6ad8601a79bbfd18ecc))
- chore: release 0.6.1 ([96fa67f](https://github.com/bitsocialnet/bitsocial-seeder/commit/96fa67f563a42354fa9ce4ad272ff7d5d2a498b0))

## [0.6.0](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.5.0...v0.6.0) (2026-07-29)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.6.0`

### Changes

- Update README.md ([e6d3d9f](https://github.com/bitsocialnet/bitsocial-seeder/commit/e6d3d9f9574facdec4d161c3b74e726d1016bed9))
- feat: seed @bitsocial/pubsub-votes directory contests ([8300f28](https://github.com/bitsocialnet/bitsocial-seeder/commit/8300f2869bda14b33232ac73ebdf2ea92accce8a))
- chore: upgrade @bitsocial/bitsocial-cli to 0.19.84 ([dfe3dab](https://github.com/bitsocialnet/bitsocial-seeder/commit/dfe3dabb6fb87a3d59bd10fe4ed0330d9e4d46db))
- chore: remove @pkcprotocol/pkc-js override ([0b8748c](https://github.com/bitsocialnet/bitsocial-seeder/commit/0b8748cf1d0e9a23b48d84ae6506d85fd42b4ed8))
- refactor(votes): Helia-only seeding — own blockstore, library announcer, npm pin ([9c95271](https://github.com/bitsocialnet/bitsocial-seeder/commit/9c952711d7955453a334b61efe61c562bbf0c0dd))
- feat: pubsub-voting 0.1.2, AutoTLS browser reachability, memoized chain clients ([44ff924](https://github.com/bitsocialnet/bitsocial-seeder/commit/44ff924f381536a5f1748589314d767872db5138))
- refactor(votes): AutoTLS always on, drop VOTES_PUBLIC_IP/VOTES_AUTO_TLS ([1380dec](https://github.com/bitsocialnet/bitsocial-seeder/commit/1380decfd28c1b04390cba1803d2a0132d11f398))
- fix: start.js imported checkForRuntimeDependencyUpdates but update-check.js exports checkRuntimeDependencyUpdates ([54b3b48](https://github.com/bitsocialnet/bitsocial-seeder/commit/54b3b48b23c19c5ec0bd1bbd7b3843e80de137a7))
- feat(votes): borrow the daemon Kubo's confirmed public IP for announces and AutoTLS ([d9a1ebf](https://github.com/bitsocialnet/bitsocial-seeder/commit/d9a1ebfedef1b6d858d6c4890f909b74a310906b))
- fix(votes): auto-confirm the AutoTLS /dns4 addr so it reaches the router announces ([809b031](https://github.com/bitsocialnet/bitsocial-seeder/commit/809b031fd659562bcc3356db6a249a28639fb913))
- feat(votes): chain-RPC health probe + decoded bundle and root-change logging ([03fcd5f](https://github.com/bitsocialnet/bitsocial-seeder/commit/03fcd5fa4b40ad05c430cbfe34f0f6c82ba0b028))
- feat(votes): parallel RPC racing + bitsocial-cli's six-RPC eth default ([514186a](https://github.com/bitsocialnet/bitsocial-seeder/commit/514186ab9215c27e3a9861c758dc362bb87dfb05))
- test(votes): pin chain-client behavior and wire-log decoding ([ca38049](https://github.com/bitsocialnet/bitsocial-seeder/commit/ca380490efb4a8c149365411fa1b12be188b29f9))
- feat(votes): log EIP-55 checksummed addresses so lines match wallet displays ([1b2d731](https://github.com/bitsocialnet/bitsocial-seeder/commit/1b2d731a4686456bf5b626b40d2aabae2e8c1f26))
- fix: sync package-lock (uint8arrays 5.1.1) so npm ci passes ([3234442](https://github.com/bitsocialnet/bitsocial-seeder/commit/3234442fb90f4d2831105920212304ead0f80b1c))
- feat: migrate codebase to TypeScript (erasable syntax, Node 24 type stripping) ([3ce1ce9](https://github.com/bitsocialnet/bitsocial-seeder/commit/3ce1ce971f2a85d4f7538c1ace62fa608c30d779))
- test: cover pin reconciliation, seeder state, list fetching; add daemon e2e ([74aec4f](https://github.com/bitsocialnet/bitsocial-seeder/commit/74aec4f68fb1ec9e38d083ad68a7effd4d90756a))
- test(daemon): cover edge cases with fake RPC servers; fix SIGKILL escalation ([9149903](https://github.com/bitsocialnet/bitsocial-seeder/commit/9149903f043857a8fb0ba18c079a4d68beabe96f))
- test: add start.ts boot smoke test ([5db0ce7](https://github.com/bitsocialnet/bitsocial-seeder/commit/5db0ce7f1e6f932c701c45c5f7810e934cdcc78c))
- test(daemon-e2e): cover content pins end-to-end ([02f8eb6](https://github.com/bitsocialnet/bitsocial-seeder/commit/02f8eb6dcaf25afe6819e687a306512c5e70e5c5))
- test(discover): pin source-failure behavior ([fbcb563](https://github.com/bitsocialnet/bitsocial-seeder/commit/fbcb56306114d40a55f38aa44e84b147a2741641))
- docs(readme): sync defaults with code; document missing env vars ([72c508b](https://github.com/bitsocialnet/bitsocial-seeder/commit/72c508b88955b1d100643d62c34e52159d0e697b))
- test: cover votes node/seeder, bitsocial clients, and remaining helpers ([da1e2cc](https://github.com/bitsocialnet/bitsocial-seeder/commit/da1e2cc35710b14fa7a55b9cd44a847592d2cd90))
- chore(deps): bump pubsub-voting to 0.1.4 and pkc-js to 0.0.72 ([a617064](https://github.com/bitsocialnet/bitsocial-seeder/commit/a61706484b8c280e793f1528e5b53819ddeb4e75))
- mitigate honker-node AbortSignal listener leak via patch-package ([9afad85](https://github.com/bitsocialnet/bitsocial-seeder/commit/9afad85e219c3218f2dc3d39cd3bcd8534a89676))
- pin patch-package to exact 8.0.1 ([63fa405](https://github.com/bitsocialnet/bitsocial-seeder/commit/63fa40587c63a565d685621cc81c55038a99eaf5))
- fix: let a zero-community discovery finish boot (votes-only seeder) ([6c4af3c](https://github.com/bitsocialnet/bitsocial-seeder/commit/6c4af3c37a464c835dccd89a3294860457fdc723))
- serve the Kubo peer's browser-dialable addrs over a votes fetch key (bitsocial-seeder/peers) ([0b62fae](https://github.com/bitsocialnet/bitsocial-seeder/commit/0b62faeae6366cc892dfb3d8b192569f74aa77b8))
- chore(deps): bump pubsub-voting to 0.1.5 ([acea05a](https://github.com/bitsocialnet/bitsocial-seeder/commit/acea05a926fb177f3843afbf6ade90caf58351fe))
- feat(votes): seed the published 5chan directory manifest by default ([4605d2c](https://github.com/bitsocialnet/bitsocial-seeder/commit/4605d2c0f3642852c58e6167b4868a930c017ec7))
- chore: release 0.6.0 ([0c74c00](https://github.com/bitsocialnet/bitsocial-seeder/commit/0c74c00cf354b680f54f623c84b4f71c01b7aa73))
- fix(docker): apply patches in the image and unbreak the build ([5e24da1](https://github.com/bitsocialnet/bitsocial-seeder/commit/5e24da1fb1eb0beb825d7dc59097e6500fd5e901))
- ci: install dependencies in the release job ([2e96725](https://github.com/bitsocialnet/bitsocial-seeder/commit/2e96725e64c0b03d7895d001a9b872443ccf7d99))

## [0.5.0](https://github.com/bitsocialnet/bitsocial-seeder/compare/v0.4.0...v0.5.0) (2026-07-10)

Docker image: `ghcr.io/bitsocialnet/bitsocial-seeder:0.5.0`

### Changes

- docs: document public seeder defaults ([ce230ee](https://github.com/bitsocialnet/bitsocial-seeder/commit/ce230eecf4e9c00cabe7228a20c8e1b21e7fd2e1))
- compose: ship memory guardrails (V8 heap cap + container mem_limit) ([3228b47](https://github.com/bitsocialnet/bitsocial-seeder/commit/3228b47a6a2c99e38943a6d79888203d07d6762e))
- Seed official Seedit directories automatically ([807ec3d](https://github.com/bitsocialnet/bitsocial-seeder/commit/807ec3da6b067df3fa8b05feb623185f8b5bc371))
- chore: release 0.5.0 ([9181770](https://github.com/bitsocialnet/bitsocial-seeder/commit/918177089978fd47072a93c371ad8f2a132fdf57))
- ci: pin npm 11 for trusted publishing ([c8ba2a1](https://github.com/bitsocialnet/bitsocial-seeder/commit/c8ba2a1231fc2be8fa09c9065d6c26324f2d22c4))

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
