# Releasing

Every change intended for publication should include a Changeset. Run `yarn changeset` in your branch and commit the generated file with the change.

When changesets reach `main`, GitHub Actions opens or updates a **Version Packages** pull request. Merging that pull request publishes the package to npm and deploys the latest docs.

## One-time setup

1. In the npm package settings, add a **Trusted Publisher** for GitHub Actions:
   - Owner: `axetroy`
   - Repository: `lograil`
   - Workflow file: `.github/workflows/release.yml`
   - Environment: `npm`
2. In GitHub Actions settings, allow workflows to create pull requests.

Publishing uses npm's OIDC trusted publishing. Do not add an `NPM_TOKEN` secret.
