# Contributing To SigmaShake Public Suite

## Pick The Right Repo

`sigmashake-public-suite` is an aggregate package generated from public
component mirrors. It is not the authoritative source for service code.

Use this routing:

| Change path | PR target |
|---|---|
| `services/mmo/**` | https://github.com/sigmashakeinc/sigmashake-mmo |
| `services/abyss/**` | https://github.com/sigmashakeinc/sigmashake-abyss |
| `services/vcs/**` | https://github.com/sigmashakeinc/sigmashake-vcs |
| root docs, `scripts/**`, `config/**`, host automation | https://github.com/sigmashakeinc/sigmashake-public-suite |

Fork the component repo if your GitHub account has read-only access to the
SigmaShake org repo, then open a cross-fork PR back to the component mirror.
Maintainers import accepted component work into the private source, publish the
public component mirror, and regenerate this suite snapshot.

## Divergent History Or Existing Patches

If your work started in a repo with unrelated history, do not try to PR the
generated `services/*` copy. Re-apply the patch onto the current component
mirror instead:

```sh
git clone https://github.com/sigmashakeinc/sigmashake-mmo.git
cd sigmashake-mmo
# create a topic branch in your fork, then apply or replay your patch at repo root
```

The same pattern applies to `sigmashake-abyss` and `sigmashake-vcs`.

## Suite Verification

For suite scaffold or automation changes:

```sh
bun install
bun run bootstrap
bun run check
bun run test:19
```

The maintainer host runs the authoritative review policy, bootstrap, preflight,
and all 19 gates before merge.
