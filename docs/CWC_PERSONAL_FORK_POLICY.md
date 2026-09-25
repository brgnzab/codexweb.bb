# CWC Personal fork and upstream policy

CWC Personal is maintained in `brgnzab/codexweb.bb` from the reviewed CodexWeb Council 4.1.0 baseline.

## Locked baseline

- Upstream repository: `Nolane-x/codexweb`
- Upstream release: `v4.1.0`
- Reviewed upstream commit: `440bdfda86a9dda2e909b9f2e527433c0652fff7`
- Immutable reference branch in this fork: `upstream-v4.1.0`
- CWC Personal working branch: `cwc-personal`

The `upstream-v4.1.0` branch is a historical baseline reference. It must not be advanced, rebased, force-updated, or used for product commits.

## Remote convention

For local clones used to develop CWC Personal:

- `origin` must point to `https://github.com/brgnzab/codexweb.bb.git`.
- `upstream` may point to `https://github.com/Nolane-x/codexweb.git` and is reference-only.

The original upstream repository is not an integration authority for this fork after the locked baseline.

## Upstream-change rule

Never blindly merge or pull upstream `main` into a CWC Personal branch.

Any future upstream change must be reviewed against the CWC Personal locked requirements and security boundaries first. Only specifically approved commits or changes may be brought over, using selective cherry-pick or explicit copying/reimplementation as appropriate. Dependency updates follow the same review rule and are never merged automatically.

## Licensing and attribution

The upstream MIT `LICENSE` file and attribution must remain intact. CWC Personal changes must not remove or obscure upstream license notices required by that license.
