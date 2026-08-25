# Changelog

## [0.5.1](https://github.com/Easonliuuuuu/flow-code/compare/flow-code-v0.5.0...flow-code-v0.5.1) (2026-08-25)


### Bug Fixes

* **cli:** describe a command on --help instead of running it ([855cebf](https://github.com/Easonliuuuuu/flow-code/commit/855cebfa923f9aa75ddb1a44d9550b32dfa839c7))
* **package.json:** make dist/cli.js executable so npx can run it ([6b84f36](https://github.com/Easonliuuuuu/flow-code/commit/6b84f36eed41a245daaf75ca3ccf6d5e1b1d0f26))
* **presetSetup.ts:** name the command that installs a preset's skills ([97d1766](https://github.com/Easonliuuuuu/flow-code/commit/97d1766d1979ffb8704d2f4c412b18d70074032e))
* **warp.mjs:** window the run alongside the cast ([280f6b5](https://github.com/Easonliuuuuu/flow-code/commit/280f6b51cde1f50352c35733bb048a4751572d5d))

## [0.5.0](https://github.com/Easonliuuuuu/flow-code/compare/flow-code-v0.4.0...flow-code-v0.5.0) (2026-08-24)


### ⚠ BREAKING CHANGES

* **approval-gate:** a scaffolded workflow (`flow-code init`, default or the openspec/spec-kit presets) no longer runs unattended end-to-end — there is now a blocking approval gate before Implement, in addition to the one before Git-ops. Existing checked-in workflow.yaml files are unaffected; this only changes what `init` writes from now on.

### Features

* **approval-gate:** gate the spec before implementation begins ([c21c98a](https://github.com/Easonliuuuuu/flow-code/commit/c21c98a9907cc83882c3e172df99920861890624))
* **cli:** add --version, and stop shipping a build hook that runs on install ([10c4322](https://github.com/Easonliuuuuu/flow-code/commit/10c432245c0c5f063ea408197a3130fe0809013d))
* **demo:** add flow-code try — a zero-credential first-run demo ([5430622](https://github.com/Easonliuuuuu/flow-code/commit/54306226dd9dfc3f28b2b8025fb7096094fb183d))
* generate the CLI and settings tables from source, and rewrite the docs ([c7ca218](https://github.com/Easonliuuuuu/flow-code/commit/c7ca21893f1146d6aee207ece83534b6b1c19d99))
* **init:** reuse credentials already on the machine instead of asking ([cc49c9f](https://github.com/Easonliuuuuu/flow-code/commit/cc49c9fc0395a7dc7ed4eb1c2674f2fb3aa43d6e))
* **notify:** add cross-platform desktop notifications and terminal bell ([0644aa1](https://github.com/Easonliuuuuu/flow-code/commit/0644aa162f795340b49324a2757b2a5530463b71))
* **preflight:** ask what to do about a dirty tree instead of refusing ([06769a9](https://github.com/Easonliuuuuu/flow-code/commit/06769a9cb198962d488ead436ed15114d4cc06d1))
* **presets.ts:** add a frugal preset that trades sessions, not gates ([aef43f0](https://github.com/Easonliuuuuu/flow-code/commit/aef43f0a33fbb4160623795ecadd4ca22ac99860))
* **workflow:** decide test commands and route rejections by default ([e921a56](https://github.com/Easonliuuuuu/flow-code/commit/e921a56b68d1391c73710d8fe3d406df0691737d))


### Bug Fixes

* **app.testCommands.test.ts:** wait for the seeded checkbox, not a fixed delay ([323f8b8](https://github.com/Easonliuuuuu/flow-code/commit/323f8b8f6fb594491f23e99b97ae2301e8e302c3))
* **demo.mjs:** pass repoRoot so a replay can rehydrate its graph ([34830ff](https://github.com/Easonliuuuuu/flow-code/commit/34830ff161f8472d859752bf8b9ce84c9fe6376b))
* **demo.mjs:** scrub the owner block out of a recording ([b2ea77b](https://github.com/Easonliuuuuu/flow-code/commit/b2ea77b1102d8a3e160978ae846a18003f09b64c))
* **gitignore.ts:** keep run transcripts and credentials out of a user's git ([ee5b3d4](https://github.com/Easonliuuuuu/flow-code/commit/ee5b3d446d0e99950e5b1775c6c0fea203d679dc))
* **ops.ts:** serialize worktree add and remove per repository ([22c946e](https://github.com/Easonliuuuuu/flow-code/commit/22c946e82df026ae71fce17a63b2bb65e406bf3f))
* **splash:** center the intro on the screen it owns ([5ab4e15](https://github.com/Easonliuuuuu/flow-code/commit/5ab4e15cda3fc9c64592426aef7a856deb92924a))
* **ui:** keep the key hints inside the panel frame ([cb4b33f](https://github.com/Easonliuuuuu/flow-code/commit/cb4b33f49b0be6999f260b180b8ac18bda67fb00))
* **ui:** stop loop-backs and skip-layer edges from breaking band-wrap and edge drawing ([4145eb5](https://github.com/Easonliuuuuu/flow-code/commit/4145eb58dd4ca34fa1d63f2eb9d17304beddf0c7))
* **watch:** resolve the newest run past anything that is not one ([604d3ae](https://github.com/Easonliuuuuu/flow-code/commit/604d3ae63e75ca82bc470aaf14fc865d198ccf5e))

## [0.4.0](https://github.com/Easonliuuuuu/flow-code/compare/flow-code-v0.3.0...flow-code-v0.4.0) (2026-08-20)


### ⚠ BREAKING CHANGES

* **git-ops:** a git-ops node with no `commitMessage` no longer commits the literal "flow-code: apply workflow changes". Anything matching on that string should set `commitMessage` explicitly to keep the old behaviour.
* **plan:** graph validation now requires every node holding the `git-write` capability to be dominated by an Approval-Gate — every path from every root must pass through one, not merely have one somewhere upstream. This was already a real gap (a bypass edge around an existing gate loaded and committed silently); it becomes a hard requirement here because a Plan-authored graph must not be able to opt out of it. No setting or flag disarms this. A workflow file with an ungated git-writing node will fail to load; the error names the node and the path that misses a gate. An unattended pipeline that needs to commit without a person answering a gate should leave `git-ops` out of the graph and commit from the pipeline itself after `flow-code run` exits.
* **gate:** a rejected Approval-Gate now terminates `done` with `decision: 'rejected'` rather than `error`. Workflow files need no edit — an unconditional edge out of a gate is loaded as requiring approval. Anything reading a rejection off run-state status must read the decision instead. Guest-driven runs still record `error`; the revision branch is engine-only.
* `flow-code run --resume` now requires the interrupted run to have recorded its own graph — a run written before this change has no recorded graph and can no longer be resumed (start a new run instead). `RunStateWatcherOptions.nodeIds` and `reconcileRunState` are removed.

### Features

* **App.tsx:** add a keybind to turn band-wrap off ([efc4785](https://github.com/Easonliuuuuu/flow-code/commit/efc4785db8132213d6bd7d39e2e98f2817ab4ae0))
* **cli:** summarize a run into a status bar with flow-code status ([064181b](https://github.com/Easonliuuuuu/flow-code/commit/064181b70d3b549cb36290d003492f6b650d3e25))
* **connect:** install a status row into the host's own status line ([395e9f9](https://github.com/Easonliuuuuu/flow-code/commit/395e9f9f926a1bb6479c30a6bdd076ec4689fb10))
* **discuss:** animate the thinking wait and let the agent offer tappable options ([6777741](https://github.com/Easonliuuuuu/flow-code/commit/6777741c434cb382058f1fdaffa0819f2d38b0b7))
* **gate:** route a rejected gate to a revision branch ([b381bb3](https://github.com/Easonliuuuuu/flow-code/commit/b381bb33e1b7b686ea07e13a527169bdd333d6cf))
* **git-ops:** write the commit message from the diff ([2c33ba9](https://github.com/Easonliuuuuu/flow-code/commit/2c33ba9edb00d1853758e879fc35aec1ed36208a))
* **guest:** ask the repository whether a run's claims are true ([7dfc437](https://github.com/Easonliuuuuu/flow-code/commit/7dfc4374e2f2a93583c14d47203f626b3381ae55))
* **guest:** enforce a node's capability envelope inside a host session ([2e80d6c](https://github.com/Easonliuuuuu/flow-code/commit/2e80d6c56daa841e65a2f36801c77e5cad478112))
* **guest:** let an outside agent drive the graph and report it ([8e14cb6](https://github.com/Easonliuuuuu/flow-code/commit/8e14cb6ffe36823487a5bc5f186d0ef605cd0efe))
* **plan:** add a Plan node that negotiates the graph before it runs ([418d133](https://github.com/Easonliuuuuu/flow-code/commit/418d1330d42d29d89ac09557245fcd6eea441a2f))
* read the recorded graph in watch/resume, and add named graphs ([268448b](https://github.com/Easonliuuuuu/flow-code/commit/268448b5a52350be9940afdeb9c813530c483fe1))
* **runstate:** enforce run-document ownership and stop guessing at liveness ([08cb789](https://github.com/Easonliuuuuu/flow-code/commit/08cb789677cedadf2873374a49e1416385c111dc))
* **status:** fail when an archived change serves no requirement ([210ff2c](https://github.com/Easonliuuuuu/flow-code/commit/210ff2c0ce924fd15c479ac83e5a2e1ae4b14ec6))
* **ui:** add a key map, and settle the keys and header it advertises ([3ed5f46](https://github.com/Easonliuuuuu/flow-code/commit/3ed5f4658136308734d5d4bddc2d4d0c15deac82))
* **ui:** extend band-wrap to full density too ([07b826f](https://github.com/Easonliuuuuu/flow-code/commit/07b826f1fda38bf7c588dd455947d3a3ee253a10))
* **ui:** replace drawn loop-back edges with badges on the cards ([a672a9f](https://github.com/Easonliuuuuu/flow-code/commit/a672a9f88f8b5aed57b7fb8fee07a5f4a466a349))
* **ui:** wrap compact-density graphs into bands, not off-screen ([5c35e6f](https://github.com/Easonliuuuuu/flow-code/commit/5c35e6fde89f29adda82bdaa8190d02e6e996d9b))


### Bug Fixes

* **App.tsx:** give floating panels an opaque backdrop ([b21d828](https://github.com/Easonliuuuuu/flow-code/commit/b21d82827171e091af22fbf74658fc9639858535))
* **App.tsx:** keep the elapsed-time ticker running while a node waits ([66f7183](https://github.com/Easonliuuuuu/flow-code/commit/66f718331e4fd0ac1ac4e61605cbcd58ff84bec2))
* **App.tsx:** scope the approval-gate panel to the focused node ([afe3ca0](https://github.com/Easonliuuuuu/flow-code/commit/afe3ca06f9f420e8f1e509af23b5381f889f0f18))
* **canvas.ts:** space the retry badge like the loop mark above it ([16e60ae](https://github.com/Easonliuuuuu/flow-code/commit/16e60ae3616fe1cafefd6e9f2c1406abdc2c8be3))
* **canvas:** mark crossings instead of breaking wrap lanes under loop-backs ([04e1985](https://github.com/Easonliuuuuu/flow-code/commit/04e198526d5ce010fd1af0dbbcb29498107f584f))
* **discuss.ts:** require valid JSON in tappable option strings ([ff5a0cf](https://github.com/Easonliuuuuu/flow-code/commit/ff5a0cfd014593723ec204633c6286c450260c6c))
* **discuss:** parse every options block, not just a trailing one ([484813e](https://github.com/Easonliuuuuu/flow-code/commit/484813e6f140c161c2da64930c5e31cac40dc3b8))
* **guest:** unblock commit messages, gate questions, and review context ([1e69608](https://github.com/Easonliuuuuu/flow-code/commit/1e696082175f5190ade4bae435b18a948e8e13a6))
* **guest:** unblock the reporting tools, subagents, and node output ([6109acd](https://github.com/Easonliuuuuu/flow-code/commit/6109acdde643d4a6ad034a9a759887a01dc559fc))
* **index.ts:** mount the app on the alternate screen after splash handoff ([bde3731](https://github.com/Easonliuuuuu/flow-code/commit/bde3731709d5761b333922d48ca29a459b338495))
* **layout:** back off to a legal cut instead of abandoning wrapping ([e86a606](https://github.com/Easonliuuuuu/flow-code/commit/e86a606b743875cd483a241f650954971220c30b))
* **make-testbed.sh:** seed a run so watch has a graph to draw ([ec1646c](https://github.com/Easonliuuuuu/flow-code/commit/ec1646c25fc857aa8a090539c3a5eb9c50fd3bea))
* **nodeCard.ts:** show a readable breakdown instead of raw JSON ([d36221f](https://github.com/Easonliuuuuu/flow-code/commit/d36221f7a78ec8d3a8f98a53b1eaf653581a2f74))
* **status.ts:** drop the jq dependency and the meter on an absent run ([28e2070](https://github.com/Easonliuuuuu/flow-code/commit/28e20707b7534b8763077cc84f3a999093c936c4))
* **status:** map the connect scope to session-status-line ([e299b9b](https://github.com/Easonliuuuuu/flow-code/commit/e299b9b0dcba347763ad9e256fb6e7b5008b6f68))
* **status:** register the plan scope and agent-generated-graphs change ([17e92cc](https://github.com/Easonliuuuuu/flow-code/commit/17e92ccd83edc2c33c3593dd81cea6a77a0341e8))
* **ui:** name the loop that fired instead of leaving it to colour alone ([f3bb063](https://github.com/Easonliuuuuu/flow-code/commit/f3bb0630215b229135d931f8bd8be244ac96de58))
* **ui:** show how to end a discussion where the user is typing ([bf171dc](https://github.com/Easonliuuuuu/flow-code/commit/bf171dc0cfd0cbfa7d1931fc7d847932c118d162))


### Performance Improvements

* **cli.ts:** load only the subcommand being run ([07e8730](https://github.com/Easonliuuuuu/flow-code/commit/07e8730f81af26cec460a918d078d04b1c4fc2d6))

## [0.3.0](https://github.com/Easonliuuuuu/flow-code/compare/flow-code-v0.2.0...flow-code-v0.3.0) (2026-08-10)


### ⚠ BREAKING CHANGES

* **cli:** the NVIDIA provider is gone. NVIDIA_API_KEY is no longer consulted, and a project whose .flow-code/credentials.json records provider: "nvidia" now fails validation and falls back to an environment key or CLI login — re-run `flow-code init` to pick a supported provider.

### Features

* **cli:** add `flow-code runs` and a `-r` shorthand for `--resume` ([97499a4](https://github.com/Easonliuuuuu/flow-code/commit/97499a44d5573aef83b5306e7a41665d7b2d031e))
* **cli:** split cli.ts into command modules and drop the NVIDIA provider ([6be24f0](https://github.com/Easonliuuuuu/flow-code/commit/6be24f0b92e11e770819b0363fec793d95e8caf4))
* **splash:** fail/retry chain animation with fireworks ([4061c09](https://github.com/Easonliuuuuu/flow-code/commit/4061c090dcfc19c9f300fb86bddfa539e4112e1c))
* **splash:** tighten pacing, reveal logo line-by-line, add --no-splash ([3d6b38b](https://github.com/Easonliuuuuu/flow-code/commit/3d6b38b81709f4ed47e680392dfc21a80b4fe569))
* **testbed:** add ui/splash/clean modes ([91c2517](https://github.com/Easonliuuuuu/flow-code/commit/91c2517a17f52da02a70ff1ea2201ed46c7ac8c5))
* **workflow:** check a workflow without running it, and record the graph a run executes ([0321894](https://github.com/Easonliuuuuu/flow-code/commit/0321894a6ba9f90b6d927ca5bc1fa9417bac3c7c))


### Bug Fixes

* **App.tsx:** show node config as labeled fields instead of raw JSON ([f8c1dbc](https://github.com/Easonliuuuuu/flow-code/commit/f8c1dbc47ba34576352767facb6f1b4c9bc9512b))
* **demo.mjs:** wait for a live run instead of recording a finished one ([74ae947](https://github.com/Easonliuuuuu/flow-code/commit/74ae94791de7758e7cc920a30a04a8bcb11e0277))
* **runstate:** stop counting cached tokens against a budget ([d2423bb](https://github.com/Easonliuuuuu/flow-code/commit/d2423bbf9caeec7785cadb606944ff6660e9eb7f))
* **sdkRunner.ts:** isolate Claude nodes from the operator's global settings ([db04583](https://github.com/Easonliuuuuu/flow-code/commit/db04583cd69c1a812c3171b8b28d27e62ff5b815))
* **status:** block on shallow clones, and map the six scopes CI found ([dbdd041](https://github.com/Easonliuuuuu/flow-code/commit/dbdd0417e3081ff4b0c7e494dca1bcc0ae7c5c23))
* **store.ts:** clear a status detail when the status changes ([7fbe8f8](https://github.com/Easonliuuuuu/flow-code/commit/7fbe8f8d24df16676ff42028a1ecb53596902254))
* **test:** stop racing a fixed-delay settle in the discovery-failure case ([7acff54](https://github.com/Easonliuuuuu/flow-code/commit/7acff549a996efc7799dd9dce3d0e042075e3bed))
* **textwrap:** measure display columns instead of string length ([03fc23c](https://github.com/Easonliuuuuu/flow-code/commit/03fc23c18e44f87d6b1092c2603729c7ed6e88c0))
* **ui:** keep raw mode on across the splash-&gt;graph handoff ([52368d9](https://github.com/Easonliuuuuu/flow-code/commit/52368d92e3087fd6fc467525e8077ae2ecb3fe5d))
* **ui:** stop watch/run exiting or crashing before the graph is interactive ([44a7e23](https://github.com/Easonliuuuuu/flow-code/commit/44a7e23e3716f02da714fc5f8c903c3716126732))

## [0.2.0](https://github.com/Easonliuuuuu/flow-code/compare/flow-code-v0.1.0...flow-code-v0.2.0) (2026-08-07)


### Features

* **App.tsx:** replay approval-gate diffs after the decision ([d61f2b5](https://github.com/Easonliuuuuu/flow-code/commit/d61f2b567a6b3ffb8dc59b678ce958c12eef1403))
* **canvas:** add a Focus/Overview view-mode toggle ([cf7605f](https://github.com/Easonliuuuuu/flow-code/commit/cf7605f15a1007649295b6ec211d20e89e85b1bb))
* **canvas:** badge nodes with attached skills ([253f002](https://github.com/Easonliuuuuu/flow-code/commit/253f0021a033466ee1f0b3e0a6ecbe4ad2343ec3))
* **canvas:** draw loop-back edges and badge nodes that have been re-run ([45875de](https://github.com/Easonliuuuuu/flow-code/commit/45875de9b5b5eb925b4dbd54345612116a7aa04b))
* **canvas:** let users attach skills to nodes from the run UI ([f2a9bb7](https://github.com/Easonliuuuuu/flow-code/commit/f2a9bb7f04d01c24cae69e637cbfb34b35811cc7))
* **canvas:** make node boxes live cards with tokens, spinner, and a real subtitle ([6ad5854](https://github.com/Easonliuuuuu/flow-code/commit/6ad5854bbd07f7508073088ac007ba10a83de078))
* **canvas:** make panning work everywhere and say what's off-screen ([d9ea3ed](https://github.com/Easonliuuuuu/flow-code/commit/d9ea3ed2f83e74d4405b9b2949426ca1a5253f88))
* **canvas:** size node cards to their text and collapse them when crowded ([6e2d413](https://github.com/Easonliuuuuu/flow-code/commit/6e2d41365466d76981664813ae53d8fde6ccda14))
* **cli.ts:** wire CompositeSessionRunner into the run command ([704c096](https://github.com/Easonliuuuuu/flow-code/commit/704c096d329ad309ad5ffe827dd8cdaaf40f20ce))
* **cli:** pick a starting preset interactively on a fresh init ([9151ce0](https://github.com/Easonliuuuuu/flow-code/commit/9151ce095ec095aa68e867c5816c706e5f28d482))
* **cli:** prompt for NVIDIA credentials on first run ([7f41ef5](https://github.com/Easonliuuuuu/flow-code/commit/7f41ef5a586dbbbe6fdedfb522a1b7e26f7f447a))
* **cli:** resolve the test command on first run, not at init ([b4ff852](https://github.com/Easonliuuuuu/flow-code/commit/b4ff85281b865241cb71e4f4d1f5e0c2a8f3931d))
* **discuss:** support NVIDIA, OpenAI, and OpenRouter as Discuss providers ([686a26f](https://github.com/Easonliuuuuu/flow-code/commit/686a26fd04f3835767cd8dfda4b8a165c8c1b6e1))
* **engine:** anchor the control directory, budget the run, and make the graph route ([78bcbd5](https://github.com/Easonliuuuuu/flow-code/commit/78bcbd590193a080ee8663bb954ec0aaf630a8b6))
* **engine:** fail nodes on their own verdict, keep context past gates, run loops ([eba1ae1](https://github.com/Easonliuuuuu/flow-code/commit/eba1ae1d1e4f5bcda2df73c6a3e6a93ae281d2fe))
* **engine:** give nodes their own token budget, editable from the canvas ([d4e84c0](https://github.com/Easonliuuuuu/flow-code/commit/d4e84c05e8be37875baca5e4781e42ac6d37e5b3))
* **executors:** add NVIDIA-backed SessionRunner and composite routing ([1e8443b](https://github.com/Easonliuuuuu/flow-code/commit/1e8443b4d429836d4888ac51c8ffca0c7b1c27cd))
* **harness:** add NVIDIA tool schemas and capability checker ([7dd6d35](https://github.com/Easonliuuuuu/flow-code/commit/7dd6d351d1a92ffb2cdca6fcf5052da266097f68))
* **harness:** let node agents delegate to subagents, bounded by the node ([c1c8814](https://github.com/Easonliuuuuu/flow-code/commit/c1c881472fc2ae053967fce41a4a34cbac5870c0))
* **init:** add project-wide provider/model picker to init ([795c73f](https://github.com/Easonliuuuuu/flow-code/commit/795c73f96a4b69993fa84442f5c446094523c33d))
* interrupt runs cleanly on ctrl+c; wrap discuss replies ([b6bdfac](https://github.com/Easonliuuuuu/flow-code/commit/b6bdfac5eedbb49efa1e2cd72764a751e6322a20))
* **nvidia-integration.yml:** land NVIDIA-keyed integration tests on main ([a1effd0](https://github.com/Easonliuuuuu/flow-code/commit/a1effd013f1da4ccf7ae32e8dbe86d0746e5ef16))
* **preflight:** require NVIDIA_API_KEY for NVIDIA-routed workflows ([181c68f](https://github.com/Easonliuuuuu/flow-code/commit/181c68f61c998cc4a7772e4b280ce8d92a4aeed0))
* **presets:** add a spec-kit preset alongside openspec ([ac1ce13](https://github.com/Easonliuuuuu/flow-code/commit/ac1ce1305df30bf9a46778739b351bb16331f641))
* **presets:** offer to install a preset's missing CLI during init ([29e7621](https://github.com/Easonliuuuuu/flow-code/commit/29e7621e9931d83d829ea8fe93379519ad7b4e62))
* **presets:** offer to scaffold a preset's missing skills during init ([ef94e01](https://github.com/Easonliuuuuu/flow-code/commit/ef94e01559e019e7a0126bc54bc22aac9c0c6b52))
* **providers:** add a codex provider for OpenAI subscription auth ([f28f540](https://github.com/Easonliuuuuu/flow-code/commit/f28f540e996ad02d63ceb134341d93c1085364bf))
* **registry:** attach skills to nodes, declare interactivity, and find the test command ([3e1d036](https://github.com/Easonliuuuuu/flow-code/commit/3e1d036e9f74836ef635533c8ab08148222ee367))
* **registry:** let Test and Approval-Gate opt into an optional agent step ([b06f4a1](https://github.com/Easonliuuuuu/flow-code/commit/b06f4a1b972a1ec74b15e6f0f8f23d76d95eacea))
* **runstate:** resume an interrupted run, including a Discuss conversation ([0047a0b](https://github.com/Easonliuuuuu/flow-code/commit/0047a0bf908eed945f8cd9b468ade071ece336ba))
* **schema:** add bounded loop-back edges and per-node attempt tracking ([1f2423e](https://github.com/Easonliuuuuu/flow-code/commit/1f2423ebec56132747d046e6688c6da715c0255a))
* **test:** ask what to run inside the run, once the discussion has happened ([3ab9c85](https://github.com/Easonliuuuuu/flow-code/commit/3ab9c8551345166849e3c308f361ebf2745a7d24))
* **ui:** add a per-node model picker to the run UI ([aa112e2](https://github.com/Easonliuuuuu/flow-code/commit/aa112e2b5b8099ccfe0efe02f1b758339ee89ba3))
* **ui:** add an animated startup splash to run/watch ([7bbd1f0](https://github.com/Easonliuuuuu/flow-code/commit/7bbd1f0335e0c58a018ee0b6b0e6db958af034fc))
* **ui:** add ctrl+wheel zoom and fix runaway node dragging ([9f7613f](https://github.com/Easonliuuuuu/flow-code/commit/9f7613f40cce82b34e718c1dd6d9cdbe64c8f080))
* **ui:** make the Discuss panel scrollable, resizable, and movable ([d8c8a30](https://github.com/Easonliuuuuu/flow-code/commit/d8c8a30fca493b5c5eaea3b82d80efb32a975e23))
* **watch:** add a read-only viewer for a run driven in another window ([4c8a668](https://github.com/Easonliuuuuu/flow-code/commit/4c8a6681cb7903632e34859909bcbc7a7fc65c74))


### Bug Fixes

* **App.tsx:** cap prose wrap width in docked panels ([4b9fd3e](https://github.com/Easonliuuuuu/flow-code/commit/4b9fd3e38db6b4713ea3a3dbd7a6efc612bc9c8f))
* **App.tsx:** keep the header and hint line to one row each ([94657ec](https://github.com/Easonliuuuuu/flow-code/commit/94657ec6b124ef75e63b3c01fa2bb89bbfcb41ff))
* **App.tsx:** make node-panel and diff scrolling consistent with Discuss ([f2a97ac](https://github.com/Easonliuuuuu/flow-code/commit/f2a97ac0e60ac624220c06e3db66b7f5b55e872e))
* **App.tsx:** stop docked panels from re-densifying the node graph ([d3d91e6](https://github.com/Easonliuuuuu/flow-code/commit/d3d91e65236d97544687e149ec77f6b99287c5e8))
* **budget:** remove default per-node token cap from scaffolded workflows ([68267b4](https://github.com/Easonliuuuuu/flow-code/commit/68267b452e190062f776774eaeb7e9aa8f2bcddf))
* **canvas:** let tab/click step away from an active discussion ([030aeda](https://github.com/Easonliuuuuu/flow-code/commit/030aedad74f8731337c24bc51a8e01fd388ee4d3))
* **cli.ts:** resolve symlinked bin path so the CLI actually runs ([5a1f633](https://github.com/Easonliuuuuu/flow-code/commit/5a1f633f30fdee504a1279521992b59ec5b30fe5))
* **cli:** offer to overwrite workflow.yaml on an explicit --preset ([25a54c7](https://github.com/Easonliuuuuu/flow-code/commit/25a54c7fab55844d32252f126d8828cce2411dd5))
* **discuss:** render the discussion transcript from the top, not the bottom ([871e1f7](https://github.com/Easonliuuuuu/flow-code/commit/871e1f7e3ddc282fd19157906c7ca1100d483e12))
* **executors:** rotate NVIDIA keys and add a per-request timeout ([183bdd5](https://github.com/Easonliuuuuu/flow-code/commit/183bdd5f43486774f70245f2c38a826d3a61db23))
* **init:** stop racing readline/raw-stdin against Ink for wizard prompts ([7c06a21](https://github.com/Easonliuuuuu/flow-code/commit/7c06a21582b7e2eb330f1fd566fb01e73395357d))
* **layout.ts:** shrink node cards in compact zoom, not just full height ([a649800](https://github.com/Easonliuuuuu/flow-code/commit/a649800f0ba8e67ff4ddd7cd9a02577abfa7dcd3))
* **openaiCompatClient.ts:** retry rate limits, fix flaky NVIDIA tests ([bfa4d36](https://github.com/Easonliuuuuu/flow-code/commit/bfa4d3626d3a6071c32c5ce1107be0f802b96728))
* **ops.ts:** don't strip committed workflow.yaml from approval diffs ([8f940dd](https://github.com/Easonliuuuuu/flow-code/commit/8f940dd2583064a52860ba1d94c16a166de77646))
* **panel:** grow the docked panel's default height from 45% to 60% ([933c227](https://github.com/Easonliuuuuu/flow-code/commit/933c2275a23c8e6407041b2defec402d8846301c))
* render markdown in Discuss, wrap output, and loop back on failure ([cfa77de](https://github.com/Easonliuuuuu/flow-code/commit/cfa77de4a9313704f0f8061932e523fac1fdc0bf))
* **splash:** skip on no TTY, and cover it with tests ([0f52832](https://github.com/Easonliuuuuu/flow-code/commit/0f528329f837ba34ac1789c68686a6f7fe83b4a6))
* **ui:** make Discuss messages render and the panel actually resizable ([2029d3f](https://github.com/Easonliuuuuu/flow-code/commit/2029d3ff19f69d9e7425476b503f30bc1e7bedf4))
* **ui:** stop mouse events from leaking into keyboard input, support wheel scroll ([ad9c016](https://github.com/Easonliuuuuu/flow-code/commit/ad9c016c1c969965a97b482587fbb0131ff2120a))
