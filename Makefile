PREFIX ?= $(HOME)/.local/bin

.PHONY: install-local test

install-local:
	mkdir -p "$(PREFIX)"
	cp bin/codex-resets.js "$(PREFIX)/codex-resets"
	chmod +x "$(PREFIX)/codex-resets"

test:
	node --test
