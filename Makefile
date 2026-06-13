# cctop - Makefile
#
# Thin wrapper over the package.json scripts, so `make <task>` and
# `bun run <task>` are interchangeable. The actual commands live in
# package.json — edit them there.

PREFIX ?= $(HOME)/.local

.DEFAULT_GOAL := help

.PHONY: help deps update run dev build lint clean install uninstall

help: ## Show available tasks
	@grep -hE '^[a-z][a-z-]*:.*## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

deps: ## Install dependencies (bun install)
	@bun install

update: ## Update dependencies within their ranges (bun update)
	@bun update

run: ## Run the interactive TUI (make run ARGS="flux")
	@bun run start $(ARGS)

dev: ## Run with live reload (make dev ARGS="...")
	@bun run dev $(ARGS)

lint: ## Format and lint with Biome, then type-check with tsc
	@bun run lint

build: ## Compile a standalone binary into bin/
	@bun run build

clean: ## Remove build artifacts
	@bun run clean

install: ## Compile and install onto PATH (override PREFIX=...)
	@PREFIX="$(PREFIX)" bun run install:bin

uninstall: ## Remove the installed binary (override PREFIX=...)
	@PREFIX="$(PREFIX)" bun run uninstall:bin
