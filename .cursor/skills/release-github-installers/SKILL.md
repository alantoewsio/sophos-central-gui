---
name: release-github-installers
description: >-
  Runs Bandit static analysis on the repo; if clean, bumps the patch (or user-specified)
  version in pyproject.toml and Windows Inno metadata, commits, pushes to origin, and
  pushes an annotated vX.Y.Z tag so GitHub Actions builds installers. Use when the user
  asks to release, publish to GitHub, ship installers, cut a version, or run a Bandit-gated
  release workflow.
---

# Release to GitHub (Bandit → version bump → tag → installer CI)

## Preconditions

- Repository root as cwd; `origin` remote is the GitHub repo.
- Permission to push the current branch and tags (`gh auth status` or SSH).

## 1. Bandit gate (required)

Install dev tools, then run Bandit with **`pyproject.toml`** as the config file (loads **`[tool.bandit]`** skips and **`exclude_dirs`**).

```bash
uv sync --extra dev
uv run bandit -r . -c pyproject.toml -ll
```

**Ephemeral Bandit (no dev sync):**

```bash
uvx bandit -r . -c pyproject.toml -ll
```

- **Exit non-zero or any reported issues:** Stop. Summarize findings. Do **not** bump version, commit release, push, or tag.
- **Exit zero and no issues at severity ≥ low (`-ll`):** Continue.

**Policy:** `[tool.bandit]` skips **B608** (SQL built from validated / allowlisted fragments; user values use `?` bindings). Do not remove that skip in this workflow without explicit user direction.

## 2. Version bump

1. Read `version` in `pyproject.toml` (PEP 440, e.g. `0.1.0`).
2. Increment **patch** by default (`0.1.0` → `0.1.1`). If the user asked for **minor** or **major**, bump that segment and zero the lower segments (e.g. minor: `0.1.3` → `0.2.0`).
3. Update **`pyproject.toml`** `project.version` to the new value (no `v` prefix).
4. Update **`packaging/windows/SophosCentralGUI.iss`** `#define MyAppVersion "…"` to the **same** string.
5. Run **`uv lock`** so `uv.lock` stays consistent with the project.

## 3. Commit release metadata

Stage and commit only the version-related files:

- `pyproject.toml`
- `uv.lock`
- `packaging/windows/SophosCentralGUI.iss`

Commit message:

```text
chore: release vX.Y.Z
```

(use the new version with a `v` prefix in the subject).

## 4. Push branch and tag (triggers installers)

1. Push the release commit: `git push origin <current-branch>` (usually `main`).
2. Create an **annotated** tag: `git tag -a vX.Y.Z -m "Release vX.Y.Z"`.
3. Push the tag: `git push origin vX.Y.Z`.

Pushing tag `v*` triggers **Build installers** (same as **workflow_dispatch**).

**Publishing a GitHub Release** (changing a draft to **Published**, or `gh release create` without `--draft`) also triggers **Build installers** via `release: types: [published]`.

## 5. Optional: GitHub Release UI

If `gh` is available and the user wants a release page (installers download from **Actions → workflow run → Artifacts** unless another workflow uploads them):

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes
```

Use `--draft` first if installers should run only after the release is **published** (draft releases do not trigger the workflow). Omit `--draft` to publish immediately and trigger the build.

**Before the first release:** `.github/workflows/build-installers.yml` and the app sources it needs must already be on the default branch; otherwise tag-only commits will not contain the workflow.

## Failure handling

- Do not tag or push if Bandit failed or reported issues.
- If the branch is protected or push fails, report the error; do not suggest bypassing policy unless the user explicitly asks.

## Reference

- Installer workflow: `.github/workflows/build-installers.yml` (`workflow_dispatch`, `push` tags `v*`, `release` **published**).
- Bandit config: `pyproject.toml` **`[tool.bandit]`** (must pass **`-c pyproject.toml`** so skips and excludes apply).
- Windows installer version: keep **`packaging/windows/SophosCentralGUI.iss`** aligned with **`project.version`**.
