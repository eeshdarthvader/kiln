.DEFAULT_GOAL := agent-image

IMAGE ?= localhost/factory-agent:latest
SESSION ?= factory

.PHONY: agent-image herdr test

# The container each agent stage runs in.
agent-image:
	docker build --load -t "$(IMAGE)" .

# The Herdr session the factory drives. Runs in the foreground; attach with `herdr --session $(SESSION)`.
herdr:
	herdr --session "$(SESSION)" server

test:
	npm run typecheck
	npm test
	npm run format:check
	python3 -B -m unittest discover -s tests -v
	@for script in image/*.sh; do bash -n "$$script" || exit; done
