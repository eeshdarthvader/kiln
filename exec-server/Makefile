.DEFAULT_GOAL := start

IMAGE ?= localhost/factory-agent:latest
SESSION ?= factory

.PHONY: agent-image herdr start smoke test open

# The container each agent stage runs in.
agent-image:
	docker build --load -t "$(IMAGE)" .

# The Herdr session the factory drives. Runs in the foreground; attach with `herdr --session $(SESSION)`.
herdr:
	herdr --session "$(SESSION)" server

# Builds the dashboard and starts the factory server. Reads .env when present.
start:
	npm run build
	FACTORY_AGENT_IMAGE="$(IMAGE)" HERDR_SESSION="$(SESSION)" npm start

# Runs one issue through every stage on the live Herdr session with a stub agent.
smoke:
	node scripts/smoke.ts "$(SESSION)"

test:
	npm run typecheck
	npm test
	npm run format:check
	python3 -B -m unittest discover -s tests -v
	@for script in image/*.sh; do bash -n "$$script" || exit; done

open:
	python3 -m webbrowser http://localhost:3775
