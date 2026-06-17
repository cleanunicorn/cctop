# cctop - Makefile
#
# Thin wrapper over the package.json scripts: each task runs the script of the
# same name, so `make <task>` and `bun run <task>` are interchangeable. The
# actual commands live in package.json — edit them there. The one exception is
# `prep-release`, Make-only release tooling. (`install-bin` is named to match its
# script — a script plainly named `install` would fire on `bun install`.)

# Exported so `make install-bin PREFIX=/usr/local` reaches the install-bin script.
export PREFIX
VERSION ?= patch

.DEFAULT_GOAL := help

.PHONY: help start dev test build lint clean install-bin uninstall-bin prep-release

help: ## Show available tasks
	@grep -hE '^[a-z][a-z-]*:.*## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

start: ## Run the interactive TUI (make start ARGS="flux")
	@bun run start $(ARGS)

dev: ## Run with live reload (make dev ARGS="...")
	@bun run dev $(ARGS)

test: ## Run tests
	@bun run test

lint: ## Format and lint with Biome, then type-check with tsc
	@bun run lint

build: ## Compile a standalone binary into bin/
	@bun run build

clean: ## Remove build artifacts
	@bun run clean

install-bin: ## Compile and install onto PATH (override PREFIX=...)
	@bun run install-bin

uninstall-bin: ## Remove the installed binary (override PREFIX=...)
	@bun run uninstall-bin

prep-release: ## Bump the version (VERSION=patch|minor|major|x.y.z) in package.json + README and open a release PR
	@command -v gh >/dev/null 2>&1 || { echo "error: gh CLI is required"; exit 1; }
	@test -z "$$(git status --porcelain)" || { echo "error: working tree is dirty; commit or stash first"; exit 1; }
	@git fetch --quiet origin main
	@git switch --quiet main && git merge --quiet --ff-only origin/main
	@bun pm version "$(VERSION)" --no-git-tag-version >/dev/null
	@new="$$(bun pm pkg get version | tr -d '\"')"; \
		branch="release-v$$new"; \
		git switch --quiet -c "$$branch"; \
		sed -i.bak -E "s|cctop#v[0-9A-Za-z.+-]+|cctop#v$$new|g" README.md && rm -f README.md.bak; \
		git commit --quiet -m "release: v$$new" package.json README.md; \
		git push --quiet -u origin "$$branch"; \
		gh pr create --base main --head "$$branch" \
			--title "release: v$$new" \
			--body "Prepare for release \`v$$new\`"
