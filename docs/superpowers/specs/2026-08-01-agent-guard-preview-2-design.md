# Agent Guard Preview 2 Design

## Goal

Publish `@itharbors/kit-agent-guard@0.1.0-preview.2` with every runtime-required file inside the immutable `.hkit`, so the installed startup plugin loads successfully in the desktop host.

## Root cause

`agent-guard-background` reads `resources/policy-v1.json` from the Kit root. The Kit packer includes manifests, declared window entries, plugin distribution directories, declared plugin public assets, and production dependencies; it does not implicitly include arbitrary Kit-root directories. Consequently `0.1.0-preview.1` installs successfully but fails runtime activation because the policy file is absent.

## Packaging design

The policy belongs to the background plugin that consumes it. Move it to `plugins/agent-guard-background/resources/policy-v1.json`, declare `resources` in that plugin's `ce-editor.assets.public` list, and resolve it from the compiled `main/dist` entry using the plugin-local relative path. Do not broaden the Kit archive contract to include arbitrary root files.

This keeps ownership explicit, uses the packer's existing public-asset mechanism, and ensures the policy is covered by archive checksums and the SBOM.

## Versioning and publication

Update Agent Guard's Kit manifest, package manifest, and root lockfile identity from `0.1.0-preview.1` to `0.1.0-preview.2`. The existing Preview 1 Release remains unchanged.

After the Kit PR is reviewed and merged into `main`, release only from a clean local `main` exactly matching `origin/main`. Push the exact `kit/agent-guard/v0.1.0-preview.2` Tag through the repository release script after presenting and receiving approval for its generated confirmation token. GitHub Actions must then create the immutable Release and refresh the Registry.

## Validation

Add a regression assertion against the real packed artifact: the `.hkit` must contain `plugins/agent-guard-background/resources/policy-v1.json` and its checksum entry. Existing policy, runtime integration, privacy, and performance tests must continue to consume the same policy content.

Run the focused Agent Guard tests, the targeted `kit:check`, archive inspection, and the Kit workflow finish gate. After publication, verify the Tag, immutable Release assets, successful publish job, updated Registry entry, and a clean desktop install/activation of Preview 2.

## Boundaries

- Do not mutate or replace the immutable Preview 1 Release.
- Do not add implicit recursive Kit-root packaging.
- Do not mix the client error-display work into the Agent Guard Kit PR.
- Do not publish from the change branch; publication waits for the merged `main` commit.
